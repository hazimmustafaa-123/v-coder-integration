import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Constant-time comparison of two strings of any length (both are hashed first, so the lengths leak nothing either). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

export function hmacHex(algorithm: 'sha256' | 'sha512', key: string | Buffer, data: string | Buffer): string {
  return createHmac(algorithm, key).update(data).digest('hex');
}

export function hmacBase64(algorithm: 'sha256' | 'sha512', key: string | Buffer, data: string | Buffer): string {
  return createHmac(algorithm, key).update(data).digest('base64');
}

/**
 * Standard Webhooks (https://www.standardwebhooks.com): the scheme we use wherever WE choose how a message is signed — the delivery
 * simulator, and any future outgoing webhook. Headers `webhook-id`, `webhook-timestamp` (seconds), `webhook-signature` = space-separated
 * `v1,<base64 HMAC-SHA256 of "id.timestamp.body">`. Secrets look like `whsec_<base64>`; the decoded bytes are the HMAC key.
 */
export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64')}`;
}

function secretKey(secret: string): Buffer {
  const raw = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  return Buffer.from(raw, 'base64');
}

export interface SignedWebhookHeaders {
  'webhook-id': string;
  'webhook-timestamp': string;
  'webhook-signature': string;
}

export function signWebhook(input: { id: string; body: string; secret: string; now?: Date }): SignedWebhookHeaders {
  const ts = Math.floor((input.now ?? new Date()).getTime() / 1000).toString();
  const sig = hmacBase64('sha256', secretKey(input.secret), `${input.id}.${ts}.${input.body}`);
  return { 'webhook-id': input.id, 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}` };
}

export type WebhookVerifyResult = { ok: true; id: string } | { ok: false; code: 'missing_headers' | 'stale' | 'bad_signature' };

/**
 * Verifies a Standard Webhooks message against one or more secrets (two during a rotation). `headers` keys must be lower case.
 * The timestamp must be within the tolerance on BOTH sides, so an old captured message cannot be replayed.
 */
export function verifyWebhook(input: {
  headers: Record<string, string | string[] | undefined>;
  body: string;
  secrets: string[];
  now?: Date;
  toleranceSeconds?: number;
}): WebhookVerifyResult {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const id = one(input.headers['webhook-id']);
  const ts = one(input.headers['webhook-timestamp']);
  const sigHeader = one(input.headers['webhook-signature']);
  if (!id || !ts || !sigHeader || !/^\d+$/.test(ts)) return { ok: false, code: 'missing_headers' };
  const now = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const tolerance = input.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
  if (Math.abs(now - Number(ts)) > tolerance) return { ok: false, code: 'stale' };
  const signed = `${id}.${ts}.${input.body}`;
  const offered = sigHeader
    .split(' ')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('v1,'))
    .map((s) => s.slice(3));
  for (const secret of input.secrets) {
    const expected = hmacBase64('sha256', secretKey(secret), signed);
    if (offered.some((o) => safeEqual(o, expected))) return { ok: true, id };
  }
  return { ok: false, code: 'bad_signature' };
}
