import { NextResponse } from 'next/server'
import { processInboundText, supabaseAdmin } from '@/lib/whatsapp/inbound'

// ------------------------------------------------------------
// POST /api/whatsapp/bridge/webhook — inbound messages from the
// Baileys bridge service. Auth is a single shared bearer secret
// (BRIDGE_SHARED_SECRET) since the bridge and this app are both
// backend services under the same control — no per-account secret
// to verify against, unlike Meta's per-app HMAC signing.
// ------------------------------------------------------------

interface BridgeInboundPayload {
  accountId: string
  from: string
  text: string
  messageId: string
  timestamp: number
}

export async function POST(request: Request) {
  const auth = request.headers.get('authorization')
  const expected = process.env.BRIDGE_SHARED_SECRET
  if (!expected || auth !== `Bearer ${expected}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: BridgeInboundPayload
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.accountId || !body.from || !body.text || !body.messageId) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  }

  const { data: config } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('account_id, user_id')
    .eq('account_id', body.accountId)
    .maybeSingle()

  if (!config) {
    console.error('[bridge-webhook] no whatsapp_config for account', body.accountId)
    return NextResponse.json({ status: 'ignored' }, { status: 200 })
  }

  processInboundText({
    accountId: config.account_id,
    configOwnerUserId: config.user_id,
    fromPhone: body.from,
    contactName: body.from,
    text: body.text,
    messageId: body.messageId,
    createdAt: body.timestamp ? new Date(body.timestamp * 1000) : new Date(),
  }).catch((err) => {
    console.error('[bridge-webhook] processing failed:', err)
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}
