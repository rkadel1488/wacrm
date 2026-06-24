// ============================================================
// QR trigger token generation — pure, no I/O.
//
// Unlike API keys (hashed at rest, shown once), this token IS the
// row's lookup key: the public route does `WHERE token = $1`, and
// it needs to be embeddable directly in a QR code's URL, so there's
// nothing to hash against. Its secrecy comes from being a 256-bit
// CSPRNG value baked into a printed code, not from server-side
// storage tricks.
// ============================================================

import { randomBytes } from 'node:crypto';

export const QR_TOKEN_PREFIX = 'qrt_';

export function generateQrToken(): string {
  return `${QR_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}
