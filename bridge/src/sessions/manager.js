import path from 'node:path';
import fs from 'node:fs/promises';
import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';

const logger = pino({ level: process.env.BRIDGE_LOG_LEVEL || 'silent' });

const DATA_DIR = process.env.DATA_DIR || './data';
const WACRM_BASE_URL = process.env.WACRM_BASE_URL;
const BRIDGE_SHARED_SECRET = process.env.BRIDGE_SHARED_SECRET;

// accountId -> { sock, status, qr, phone }
const sessions = new Map();

function authDir(accountId) {
  return path.join(DATA_DIR, 'sessions', accountId);
}

function getOrInitState(accountId) {
  let state = sessions.get(accountId);
  if (!state) {
    state = { sock: null, status: 'disconnected', qr: null, phone: null, starting: false };
    sessions.set(accountId, state);
  }
  return state;
}

async function postInbound(accountId, payload) {
  if (!WACRM_BASE_URL) return;
  try {
    await fetch(`${WACRM_BASE_URL}/api/whatsapp/bridge/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${BRIDGE_SHARED_SECRET}`,
      },
      body: JSON.stringify({ accountId, ...payload }),
    });
  } catch (err) {
    logger.error({ err }, 'failed to post inbound message to wacrm');
  }
}

function extractText(message) {
  if (!message) return null;
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    null
  );
}

async function startSession(accountId) {
  const state = getOrInitState(accountId);
  if (state.sock || state.starting) return state;
  state.starting = true;

  await fs.mkdir(authDir(accountId), { recursive: true });
  const { state: authState, saveCreds } = await useMultiFileAuthState(authDir(accountId));
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: authState,
    logger,
    printQRInTerminal: false,
  });

  state.sock = sock;
  state.status = 'qr_pending';

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      state.qr = await QRCode.toDataURL(qr);
      state.status = 'qr_pending';
    }

    if (connection === 'open') {
      state.status = 'connected';
      state.qr = null;
      state.phone = sock.user?.id ? `+${sock.user.id.split(':')[0]}` : null;
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      state.sock = null;
      state.starting = false;
      if (statusCode === DisconnectReason.loggedOut) {
        state.status = 'disconnected';
        state.phone = null;
        state.qr = null;
        await fs.rm(authDir(accountId), { recursive: true, force: true });
      } else {
        // transient drop — attempt reconnect
        state.status = 'disconnected';
        startSession(accountId).catch((err) => logger.error({ err }, 'reconnect failed'));
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      const text = extractText(msg.message);
      if (!text) continue;
      const from = msg.key.remoteJid?.split('@')[0];
      if (!from) continue;
      await postInbound(accountId, {
        from: `+${from}`,
        text,
        messageId: msg.key.id,
        timestamp: msg.messageTimestamp,
      });
    }
  });

  state.starting = false;
  return state;
}

export async function pair(accountId) {
  const state = getOrInitState(accountId);
  if (state.status === 'connected') {
    return { status: 'connected', phone: state.phone };
  }
  await startSession(accountId);
  // give the socket a brief moment to emit the first QR
  for (let i = 0; i < 20 && !state.qr && state.status !== 'connected'; i++) {
    await new Promise((r) => setTimeout(r, 250));
  }
  if (state.status === 'connected') {
    return { status: 'connected', phone: state.phone };
  }
  return { status: 'qr_pending', qr: state.qr };
}

export function getStatus(accountId) {
  const state = sessions.get(accountId);
  if (!state) return { status: 'disconnected' };
  if (state.status === 'connected') return { status: 'connected', phone: state.phone };
  if (state.status === 'qr_pending') return { status: 'qr_pending', qr: state.qr };
  return { status: 'disconnected' };
}

function toJid(to) {
  const digits = to.replace(/[^\d]/g, '');
  return `${digits}@s.whatsapp.net`;
}

export async function sendMessage(accountId, { to, text, mediaUrl, mediaType, caption }) {
  const state = sessions.get(accountId);
  if (!state?.sock || state.status !== 'connected') {
    throw new Error('session not connected');
  }
  const jid = toJid(to);

  let content;
  if (mediaUrl) {
    const mediaKey = { image: 'image', video: 'video', document: 'document', audio: 'audio' }[mediaType];
    if (!mediaKey) throw new Error('invalid mediaType');
    content = { [mediaKey]: { url: mediaUrl }, caption };
  } else {
    content = { text };
  }

  const result = await state.sock.sendMessage(jid, content);
  return { messageId: result.key.id };
}

export async function sendReaction(accountId, { to, targetMessageId, emoji, fromMe }) {
  const state = sessions.get(accountId);
  if (!state?.sock || state.status !== 'connected') {
    throw new Error('session not connected');
  }
  const jid = toJid(to);
  const result = await state.sock.sendMessage(jid, {
    react: {
      text: emoji,
      key: { remoteJid: jid, id: targetMessageId, fromMe: !!fromMe },
    },
  });
  return { messageId: result.key.id };
}

export async function logout(accountId) {
  const state = sessions.get(accountId);
  if (state?.sock) {
    try {
      await state.sock.logout();
    } catch {
      // socket already closed
    }
  }
  await fs.rm(authDir(accountId), { recursive: true, force: true });
  sessions.delete(accountId);
}
