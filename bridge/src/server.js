import express from 'express';
import { pair, getStatus, sendMessage, sendReaction, logout } from './sessions/manager.js';

const PORT = process.env.PORT || 4001;
const BRIDGE_SHARED_SECRET = process.env.BRIDGE_SHARED_SECRET;

if (!BRIDGE_SHARED_SECRET) {
  console.error('BRIDGE_SHARED_SECRET is required');
  process.exit(1);
}

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  const auth = req.headers.authorization;
  if (auth !== `Bearer ${BRIDGE_SHARED_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

app.post('/sessions/:accountId/pair', async (req, res) => {
  try {
    const result = await pair(req.params.accountId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/sessions/:accountId/status', (req, res) => {
  res.json(getStatus(req.params.accountId));
});

app.post('/sessions/:accountId/send', async (req, res) => {
  const { to, text, mediaUrl, mediaType, caption } = req.body || {};
  if (!to || (!text && !mediaUrl)) {
    return res.status(400).json({ error: "'to' and one of 'text'/'mediaUrl' are required" });
  }
  try {
    const result = await sendMessage(req.params.accountId, { to, text, mediaUrl, mediaType, caption });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/sessions/:accountId/react', async (req, res) => {
  const { to, targetMessageId, emoji, fromMe } = req.body || {};
  if (!to || !targetMessageId || typeof emoji !== 'string') {
    return res.status(400).json({ error: "'to', 'targetMessageId', and 'emoji' are required" });
  }
  try {
    const result = await sendReaction(req.params.accountId, { to, targetMessageId, emoji, fromMe });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/sessions/:accountId/logout', async (req, res) => {
  try {
    await logout(req.params.accountId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`wacrm-bridge listening on :${PORT}`);
});
