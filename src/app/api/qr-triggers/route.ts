// ============================================================
// /api/qr-triggers
//
//   GET  — list this account's QR triggers (token included — the
//          admin needs it to build/re-print the QR's target URL).
//   POST — create a trigger for a contact + template.
//
// Dashboard endpoints: cookie session + RLS client, same pattern as
// /api/account/api-keys. Listing is viewer+ (RLS allows it); minting
// is admin+ since a trigger fires a real, billable outbound message
// whenever its QR is scanned.
// ============================================================

import { NextResponse } from 'next/server';

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import { generateQrToken } from '@/lib/qr-triggers/tokens';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

const MAX_TEMPLATE_NAME_LEN = 512;
const MIN_COOLDOWN_SECONDS = 60;
const MAX_COOLDOWN_SECONDS = 30 * 24 * 60 * 60; // 30 days

const SAFE_COLUMNS =
  'id, contact_id, token, template_name, template_language, is_active, cooldown_seconds, last_triggered_at, trigger_count, created_at';

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    const { data, error } = await ctx.supabase
      .from('qr_triggers')
      .select(SAFE_COLUMNS)
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[GET /api/qr-triggers] fetch error:', error);
      return NextResponse.json(
        { error: 'Failed to load QR triggers' },
        { status: 500 }
      );
    }

    return NextResponse.json({ triggers: data ?? [] });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `admin:qrTriggerCreate:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as {
      contact_id?: unknown;
      template_name?: unknown;
      template_language?: unknown;
      cooldown_seconds?: unknown;
    } | null;

    const contactId =
      typeof body?.contact_id === 'string' ? body.contact_id.trim() : '';
    if (!contactId) {
      return NextResponse.json(
        { error: "'contact_id' is required" },
        { status: 400 }
      );
    }

    const templateName =
      typeof body?.template_name === 'string' ? body.template_name.trim() : '';
    if (!templateName) {
      return NextResponse.json(
        { error: "'template_name' is required" },
        { status: 400 }
      );
    }
    if (templateName.length > MAX_TEMPLATE_NAME_LEN) {
      return NextResponse.json(
        { error: `'template_name' must be ${MAX_TEMPLATE_NAME_LEN} characters or fewer` },
        { status: 400 }
      );
    }

    const templateLanguage =
      typeof body?.template_language === 'string' && body.template_language.trim()
        ? body.template_language.trim()
        : 'en_US';

    let cooldownSeconds = 3600;
    if (typeof body?.cooldown_seconds === 'number' && Number.isFinite(body.cooldown_seconds)) {
      cooldownSeconds = Math.min(
        Math.max(Math.floor(body.cooldown_seconds), MIN_COOLDOWN_SECONDS),
        MAX_COOLDOWN_SECONDS
      );
    }

    // Confirm the contact belongs to this account before minting a
    // token for it — RLS would also block a cross-account insert via
    // the FK, but checking up front gives a clean 404 instead of a
    // generic insert failure.
    const { data: contact, error: contactErr } = await ctx.supabase
      .from('contacts')
      .select('id')
      .eq('id', contactId)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (contactErr || !contact) {
      return NextResponse.json(
        { error: 'Contact not found in this account' },
        { status: 404 }
      );
    }

    const token = generateQrToken();

    const { data, error } = await ctx.supabase
      .from('qr_triggers')
      .insert({
        account_id: ctx.accountId,
        created_by: ctx.userId,
        contact_id: contactId,
        token,
        template_name: templateName,
        template_language: templateLanguage,
        cooldown_seconds: cooldownSeconds,
      })
      .select(SAFE_COLUMNS)
      .single();

    if (error || !data) {
      console.error('[POST /api/qr-triggers] insert error:', error);
      return NextResponse.json(
        { error: 'Failed to create QR trigger' },
        { status: 500 }
      );
    }

    return NextResponse.json({ trigger: data }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
