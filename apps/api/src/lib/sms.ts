import { AppError } from './errors';

/** Sends a one-time code by SMS. Mezmitra makes and checks the code; the sender only delivers it. */
export interface OtpSender {
  send(phone: string, code: string): Promise<void>;
}

/**
 * MSG91's OTP API with our own code (`otp`), through the DLT-registered template, which must
 * contain ##OTP##. `phone` is +91XXXXXXXXXX; MSG91 wants the digits with the country code.
 */
export function msg91Sender(cfg: { authKey: string; templateId: string }, fetchFn: typeof fetch = fetch): OtpSender {
  return {
    async send(phone, code) {
      const url = new URL('https://control.msg91.com/api/v5/otp');
      url.searchParams.set('template_id', cfg.templateId);
      url.searchParams.set('mobile', phone.replace(/^\+/, ''));
      url.searchParams.set('otp', code);
      url.searchParams.set('otp_expiry', '10');
      let ok = false;
      try {
        const res = await fetchFn(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authkey: cfg.authKey },
          body: '{}',
          signal: AbortSignal.timeout(8000),
        });
        const body = (await res.json().catch(() => null)) as { type?: string } | null;
        ok = res.ok && body?.type === 'success';
      } catch {
        ok = false;
      }
      if (!ok) throw new AppError(502, 'sms_failed', 'Could not send the code. Try again in a minute.');
    },
  };
}
