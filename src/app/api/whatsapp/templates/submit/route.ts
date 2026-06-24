import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import {
  validateTemplatePayload,
  type TemplatePayload,
} from '@/lib/whatsapp/template-validators'

/**
 * Save a template to the local catalog. No Meta submission — templates
 * are local-only "saved messages" now that sends go through the
 * Baileys bridge instead of Meta's approved-template flow. Usable
 * immediately, no approval wait.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

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

    let payload: TemplatePayload
    try {
      payload = (await request.json()) as TemplatePayload
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
    }

    try {
      validateTemplatePayload(payload)
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'Validation failed.' },
        { status: 400 },
      )
    }

    const row = {
      account_id: accountId,
      user_id: user.id,
      name: payload.name,
      category: payload.category,
      language: payload.language,
      header_type: payload.header_type ?? null,
      header_content: payload.header_content ?? null,
      header_media_url: payload.header_media_url ?? null,
      header_handle: payload.header_handle ?? null,
      body_text: payload.body_text,
      footer_text: payload.footer_text ?? null,
      buttons: payload.buttons ?? null,
      sample_values: payload.sample_values ?? null,
      status: 'Approved',
      meta_template_id: null,
      submission_error: null,
      rejection_reason: null,
      last_submitted_at: new Date().toISOString(),
    }

    const { data: saved, error: upsertErr } = await supabase
      .from('message_templates')
      .upsert(row, { onConflict: 'user_id,name,language' })
      .select()
      .single()

    if (upsertErr) {
      return NextResponse.json(
        { error: `Failed to save template: ${upsertErr.message}` },
        { status: 500 },
      )
    }

    return NextResponse.json({ success: true, template: saved })
  } catch (error) {
    console.error('Error saving template:', error)
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to save template.',
      },
      { status: 500 },
    )
  }
}
