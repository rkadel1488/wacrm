import { createClient } from '@supabase/supabase-js'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'

// ------------------------------------------------------------
// Shared inbound-message processing — used by the bridge webhook.
// Resolves the contact/conversation for an inbound text, inserts the
// message row, and dispatches automations/flows. Transport-specific
// concerns (auth, payload shape) live in the calling route.
// ------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
export function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any

interface ContactOutcome {
  contact: ContactRow
  wasCreated: boolean
}

export async function findOrCreateContact(
  accountId: string,
  configOwnerUserId: string,
  phone: string,
  name: string,
): Promise<ContactOutcome | null> {
  const existingContact = await findExistingContact(supabaseAdmin(), accountId, phone)

  if (existingContact) {
    if (name && name !== existingContact.name) {
      await supabaseAdmin()
        .from('contacts')
        .update({ name, updated_at: new Date().toISOString() })
        .eq('id', existingContact.id)
    }
    return { contact: existingContact, wasCreated: false }
  }

  const { data: newContact, error: createError } = await supabaseAdmin()
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone,
      name: name || phone,
    })
    .select()
    .single()

  if (createError) {
    if (isUniqueViolation(createError)) {
      const raced = await findExistingContact(supabaseAdmin(), accountId, phone)
      if (raced) return { contact: raced, wasCreated: false }
    }
    console.error('[inbound] error creating contact:', createError)
    return null
  }

  return { contact: newContact, wasCreated: true }
}

export async function findOrCreateConversation(
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
) {
  const { data: existing, error: findError } = await supabaseAdmin()
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .single()

  if (!findError && existing) {
    return existing
  }

  const { data: newConv, error: createError } = await supabaseAdmin()
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
    })
    .select()
    .single()

  if (createError) {
    console.error('[inbound] error creating conversation:', createError)
    return null
  }

  return newConv
}

export interface InboundTextMessage {
  accountId: string
  configOwnerUserId: string
  fromPhone: string
  contactName: string
  text: string
  messageId: string
  createdAt: Date
}

/**
 * Process one inbound text message from the bridge: resolve
 * contact/conversation, insert the message row, update conversation
 * preview, and dispatch flows/automations. Mirrors the relevant slice
 * of the old Meta webhook's `processMessage`, minus everything that
 * was Meta-specific (media downloads, statuses, interactive replies,
 * reactions — none of which the bridge sends today).
 */
export async function processInboundText(msg: InboundTextMessage): Promise<void> {
  const contactOutcome = await findOrCreateContact(
    msg.accountId,
    msg.configOwnerUserId,
    msg.fromPhone,
    msg.contactName,
  )
  if (!contactOutcome) return
  const contactRecord = contactOutcome.contact

  const conversation = await findOrCreateConversation(
    msg.accountId,
    msg.configOwnerUserId,
    contactRecord.id,
  )
  if (!conversation) return

  const { count: priorCustomerMsgCount } = await supabaseAdmin()
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0

  const { error: msgError } = await supabaseAdmin().from('messages').insert({
    conversation_id: conversation.id,
    sender_type: 'customer',
    content_type: 'text',
    content_text: msg.text,
    message_id: msg.messageId,
    status: 'delivered',
    created_at: msg.createdAt.toISOString(),
  })
  if (msgError) {
    console.error('[inbound] error inserting message:', msgError)
    return
  }

  await supabaseAdmin()
    .from('conversations')
    .update({
      last_message_text: msg.text,
      last_message_at: new Date().toISOString(),
      unread_count: (conversation.unread_count || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)

  const flowResult = await dispatchInboundToFlows({
    accountId: msg.accountId,
    userId: msg.configOwnerUserId,
    contactId: contactRecord.id,
    conversationId: conversation.id,
    message: { kind: 'text', text: msg.text, meta_message_id: msg.messageId },
    isFirstInboundMessage,
  })
  const flowConsumed = flowResult.consumed

  const automationTriggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
  )[] = []
  if (!flowConsumed) {
    automationTriggers.push('new_message_received', 'keyword_match')
  }
  if (contactOutcome.wasCreated) automationTriggers.unshift('new_contact_created')
  if (isFirstInboundMessage) automationTriggers.unshift('first_inbound_message')
  for (const triggerType of automationTriggers) {
    runAutomationsForTrigger({
      accountId: msg.accountId,
      triggerType,
      contactId: contactRecord.id,
      context: {
        message_text: msg.text,
        conversation_id: conversation.id,
      },
    }).catch((err) => console.error('[automations] dispatch failed:', err))
  }
}
