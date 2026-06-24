import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  sendText,
  sendMedia,
  renderTemplateText,
  type BridgeMediaKind,
} from '@/lib/whatsapp/bridge-api'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils'
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit'
import type { MessageTemplate } from '@/types'
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard'

export async function POST(request: Request) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }

    // Per-user rate limit. Bucket key is scoped to this route so
    // `/broadcast` has an independent budget.
    const limit = checkRateLimit(`send:${user.id}`, RATE_LIMITS.send)
    if (!limit.success) {
      return rateLimitResponse(limit)
    }

    // Resolve the caller's account_id. Every downstream lookup
    // (conversation, whatsapp_config, message_templates) is account-
    // scoped post-multi-user, so the previous `user_id` filters
    // returned nothing for teammates who didn't author the row.
    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const body = await request.json()
    const {
      conversation_id,
      message_type,
      content_text,
      media_url,
      template_name,
      template_language,
      template_params,
      template_message_params,
      reply_to_message_id,
    } = body

    if (!conversation_id || !message_type) {
      return NextResponse.json(
        { error: 'conversation_id and message_type are required' },
        { status: 400 }
      )
    }

    // Media kinds (image/video/document/audio) are sent via a public URL
    // the composer already uploaded to the chat-media bucket.
    const MEDIA_KINDS = ['image', 'video', 'document', 'audio'] as const
    const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(message_type)

    // Reject anything outside the known set up front rather than letting
    // an unknown type fall through to the text path with empty content.
    const VALID_MESSAGE_TYPES = ['text', 'template', ...MEDIA_KINDS] as const
    if (!(VALID_MESSAGE_TYPES as readonly string[]).includes(message_type)) {
      return NextResponse.json(
        { error: `Unsupported message_type "${message_type}"` },
        { status: 400 }
      )
    }

    if (message_type === 'text' && !content_text) {
      return NextResponse.json(
        { error: 'content_text is required for text messages' },
        { status: 400 }
      )
    }

    if (message_type === 'template' && !template_name) {
      return NextResponse.json(
        { error: 'template_name is required for template messages' },
        { status: 400 }
      )
    }

    if (isMediaKind && !media_url) {
      return NextResponse.json(
        { error: `media_url is required for ${message_type} messages` },
        { status: 400 }
      )
    }

    // Cap media captions at 1024 chars, matching WhatsApp's own limit;
    // reject before the upload is wasted.
    if (
      isMediaKind &&
      message_type !== 'audio' &&
      typeof content_text === 'string' &&
      content_text.length > 1024
    ) {
      return NextResponse.json(
        { error: 'Caption exceeds the 1024-character limit' },
        { status: 400 }
      )
    }

    // Fetch conversation and contact
    const { data: conversation, error: convError } = await supabase
      .from('conversations')
      .select('*, contact:contacts(*)')
      .eq('id', conversation_id)
      .eq('account_id', accountId)
      .single()

    if (convError || !conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      )
    }

    const contact = conversation.contact
    if (!contact?.phone) {
      return NextResponse.json(
        { error: 'Contact phone number not found' },
        { status: 400 }
      )
    }

    // Sanitize and validate phone
    const sanitizedPhone = sanitizePhoneForMeta(contact.phone)
    if (!isValidE164(sanitizedPhone)) {
      return NextResponse.json(
        { error: 'Invalid phone number format' },
        { status: 400 }
      )
    }

    const { data: config, error: configError } = await supabase
      .from('whatsapp_config')
      .select('*')
      .eq('account_id', accountId)
      .single()

    if (configError || !config) {
      return NextResponse.json(
        { error: 'WhatsApp not configured. Please set up your WhatsApp integration first.' },
        { status: 400 }
      )
    }

    // Load the template row for plain-text variable substitution.
    let templateRow: MessageTemplate | null = null
    if (message_type === 'template' && template_name) {
      const { data } = await supabase
        .from('message_templates')
        .select('*')
        .eq('account_id', accountId)
        .eq('name', template_name)
        .eq('language', template_language || 'en_US')
        .maybeSingle()
      if (data && !isMessageTemplate(data)) {
        return NextResponse.json(
          { error: 'Template row is malformed locally.' },
          { status: 500 },
        )
      }
      templateRow = data ?? null
    }

    let waMessageId = ''

    try {
      if (message_type === 'template') {
        if (!templateRow) {
          return NextResponse.json({ error: `Template "${template_name}" not found` }, { status: 404 })
        }
        const text = renderTemplateText(
          templateRow,
          template_message_params?.body ?? template_params ?? [],
        )
        const result = await sendText({ accountId, to: sanitizedPhone, text })
        waMessageId = result.messageId
      } else if (isMediaKind) {
        const result = await sendMedia({
          accountId,
          to: sanitizedPhone,
          mediaUrl: media_url,
          mediaType: message_type as BridgeMediaKind,
          caption: content_text || undefined,
        })
        waMessageId = result.messageId
      } else {
        const result = await sendText({ accountId, to: sanitizedPhone, text: content_text })
        waMessageId = result.messageId
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown bridge error'
      console.error('Bridge send failed:', message)
      return NextResponse.json(
        { error: `WhatsApp send failed: ${message}` },
        { status: 502 }
      )
    }

    // Insert message into DB — field names MUST match the messages schema
    // (see supabase/migrations/001_initial_schema.sql):
    //   conversation_id, sender_type, content_type, content_text,
    //   media_url, template_name, message_id, status, created_at
    const { data: messageRecord, error: msgError } = await supabase
      .from('messages')
      .insert({
        conversation_id,
        sender_type: 'agent',
        content_type: message_type,
        content_text: content_text || null,
        media_url: media_url || null,
        template_name: template_name || null,
        message_id: waMessageId,
        status: 'sent',
        reply_to_message_id: reply_to_message_id || null,
      })
      .select()
      .single()

    if (msgError) {
      console.error('Error inserting sent message:', msgError)
      return NextResponse.json(
        { error: `Message sent but failed to save to DB: ${msgError.message}` },
        { status: 500 }
      )
    }

    // Update conversation
    await supabase
      .from('conversations')
      .update({
        last_message_text: content_text || `[${message_type}]`,
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', conversation_id)

    // Pause any active Flow run for this contact — the agent stepping
    // in is the strongest "yield, human is here" signal. See PR #2
    // plan for why we pause (not end): preserves diagnostic state +
    // lets the agent or the 24h timeout sweep cleanly resolve the
    // run later. For accounts with no active runs the UPDATE matches
    // zero rows — cheap and harmless.
    try {
      const { error: pauseErr } = await supabaseAdmin()
        .from('flow_runs')
        .update({
          status: 'paused_by_agent',
          ended_at: new Date().toISOString(),
          end_reason: 'agent_replied',
        })
        .eq('account_id', accountId)
        .eq('contact_id', contact.id)
        .eq('status', 'active')
      if (pauseErr) {
        // Best-effort — log + continue. The agent's message already
        // went out; don't fail the response over a bookkeeping
        // miss. Worst case: a stale active run gets caught by the
        // stale-run cron sweep within 24h.
        console.error('[flows] pause-on-agent-send failed:', pauseErr.message)
      }
    } catch (err) {
      console.error(
        '[flows] pause-on-agent-send threw:',
        err instanceof Error ? err.message : err,
      )
    }

    return NextResponse.json({
      success: true,
      message_id: messageRecord.id,
      whatsapp_message_id: waMessageId,
    })
  } catch (error) {
    console.error('Error in WhatsApp send POST:', error)
    return NextResponse.json(
      { error: 'Failed to send message' },
      { status: 500 }
    )
  }
}
