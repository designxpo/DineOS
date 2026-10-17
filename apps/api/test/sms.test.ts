import { describe, expect, it } from 'vitest';
import { msg91Sender } from '../src/lib/sms';

type Call = { url: URL; init: RequestInit };

function fakeFetch(reply: { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const fn = (async (url: URL, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('MSG91 one-time codes', () => {
  it('asks MSG91 to deliver our code through the DLT template, valid ten minutes', async () => {
    const f = fakeFetch({ body: { type: 'success', request_id: 'abc' } });
    await msg91Sender({ authKey: 'key-123', templateId: 'tmpl-9' }, f.fn).send('+919876500070', '482913');
    expect(f.calls).toHaveLength(1);
    const { url, init } = f.calls[0]!;
    expect(`${url.origin}${url.pathname}`).toBe('https://control.msg91.com/api/v5/otp');
    expect(init.method).toBe('POST');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ template_id: 'tmpl-9', mobile: '919876500070', otp: '482913', otp_expiry: '10' });
    expect((init.headers as Record<string, string>).authkey).toBe('key-123');
  });

  it('reports a failed send instead of pretending the code went out', async () => {
    const refused = fakeFetch({ body: { type: 'error', message: 'Invalid template' } });
    await expect(msg91Sender({ authKey: 'k', templateId: 't' }, refused.fn).send('+919876500070', '111111')).rejects.toMatchObject({ code: 'sms_failed' });
    const down = fakeFetch({ status: 503, body: {} });
    await expect(msg91Sender({ authKey: 'k', templateId: 't' }, down.fn).send('+919876500070', '111111')).rejects.toMatchObject({ code: 'sms_failed' });
  });
});
