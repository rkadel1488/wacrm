// ============================================================
// /api/qr-triggers/[id]
//
//   PATCH  — toggle is_active (pause/resume a token without
//            reprinting the QR code).
//   DELETE — revoke permanently.
//
// Admin+, enforced here and by the qr_triggers_update /
// qr_triggers_delete RLS policies (migration 027).
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `admin:qrTriggerUpdate:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as {
      is_active?: unknown;
    } | null;
    if (typeof body?.is_active !== 'boolean') {
      return NextResponse.json(
        { error: "'is_active' (boolean) is required" },
        { status: 400 }
      );
    }

    const { id } = await params;

    const { data, error } = await ctx.supabase
      .from('qr_triggers')
      .update({ is_active: body.is_active })
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select('id')
      .maybeSingle();

    if (error) {
      console.error('[PATCH /api/qr-triggers/[id]] error:', error);
      return NextResponse.json(
        { error: 'Failed to update QR trigger' },
        { status: 500 }
      );
    }
    if (!data) {
      return NextResponse.json(
        { error: 'QR trigger not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `admin:qrTriggerDelete:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await params;

    const { data, error } = await ctx.supabase
      .from('qr_triggers')
      .delete()
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select('id')
      .maybeSingle();

    if (error) {
      console.error('[DELETE /api/qr-triggers/[id]] error:', error);
      return NextResponse.json(
        { error: 'Failed to delete QR trigger' },
        { status: 500 }
      );
    }
    if (!data) {
      return NextResponse.json(
        { error: 'QR trigger not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
