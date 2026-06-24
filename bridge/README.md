# wacrm-bridge

Long-running WhatsApp Web bridge for wacrm, built on
[Baileys](https://github.com/WhiskeySockets/Baileys) (a WebSocket
implementation of the WhatsApp Web protocol — no Meta Cloud API, no
templates, no per-message billing).

**This is unofficial WhatsApp automation. It violates WhatsApp's Terms of
Service and the connected number can be banned by Meta at any time, with
no appeal process.** Use a number you're willing to lose.

## Why a separate service

Baileys needs a persistent process holding a live WebSocket connection.
wacrm's Next.js app runs on Vercel (serverless) and cannot host that —
this service runs on a VPS / Railway / Fly / Render instead and exposes a
small HTTP API that wacrm calls.

## Auth model

Every request to this service (from wacrm) and every webhook this service
sends back to wacrm carries the same shared secret, set as `BRIDGE_SHARED_SECRET`
in both this service's environment and wacrm's `BRIDGE_SHARED_SECRET` env var.
It's a service-to-service secret — never exposed to a browser. Per-account
isolation is by `accountId` in the URL/payload, trusted because the channel
itself is authenticated.

## Environment variables

- `PORT` — default 4001.
- `BRIDGE_SHARED_SECRET` — required. Long random string, must match wacrm's copy.
- `WACRM_BASE_URL` — wacrm's base URL (e.g. `https://your-app.vercel.app`), used to POST inbound messages to `${WACRM_BASE_URL}/api/whatsapp/bridge/webhook`.
- `DATA_DIR` — default `./data`. Where each account's Baileys auth state (creds + keys) is persisted. Treat this directory as highly sensitive — it's equivalent to a live login session. Back it up; losing it means re-scanning the QR code.

## Running

```bash
npm install
BRIDGE_SHARED_SECRET=... WACRM_BASE_URL=https://your-app.vercel.app npm start
```

## API

All endpoints require `Authorization: Bearer <BRIDGE_SHARED_SECRET>`.

- `POST /sessions/:accountId/pair` → `{ status: "qr_pending", qr: "data:image/png;base64,..." }` or `{ status: "connected", phone: "+1..." }` if already paired. Poll `/status` until connected.
- `GET /sessions/:accountId/status` → `{ status: "disconnected" | "qr_pending" | "connected", phone?: string }`
- `POST /sessions/:accountId/send` → body `{ to: "+1...", text: "..." }` or `{ to, mediaUrl, mediaType: "image"|"video"|"document"|"audio", caption? }` → `{ messageId }`
- `POST /sessions/:accountId/logout` → tears down the session and deletes its auth state.
