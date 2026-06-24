-- ============================================================
-- 027_qr_triggers.sql — QR-code-triggered outbound messages
--
-- Use case: a business pre-prints a QR code per known contact (e.g.
-- on a badge or card). Scanning it hits a public, unauthenticated
-- URL that sends that contact a WhatsApp template message. QR-code
-- generation/printing happens outside wacrm — this migration only
-- adds the server-side mapping (token -> contact) the scanned URL
-- resolves against.
--
-- token is the only credential: anyone who has the QR (i.e. anyone
-- who was handed the card) can trigger one send to that one contact.
-- That's an intentional, narrow blast radius — not a general-purpose
-- public send API.
--
-- contact_id uses ON DELETE SET NULL (same pattern as migration 004)
-- so deleting a contact doesn't cascade-delete the trigger row; the
-- public route treats a NULL contact_id as inactive.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

CREATE TABLE IF NOT EXISTS qr_triggers (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id         uuid REFERENCES contacts(id) ON DELETE SET NULL,
  created_by         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  token              text NOT NULL UNIQUE,
  template_name      text NOT NULL,
  template_language  text NOT NULL DEFAULT 'en_US',
  is_active          boolean NOT NULL DEFAULT true,
  -- Minimum seconds between sends for this token — guards against a
  -- card being scanned repeatedly (by mistake or for fun) firing a
  -- template message every time.
  cooldown_seconds   integer NOT NULL DEFAULT 3600,
  last_triggered_at  timestamptz,
  trigger_count      integer NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS qr_triggers_account_id_idx ON qr_triggers (account_id);
CREATE INDEX IF NOT EXISTS qr_triggers_token_idx ON qr_triggers (token);

ALTER TABLE qr_triggers ENABLE ROW LEVEL SECURITY;

-- SELECT: any member of the account (viewer+) can see the roster.
DROP POLICY IF EXISTS qr_triggers_select ON qr_triggers;
CREATE POLICY qr_triggers_select ON qr_triggers FOR SELECT
  USING (is_account_member(account_id));

-- INSERT / UPDATE / DELETE: admin+ only — this mints a credential
-- that fires real outbound (billable) messages.
DROP POLICY IF EXISTS qr_triggers_insert ON qr_triggers;
CREATE POLICY qr_triggers_insert ON qr_triggers FOR INSERT
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS qr_triggers_update ON qr_triggers;
CREATE POLICY qr_triggers_update ON qr_triggers FOR UPDATE
  USING (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS qr_triggers_delete ON qr_triggers;
CREATE POLICY qr_triggers_delete ON qr_triggers FOR DELETE
  USING (is_account_member(account_id, 'admin'));
