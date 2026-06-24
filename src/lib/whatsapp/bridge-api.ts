/**
 * Client for the wacrm-bridge service (see bridge/README.md) — a
 * separately-deployed long-running process holding a Baileys
 * (WhatsApp Web protocol) session per account_id.
 *
 * Auth is a single shared secret, set as BRIDGE_SHARED_SECRET in
 * both this app's and the bridge's environment — not per-account,
 * since both ends are backend services under the same operator's
 * control and per-account secrets would add a key-rotation surface
 * without a corresponding security benefit.
 */

function bridgeBaseUrl(): string {
  const url = process.env.BRIDGE_BASE_URL
  if (!url) throw new Error('BRIDGE_BASE_URL is not configured')
  return url.replace(/\/+$/, '')
}

function bridgeSecret(): string {
  const secret = process.env.BRIDGE_SHARED_SECRET
  if (!secret) throw new Error('BRIDGE_SHARED_SECRET is not configured')
  return secret
}

async function bridgeFetch(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${bridgeBaseUrl()}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bridgeSecret()}`,
      ...init?.headers,
    },
  })
  return response
}

async function throwBridgeError(response: Response, fallback: string): Promise<never> {
  let message = fallback
  try {
    const data = (await response.json()) as { error?: string }
    if (data.error) message = data.error
  } catch {
    // response body wasn't JSON — keep the fallback
  }
  throw new Error(message)
}

export interface BridgeSendResult {
  messageId: string
}

export interface SendTextArgs {
  accountId: string
  to: string
  text: string
}

export async function sendText(args: SendTextArgs): Promise<BridgeSendResult> {
  const { accountId, to, text } = args
  const response = await bridgeFetch(`/sessions/${accountId}/send`, {
    method: 'POST',
    body: JSON.stringify({ to, text }),
  })
  if (!response.ok) await throwBridgeError(response, `Bridge send failed: ${response.status}`)
  return response.json()
}

export type BridgeMediaKind = 'image' | 'video' | 'document' | 'audio'

export interface SendMediaArgs {
  accountId: string
  to: string
  mediaUrl: string
  mediaType: BridgeMediaKind
  caption?: string
}

export async function sendMedia(args: SendMediaArgs): Promise<BridgeSendResult> {
  const { accountId, to, mediaUrl, mediaType, caption } = args
  const response = await bridgeFetch(`/sessions/${accountId}/send`, {
    method: 'POST',
    body: JSON.stringify({ to, mediaUrl, mediaType, caption }),
  })
  if (!response.ok) await throwBridgeError(response, `Bridge send failed: ${response.status}`)
  return response.json()
}

export interface SendReactionArgs {
  accountId: string
  to: string
  targetMessageId: string
  emoji: string
  fromMe?: boolean
}

export async function sendReaction(args: SendReactionArgs): Promise<BridgeSendResult> {
  const { accountId, to, targetMessageId, emoji, fromMe } = args
  const response = await bridgeFetch(`/sessions/${accountId}/react`, {
    method: 'POST',
    body: JSON.stringify({ to, targetMessageId, emoji, fromMe }),
  })
  if (!response.ok) await throwBridgeError(response, `Bridge react failed: ${response.status}`)
  return response.json()
}

export type BridgeSessionStatus = 'disconnected' | 'qr_pending' | 'connected'

export interface BridgePairResult {
  status: BridgeSessionStatus
  qr?: string
  phone?: string
}

export async function pairSession(accountId: string): Promise<BridgePairResult> {
  const response = await bridgeFetch(`/sessions/${accountId}/pair`, { method: 'POST' })
  if (!response.ok) await throwBridgeError(response, `Bridge pair failed: ${response.status}`)
  return response.json()
}

export async function getSessionStatus(accountId: string): Promise<BridgePairResult> {
  const response = await bridgeFetch(`/sessions/${accountId}/status`)
  if (!response.ok) await throwBridgeError(response, `Bridge status failed: ${response.status}`)
  return response.json()
}

export async function logoutSession(accountId: string): Promise<void> {
  const response = await bridgeFetch(`/sessions/${accountId}/logout`, { method: 'POST' })
  if (!response.ok) await throwBridgeError(response, `Bridge logout failed: ${response.status}`)
}

// ============================================================
// Template rendering
//
// Baileys has no Meta-style template approval flow — "sending a
// template" is just substituting {{1}}..{{n}} into plain text and
// sending it like any other message. Header/footer text get
// concatenated in; a media header becomes a sendMedia call with
// this rendered text as the caption.
// ============================================================

import { extractVariableIndices } from './template-validators'
import type { MessageTemplate } from '@/types'

export function renderTemplateText(
  template: MessageTemplate,
  body: string[] = [],
): string {
  const varCount = extractVariableIndices(template.body_text).length
  if (body.length < varCount) {
    throw new Error(
      `Template "${template.name}" body has ${varCount} variable(s) but only ${body.length} value(s) were supplied.`,
    )
  }
  let rendered = template.body_text
  body.slice(0, varCount).forEach((value, i) => {
    rendered = rendered.replaceAll(`{{${i + 1}}}`, String(value))
  })

  const parts: string[] = []
  if (template.header_type === 'text' && template.header_content) {
    parts.push(template.header_content)
  }
  parts.push(rendered)
  if (template.footer_text) parts.push(template.footer_text)
  return parts.join('\n\n')
}
