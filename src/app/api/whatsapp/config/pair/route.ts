import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { pairSession } from '@/lib/whatsapp/bridge-api'

async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle()
  return (data?.account_id as string | undefined) ?? null
}

/**
 * POST /api/whatsapp/config/pair
 *
 * Starts (or resumes) this account's Baileys session on the bridge and
 * returns a QR code to scan, or `{status: 'connected'}` if it's already
 * linked. The Settings UI polls /api/whatsapp/config/status afterward.
 */
export async function POST() {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const result = await pairSession(accountId)

    if (result.status === 'connected') {
      await supabase
        .from('whatsapp_config')
        .upsert(
          {
            account_id: accountId,
            user_id: user.id,
            status: 'connected',
            connected_phone: result.phone ?? null,
            connected_at: new Date().toISOString(),
          },
          { onConflict: 'account_id' },
        )
    }

    return NextResponse.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown bridge error'
    console.error('[config/pair] failed:', message)
    return NextResponse.json({ error: `Bridge pairing failed: ${message}` }, { status: 502 })
  }
}
