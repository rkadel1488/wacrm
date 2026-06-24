// ============================================================
// GET /api/qr/[token] — public QR-scan trigger.
//
// A QR code printed ahead of time (e.g. on a badge/card) encodes a
// URL to this route. Scanning it opens the URL in the phone's
// browser, which fires this GET and sends that one pre-mapped
// contact a WhatsApp message via the bridge. No login, no API key —
// the token itself (256 bits of CSPRNG, see lib/qr-triggers/tokens.ts)
// is the only credential, and it can only ever target the single
// contact it was minted for (migration 027).
// ============================================================

import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { sendText, renderTemplateText } from '@/lib/whatsapp/bridge-api';
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils';
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';

function text(body: string, status = 200) {
  return new NextResponse(body, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  return forwarded?.split(',')[0]?.trim() || 'unknown';
}

async function findOrCreateConversation(
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
) {
  const db = supabaseAdmin();
  const { data: existing } = await db
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .maybeSingle();
  if (existing) return existing;

  const { data: created, error } = await db
    .from('conversations')
    .insert({ account_id: accountId, user_id: configOwnerUserId, contact_id: contactId })
    .select()
    .single();
  if (error) {
    console.error('[qr-trigger] conversation create failed:', error.message);
    return null;
  }
  return created;
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  if (!token) return text('Invalid link.', 400);

  const limit = checkRateLimit(`qr:ip:${clientIp(request)}`, RATE_LIMITS.qrTrigger);
  if (!limit.success) {
    return text('Too many requests — please try again in a minute.', 429);
  }

  const db = supabaseAdmin();

  const { data: trigger, error: triggerErr } = await db
    .from('qr_triggers')
    .select('*')
    .eq('token', token)
    .maybeSingle();

  if (triggerErr || !trigger || !trigger.is_active || !trigger.contact_id) {
    return text('This QR code is no longer active.', 404);
  }

  // Cooldown: a repeat scan inside the window is a no-op, not an
  // error — the recipient already got the message.
  if (trigger.last_triggered_at) {
    const elapsedMs = Date.now() - new Date(trigger.last_triggered_at).getTime();
    if (elapsedMs < trigger.cooldown_seconds * 1000) {
      return text("You're all set — we already sent you a message recently.");
    }
  }

  const { data: contact } = await db
    .from('contacts')
    .select('id, phone')
    .eq('id', trigger.contact_id)
    .eq('account_id', trigger.account_id)
    .maybeSingle();
  if (!contact?.phone) {
    return text('This QR code is no longer active.', 404);
  }

  const sanitized = sanitizePhoneForMeta(contact.phone);
  if (!isValidE164(sanitized)) {
    console.error(`[qr-trigger] contact phone invalid: ${contact.phone}`);
    return text('Something went wrong — please contact us directly.', 500);
  }

  const { data: config } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', trigger.account_id)
    .maybeSingle();
  if (!config) {
    console.error(`[qr-trigger] no whatsapp_config for account ${trigger.account_id}`);
    return text('Something went wrong — please contact us directly.', 500);
  }

  const { data: templateData } = await db
    .from('message_templates')
    .select('*')
    .eq('account_id', trigger.account_id)
    .eq('name', trigger.template_name)
    .eq('language', trigger.template_language)
    .maybeSingle();
  if (!templateData || !isMessageTemplate(templateData)) {
    console.error(`[qr-trigger] template not found: ${trigger.template_name}`);
    return text('Something went wrong — please contact us directly.', 500);
  }

  let waMessageId = '';
  try {
    const messageText = renderTemplateText(templateData);
    const result = await sendText({ accountId: trigger.account_id, to: sanitized, text: messageText });
    waMessageId = result.messageId;
  } catch (err) {
    console.error('[qr-trigger] bridge send failed:', err instanceof Error ? err.message : err);
    return text('Something went wrong sending your message — please contact us directly.', 502);
  }

  const conversation = await findOrCreateConversation(
    trigger.account_id,
    config.user_id,
    contact.id,
  );
  if (conversation) {
    await db.from('messages').insert({
      conversation_id: conversation.id,
      sender_type: 'bot',
      content_type: 'template',
      template_name: trigger.template_name,
      message_id: waMessageId,
      status: 'sent',
    });
    await db
      .from('conversations')
      .update({
        last_message_text: `[template:${trigger.template_name}]`,
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', conversation.id);
  }

  await db
    .from('qr_triggers')
    .update({
      last_triggered_at: new Date().toISOString(),
      trigger_count: trigger.trigger_count + 1,
    })
    .eq('id', trigger.id);

  return text("Thanks! We've sent you a message on WhatsApp.");
}
