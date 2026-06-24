'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, XCircle, Loader2, RotateCcw, QrCode } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { SettingsPanelHead } from './settings-panel-head';

type ConnectionStatus = 'connected' | 'disconnected' | 'qr_pending' | 'unknown';

export function WhatsAppConfig() {
  const { user, accountId, loading: authLoading, profileLoading } = useAuth();

  const [loading, setLoading] = useState(true);
  const [pairing, setPairing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [status, setStatus] = useState<ConnectionStatus>('unknown');
  const [phone, setPhone] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/whatsapp/config', { method: 'GET' });
      const data = await res.json();
      if (data.connected) {
        setStatus('connected');
        setPhone(data.phone ?? null);
        setQr(null);
        stopPolling();
      } else {
        setStatus('disconnected');
        setPhone(null);
      }
    } catch (err) {
      console.error('fetchStatus error:', err);
      setStatus('disconnected');
    } finally {
      setLoading(false);
    }
  }, [stopPolling]);

  useEffect(() => {
    if (authLoading || profileLoading) return;
    if (!user || !accountId) {
      setLoading(false);
      return;
    }
    fetchStatus();
    return () => stopPolling();
  }, [authLoading, profileLoading, user, accountId, fetchStatus, stopPolling]);

  async function pollLiveStatus() {
    try {
      const res = await fetch('/api/whatsapp/config/status', { method: 'GET' });
      const data = await res.json();
      if (data.status === 'connected') {
        setStatus('connected');
        setPhone(data.phone ?? null);
        setQr(null);
        stopPolling();
        toast.success(data.phone ? `Connected as ${data.phone}` : 'WhatsApp connected.');
      } else if (data.qr) {
        setQr(data.qr);
        setStatus('qr_pending');
      }
    } catch (err) {
      console.error('pollLiveStatus error:', err);
    }
  }

  async function handleConnect() {
    setPairing(true);
    try {
      const res = await fetch('/api/whatsapp/config/pair', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to start pairing');
        return;
      }
      if (data.status === 'connected') {
        setStatus('connected');
        setPhone(data.phone ?? null);
        setQr(null);
        toast.success(data.phone ? `Connected as ${data.phone}` : 'WhatsApp connected.');
        return;
      }
      setQr(data.qr ?? null);
      setStatus('qr_pending');
      stopPolling();
      pollRef.current = setInterval(pollLiveStatus, 3000);
    } catch (err) {
      console.error('Connect error:', err);
      toast.error('Failed to start pairing');
    } finally {
      setPairing(false);
    }
  }

  async function handleDisconnect() {
    if (!confirm('Disconnect this WhatsApp number? You will need to scan a new QR code to reconnect.')) {
      return;
    }
    setDisconnecting(true);
    try {
      const res = await fetch('/api/whatsapp/config', { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to disconnect');
        return;
      }
      stopPolling();
      setStatus('disconnected');
      setPhone(null);
      setQr(null);
      toast.success('WhatsApp disconnected.');
    } catch (err) {
      console.error('Disconnect error:', err);
      toast.error('Failed to disconnect');
    } finally {
      setDisconnecting(false);
    }
  }

  if (loading) {
    return (
      <section className="animate-in fade-in-50 duration-200">
        <SettingsPanelHead
          title="WhatsApp connection"
          description="Link a WhatsApp number by scanning a QR code — same as linking WhatsApp Web."
        />
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      </section>
    );
  }

  return (
    <section className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title="WhatsApp connection"
        description="Link a WhatsApp number by scanning a QR code — same as linking WhatsApp Web. No Meta approval, no templates."
      />
      <div className="max-w-md space-y-6">
        <Alert className="bg-card border-border">
          <div className="flex items-center gap-2">
            {status === 'connected' ? (
              <CheckCircle2 className="size-4 text-primary" />
            ) : (
              <XCircle className="size-4 text-red-500" />
            )}
            <AlertTitle className="text-foreground mb-0">
              {status === 'connected'
                ? `Connected${phone ? ` as ${phone}` : ''}`
                : status === 'qr_pending'
                  ? 'Scan to connect'
                  : 'Not connected'}
            </AlertTitle>
          </div>
          <AlertDescription className="text-muted-foreground">
            {status === 'connected'
              ? 'Messages send and receive through this number.'
              : status === 'qr_pending'
                ? 'Open WhatsApp on your phone → Linked Devices → Link a Device, then scan the code below.'
                : 'Click Connect to generate a QR code and link your WhatsApp number.'}
          </AlertDescription>
        </Alert>

        <Card>
          <CardHeader>
            <CardTitle className="text-foreground">Connection</CardTitle>
            <CardDescription className="text-muted-foreground">
              Each account links one personal WhatsApp number via the bridge service.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {qr && status === 'qr_pending' && (
              <div className="flex justify-center rounded border border-border bg-card/60 p-4">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={qr} alt="WhatsApp pairing QR code" className="size-56" />
              </div>
            )}

            <div className="flex flex-wrap gap-3">
              {status !== 'connected' && (
                <Button
                  onClick={handleConnect}
                  disabled={pairing}
                  className="bg-primary hover:bg-primary/90 text-primary-foreground"
                >
                  {pairing ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      Generating QR...
                    </>
                  ) : (
                    <>
                      <QrCode className="size-4" />
                      {status === 'qr_pending' ? 'Refresh QR' : 'Connect'}
                    </>
                  )}
                </Button>
              )}
              {status === 'connected' && (
                <Button
                  variant="outline"
                  onClick={handleDisconnect}
                  disabled={disconnecting}
                  className="border-red-900 text-red-400 hover:text-red-300 hover:bg-red-950/40"
                >
                  {disconnecting ? (
                    <>
                      <Loader2 className="size-4 animate-spin" />
                      Disconnecting...
                    </>
                  ) : (
                    <>
                      <RotateCcw className="size-4" />
                      Disconnect
                    </>
                  )}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
