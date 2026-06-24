import { sendText, renderTemplateText } from '@/lib/whatsapp/bridge-api'
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils'
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard'
import { supabaseAdmin } from './admin-client'

// ------------------------------------------------------------
// Automation-side WhatsApp sender, via the Baileys bridge.
//
// Mirrors the logic in src/app/api/whatsapp/send/route.ts but uses
// the service-role client (engine has no cookies) and accepts the
// user / conversation / contact identifiers the engine already has
// on hand.
// ------------------------------------------------------------

interface SendTextArgs {
  /** Account-level tenancy key. Drives contact lookups so an
   *  automation authored by user A still sends through the same
   *  account's bridge session user B paired. */
  accountId: string
  /** Original author of the automation/flow — used for INSERT audit
   *  columns. Not consulted for tenancy. */
  userId: string
  conversationId: string
  contactId: string
  text: string
}

interface SendTemplateArgs {
  accountId: string
  userId: string
  conversationId: string
  contactId: string
  templateName: string
  language?: string
  params?: string[]
}

export async function engineSendText(args: SendTextArgs): Promise<{ whatsapp_message_id: string }> {
  return sendViaBridge({ ...args, kind: 'text' })
}

export async function engineSendTemplate(
  args: SendTemplateArgs,
): Promise<{ whatsapp_message_id: string }> {
  return sendViaBridge({ ...args, kind: 'template' })
}

type SendInput =
  | (SendTextArgs & { kind: 'text' })
  | (SendTemplateArgs & { kind: 'template' })

async function sendViaBridge(input: SendInput): Promise<{ whatsapp_message_id: string }> {
  const db = supabaseAdmin()

  // Scope the contact lookup by account_id, not user_id. The engine
  // uses the service-role client (bypassing RLS); without this
  // filter, an authenticated user could fire their own automations
  // against another tenant's contact UUID.
  const { data: contact, error: contactErr } = await db
    .from('contacts')
    .select('id, phone')
    .eq('id', input.contactId)
    .eq('account_id', input.accountId)
    .maybeSingle()
  if (contactErr || !contact?.phone) {
    throw new Error('contact not found for this account')
  }

  const sanitized = sanitizePhoneForMeta(contact.phone)
  if (!isValidE164(sanitized)) {
    throw new Error(`contact phone invalid: ${contact.phone}`)
  }

  let text: string
  let templateName: string | null = null
  if (input.kind === 'template') {
    const { data: templateRow } = await db
      .from('message_templates')
      .select('*')
      .eq('account_id', input.accountId)
      .eq('name', input.templateName)
      .eq('language', input.language || 'en_US')
      .maybeSingle()
    if (!templateRow || !isMessageTemplate(templateRow)) {
      throw new Error(`template "${input.templateName}" not found for this account`)
    }
    text = renderTemplateText(templateRow, input.params ?? [])
    templateName = input.templateName
  } else {
    text = input.text
  }

  const { messageId: waMessageId } = await sendText({ accountId: input.accountId, to: sanitized, text })

  // Persist the sent message so it appears in the inbox.
  // sender_type='bot' distinguishes automation sends from manual
  // agent sends.
  const { error: msgErr } = await db.from('messages').insert({
    conversation_id: input.conversationId,
    sender_type: 'bot',
    content_type: input.kind,
    content_text: input.kind === 'text' ? input.text : text,
    template_name: templateName,
    message_id: waMessageId,
    status: 'sent',
  })
  if (msgErr) {
    throw new Error(`sent via bridge but DB insert failed: ${msgErr.message}`)
  }

  await db
    .from('conversations')
    .update({
      last_message_text: input.kind === 'template' ? `[template:${input.templateName}]` : input.text,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', input.conversationId)

  return { whatsapp_message_id: waMessageId }
}
