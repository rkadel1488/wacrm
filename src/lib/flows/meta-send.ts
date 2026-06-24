import { sendText, sendMedia, type BridgeMediaKind } from '@/lib/whatsapp/bridge-api'
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils'
import { supabaseAdmin } from './admin-client'

// ------------------------------------------------------------
// Flows-side WhatsApp sender, via the Baileys bridge.
//
// Mirrors src/lib/automations/meta-send.ts (engineSendText /
// engineSendTemplate) but also covers media + interactive prompts.
// Baileys (personal WhatsApp) doesn't support Meta's native
// button/list message types, so interactive prompts degrade to
// plain text with the options spelled out as a numbered list —
// the customer replies with the option text or number, same as any
// other text message.
// ------------------------------------------------------------

interface SendTextEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  text: string
}

async function resolveContactPhone(accountId: string, contactId: string): Promise<string> {
  const db = supabaseAdmin()
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, phone')
    .eq('id', contactId)
    .eq('account_id', accountId)
    .maybeSingle()
  if (contactErr || !contact?.phone) {
    throw new Error('contact not found for this account')
  }
  const sanitized = sanitizePhoneForMeta(contact.phone)
  if (!isValidE164(sanitized)) {
    throw new Error(`contact phone invalid: ${contact.phone}`)
  }
  return sanitized
}

async function recordSentMessage(args: {
  conversationId: string
  contentType: string
  contentText: string | null
  messageId: string
}) {
  const db = supabaseAdmin()
  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: args.conversationId,
    sender_type: 'bot',
    content_type: args.contentType,
    content_text: args.contentText,
    message_id: args.messageId,
    status: 'sent',
  })
  if (msgErr) {
    throw new Error(`sent via bridge but DB insert failed: ${msgErr.message}`)
  }
  await db
    .from('conversations')
    .update({
      last_message_text: args.contentText || `[${args.contentType}]`,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', args.conversationId)
}

/**
 * Send a plain-text WhatsApp message from the Flows engine.
 * Used by the runner's `send_message` and `collect_input` nodes.
 */
export async function engineSendText(
  args: SendTextEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  const phone = await resolveContactPhone(args.accountId, args.contactId)
  const { messageId } = await sendText({ accountId: args.accountId, to: phone, text: args.text })
  await recordSentMessage({
    conversationId: args.conversationId,
    contentType: 'text',
    contentText: args.text,
    messageId,
  })
  return { whatsapp_message_id: messageId }
}

interface SendMediaEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  kind: BridgeMediaKind
  /** Public URL the bridge fetches at send time. */
  link: string
  caption?: string
  /** Accepted for call-site compatibility; Baileys derives the
   *  recipient-visible filename from the media URL itself. */
  filename?: string
}

/**
 * Send an image / video / document / audio from the Flows engine.
 * Used by the runner's `send_media` node.
 */
export async function engineSendMedia(
  args: SendMediaEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  const phone = await resolveContactPhone(args.accountId, args.contactId)
  const { messageId } = await sendMedia({
    accountId: args.accountId,
    to: phone,
    mediaUrl: args.link,
    mediaType: args.kind,
    caption: args.caption,
  })
  const preview = args.caption?.trim() || `[${args.kind}]`
  await recordSentMessage({
    conversationId: args.conversationId,
    contentType: args.kind,
    contentText: args.caption ?? null,
    messageId,
  })
  // recordSentMessage falls back to `[type]` when contentText is
  // null, which matches `preview` here — no separate write needed.
  void preview
  return { whatsapp_message_id: messageId }
}

export interface InteractiveButton {
  id: string
  title: string
}

export interface InteractiveListRow {
  id: string
  title: string
  description?: string
}

export interface InteractiveListSection {
  title?: string
  rows: InteractiveListRow[]
}

interface SendInteractiveButtonsEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  bodyText: string
  buttons: InteractiveButton[]
  headerText?: string
  footerText?: string
}

interface SendInteractiveListEngineArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  bodyText: string
  buttonLabel: string
  sections: InteractiveListSection[]
  headerText?: string
  footerText?: string
}

function renderButtonsAsText(args: SendInteractiveButtonsEngineArgs): string {
  const parts: string[] = []
  if (args.headerText) parts.push(args.headerText)
  parts.push(args.bodyText)
  parts.push(args.buttons.map((b, i) => `${i + 1}. ${b.title}`).join('\n'))
  if (args.footerText) parts.push(args.footerText)
  return parts.join('\n\n')
}

function renderListAsText(args: SendInteractiveListEngineArgs): string {
  const parts: string[] = []
  if (args.headerText) parts.push(args.headerText)
  parts.push(args.bodyText)
  let n = 1
  for (const section of args.sections) {
    const lines: string[] = []
    if (section.title) lines.push(section.title)
    for (const row of section.rows) {
      lines.push(`${n}. ${row.title}${row.description ? ` — ${row.description}` : ''}`)
      n += 1
    }
    parts.push(lines.join('\n'))
  }
  if (args.footerText) parts.push(args.footerText)
  return parts.join('\n\n')
}

/**
 * Send an interactive-button prompt from the Flows engine. Baileys
 * has no native button message, so this renders as a numbered-list
 * plain text message — the customer's text reply is matched against
 * the button titles/numbers by the runner the same way any other
 * text reply is.
 */
export async function engineSendInteractiveButtons(
  args: SendInteractiveButtonsEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  const text = renderButtonsAsText(args)
  const phone = await resolveContactPhone(args.accountId, args.contactId)
  const { messageId } = await sendText({ accountId: args.accountId, to: phone, text })
  await recordSentMessage({
    conversationId: args.conversationId,
    contentType: 'text',
    contentText: text,
    messageId,
  })
  return { whatsapp_message_id: messageId }
}

/**
 * Send an interactive-list prompt from the Flows engine. Same
 * plain-text degradation as engineSendInteractiveButtons.
 */
export async function engineSendInteractiveList(
  args: SendInteractiveListEngineArgs,
): Promise<{ whatsapp_message_id: string }> {
  const text = renderListAsText(args)
  const phone = await resolveContactPhone(args.accountId, args.contactId)
  const { messageId } = await sendText({ accountId: args.accountId, to: phone, text })
  await recordSentMessage({
    conversationId: args.conversationId,
    contentType: 'text',
    contentText: text,
    messageId,
  })
  return { whatsapp_message_id: messageId }
}
