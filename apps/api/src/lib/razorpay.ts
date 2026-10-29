import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Config } from '../config';
import { AppError } from './errors';

// Razorpay Standard Checkout for plan upgrades: we create an order for an amount we computed, the
// owner pays in Razorpay's checkout, and we check the payment on our side before changing the
// plan. Raw REST with Basic auth; no SDK. Only our own Razorpay account is involved.

type RazorpayConfig = Pick<Config, 'RAZORPAY_KEY_ID' | 'RAZORPAY_KEY_SECRET' | 'RAZORPAY_API_URL'>;

export function razorpayConfigured(cfg: RazorpayConfig): boolean {
  return !!cfg.RAZORPAY_KEY_ID && !!cfg.RAZORPAY_KEY_SECRET;
}

async function call<T>(cfg: RazorpayConfig, method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  if (!cfg.RAZORPAY_KEY_ID || !cfg.RAZORPAY_KEY_SECRET) throw new AppError(409, 'not_configured', 'Online payment is not set up yet');
  let res: Response;
  try {
    res = await fetch(`${cfg.RAZORPAY_API_URL.replace(/\/+$/, '')}${path}`, {
      method,
      headers: {
        authorization: `Basic ${Buffer.from(`${cfg.RAZORPAY_KEY_ID}:${cfg.RAZORPAY_KEY_SECRET}`).toString('base64')}`,
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new AppError(502, 'payment_unavailable', 'Could not reach Razorpay. Try again in a minute.');
  }
  const json = (await res.json().catch(() => ({}))) as T & { error?: { description?: string } };
  if (!res.ok) throw new AppError(502, 'payment_unavailable', json.error?.description ?? `Razorpay answered ${res.status}`);
  return json;
}

export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  receipt: string;
  status: string;
}

export interface RazorpayPayment {
  id: string;
  order_id: string | null;
  amount: number;
  currency: string;
  /** created | authorized | captured | refunded | failed */
  status: string;
}

export function createOrder(cfg: RazorpayConfig, o: { amountPaise: number; receipt: string; notes: Record<string, string> }): Promise<RazorpayOrder> {
  return call<RazorpayOrder>(cfg, 'POST', '/orders', { amount: o.amountPaise, currency: 'INR', receipt: o.receipt, notes: o.notes });
}

export function fetchPayment(cfg: RazorpayConfig, paymentId: string): Promise<RazorpayPayment> {
  return call<RazorpayPayment>(cfg, 'GET', `/payments/${encodeURIComponent(paymentId)}`);
}

/** Captures an authorized payment, for accounts not set to capture automatically. */
export function capturePayment(cfg: RazorpayConfig, paymentId: string, amountPaise: number): Promise<RazorpayPayment> {
  return call<RazorpayPayment>(cfg, 'POST', `/payments/${encodeURIComponent(paymentId)}/capture`, { amount: amountPaise, currency: 'INR' });
}

function sameHex(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Checkout's success signature: HMAC-SHA256 of "order_id|payment_id" with the key secret. */
export function verifyCheckoutSignature(keySecret: string, orderId: string, paymentId: string, signature: string): boolean {
  return sameHex(signature, createHmac('sha256', keySecret).update(`${orderId}|${paymentId}`).digest('hex'));
}

/** Webhook signature: HMAC-SHA256 of the exact raw body with the webhook secret. */
export function verifyWebhookSignature(webhookSecret: string, rawBody: string, signature: string): boolean {
  return sameHex(signature, createHmac('sha256', webhookSecret).update(rawBody).digest('hex'));
}
