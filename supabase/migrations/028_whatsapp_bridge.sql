-- ============================================================
-- Baileys bridge support.
--
-- wacrm no longer talks to Meta's WhatsApp Business Cloud API —
-- sends/receives now go through a separately-deployed bridge
-- service (see bridge/README.md) holding a WhatsApp-Web-protocol
-- session per account. Auth to the bridge is a single shared
-- secret (BRIDGE_SHARED_SECRET, set in both services' env), so no
-- per-account secret column is needed.
--
-- Meta-specific columns are kept (not dropped) for history/
-- reversibility but are now nullable since pairing no longer
-- produces them.
-- ============================================================

ALTER TABLE whatsapp_config
  ALTER COLUMN phone_number_id DROP NOT NULL,
  ALTER COLUMN access_token DROP NOT NULL;

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS connected_phone TEXT;

-- message_templates.status stops being a Meta-approval lifecycle —
-- new rows are usable immediately. Default reflects that; existing
-- rows are left as-is (historical record).
ALTER TABLE message_templates
  ALTER COLUMN status SET DEFAULT 'Approved';
