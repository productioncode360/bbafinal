require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(cors());
app.use(express.static('public'));
// solve route
app.get('/solve', (req, res) => {
  res.sendFile(__dirname + '/public/solve.html');
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/* ─────────────────────────────────────────
   MongoDB Connect
───────────────────────────────────────── */
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch(err => console.error('❌ MongoDB error:', err.message));

/* ─────────────────────────────────────────
   Schemas & Models
───────────────────────────────────────── */
const QuestionSchema = new mongoose.Schema({
  id: { type: String, required: true },   // frontend wala id (q123...)
  text: { type: String, required: true },
  ans: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now }
});

const SubjectSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  questions: [QuestionSchema],
  createdAt: { type: Date, default: Date.now }
});

const Subject = mongoose.model('Subject', SubjectSchema);

/* ─────────────────────────────────────────
   DB ROUTES
───────────────────────────────────────── */

// Saare subjects + unke questions fetch karo
app.get('/api/subjects', async (req, res) => {
  try {
    const subjects = await Subject.find().sort({ createdAt: 1 });
    res.json({ success: true, subjects });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Naya subject banao
app.post('/api/subjects', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ success: false, error: 'name required' });
    const existing = await Subject.findOne({ name });
    if (existing) return res.status(400).json({ success: false, error: 'Already exists' });
    const subject = await Subject.create({ name, questions: [] });
    res.json({ success: true, subject });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Subject delete karo
app.delete('/api/subjects/:name', async (req, res) => {
  try {
    await Subject.deleteOne({ name: req.params.name });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Subject mein questions add karo (bulk)
app.post('/api/subjects/:name/questions', async (req, res) => {
  try {
    const { questions } = req.body; // [{id, text}]
    if (!questions || !questions.length) return res.status(400).json({ success: false, error: 'questions required' });

    const subject = await Subject.findOne({ name: req.params.name });
    if (!subject) return res.status(404).json({ success: false, error: 'Subject not found' });

    let added = 0;
    for (const q of questions) {
      const exists = subject.questions.some(eq => eq.id === q.id || eq.text === q.text);
      if (!exists) {
        subject.questions.push({ id: q.id, text: q.text, ans: q.ans || '' });
        added++;
      }
    }
    await subject.save();
    res.json({ success: true, added, total: subject.questions.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Question ka answer save karo
app.put('/api/subjects/:name/questions/:qid', async (req, res) => {
  try {
    const { ans } = req.body;
    const subject = await Subject.findOne({ name: req.params.name });
    if (!subject) return res.status(404).json({ success: false, error: 'Subject not found' });

    const q = subject.questions.find(q => q.id === req.params.qid);
    if (!q) return res.status(404).json({ success: false, error: 'Question not found' });

    q.ans = ans;
    await subject.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ─────────────────────────────────────────
   /api/scan-pdf
   Image se questions extract karne ke liye
───────────────────────────────────────── */
app.post('/api/scan-pdf', async (req, res) => {
  try {
    const { fileName, fileData, prompt } = req.body;
    console.log(`📎 scan-pdf: ${fileName}`);

    const model = genAI.getGenerativeModel({ model: process.env.GEMINI_NAME });

    const parts = fileData.split(',');
    const mimeMatch = parts[0].match(/data:([^;]+);base64/);
    const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
    const b64data = parts[1];

    const result = await model.generateContent([
      prompt,
      { inlineData: { data: b64data, mimeType } }
    ]);

    const analysis = result.response.text();
    console.log(`✅ scan-pdf done: ${fileName}`);
    res.json({ success: true, analysis });

  } catch (err) {
    console.error('❌ scan-pdf error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ─────────────────────────────────────────
   /api/chat
   Question ka answer generate karne ke liye
───────────────────────────────────────── */
app.post('/api/chat', async (req, res) => {
  try {
    const { messages } = req.body;
    if (!messages || !messages.length) {
      return res.status(400).json({ success: false, error: 'messages required' });
    }

    const model = genAI.getGenerativeModel({ model: process.env.GEMINI_NAME });

    const history = messages.slice(0, -1).map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));

    const chat = model.startChat({ history });
    const lastMsg = messages[messages.length - 1];
    const result = await chat.sendMessage(lastMsg.content);
    const reply = result.response.text();
    const usage = result.response.usageMetadata || {};

    res.json({
      success: true,
      reply,
      tokens: {
        sent: usage.promptTokenCount || 0,
        recv: usage.candidatesTokenCount || 0
      }
    });

  } catch (err) {
    console.error('❌ chat error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ─────────────────────────────────────────
   Start
───────────────────────────────────────── */
const PORT = process.env.PORT || 5005;
app.listen(PORT, () => {
  console.log(`🚀 Server ready → http://localhost:${PORT}`);
  console.log(`📦 Model: ${process.env.GEMINI_NAME}`);
});