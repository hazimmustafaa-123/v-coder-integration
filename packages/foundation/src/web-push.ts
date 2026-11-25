import { createECDH, createHmac, createCipheriv, createPrivateKey, randomBytes, sign } from 'node:crypto';

/**
 * Web Push without a provider and without a library: the browser's own push service (free, run by the browser maker) delivers a message
 * to a store page the customer allowed, even when the page is closed. Two standards are all it takes, both done here with node:crypto:
 *  - RFC 8292 (VAPID): the server proves who it is with a short ES256 token signed by its own key pair (made once, kept on our server);
 *  - RFC 8291 (aes128gcm): the message is encrypted for that one browser, so the push service never reads it.
 * Nothing here is sent to any party but the push service the browser itself named in its subscription.
 */

export interface PushKeys {
  /** uncompressed P-256 public key, base64url (65 bytes): what the browser is given to subscribe */
  publicKey: string;
  /** the private scalar, base64url (32 bytes) */
  privateKey: string;
}

export interface PushSubscriptionKeys {
  endpoint: string;
  /** the browser's P-256 public key, base64url (65 bytes) */
  p256dh: string;
  /** the browser's 16-byte auth secret, base64url */
  auth: string;
}

const b64u = (buf: Buffer): string => buf.toString('base64url');
const unb64u = (s: string): Buffer => Buffer.from(s, 'base64url');

export function generatePushKeys(): PushKeys {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

/** A subscription as the browser hands it over, checked for shape: an https endpoint and keys of the right lengths. */
export function validSubscription(raw: unknown): PushSubscriptionKeys | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const endpoint = typeof r.endpoint === 'string' ? r.endpoint : '';
  const p256dh = typeof r.keys?.p256dh === 'string' ? r.keys.p256dh : '';
  const auth = typeof r.keys?.auth === 'string' ? r.keys.auth : '';
  if (endpoint.length > 1000 || !/^https:\/\/[^\s/]+\//.test(endpoint)) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(p256dh) || !/^[A-Za-z0-9_-]+$/.test(auth)) return null;
  const pk = unb64u(p256dh);
  if (pk.length !== 65 || pk[0] !== 4 || unb64u(auth).length !== 16) return null;
  return { endpoint, p256dh, auth };
}

const hmac = (key: Buffer, data: Buffer): Buffer => createHmac('sha256', key).update(data).digest();

/**
 * RFC 8291 encryption of one message for one browser (a single record, aes128gcm). `ephemeral` and `salt` are for the RFC's own test
 * vector only; in use both are fresh for every message.
 */
export function encryptPayload(payload: Buffer, sub: Pick<PushSubscriptionKeys, 'p256dh' | 'auth'>, ephemeral?: { privateKey: string }, salt?: Buffer): Buffer {
  const uaPublic = unb64u(sub.p256dh);
  const authSecret = unb64u(sub.auth);
  const as = createECDH('prime256v1');
  if (ephemeral) as.setPrivateKey(unb64u(ephemeral.privateKey));
  else as.generateKeys();
  const asPublic = as.getPublicKey();
  const ecdhSecret = as.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), uaPublic, asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
  const s = salt ?? randomBytes(16);
  const prk = hmac(s, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'latin1')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'latin1')).subarray(0, 12);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([s, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

/** RFC 8292: the `Authorization` header for one push service (its origin is the audience), valid for 12 hours. */
export function vapidAuthorization(endpoint: string, keys: PushKeys, subject: string, nowSec: number = Math.floor(Date.now() / 1000)): string {
  const pub = unb64u(keys.publicKey);
  const jwk = { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) };
  const key = createPrivateKey({ key: jwk, format: 'jwk' });
  const head = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowSec + 12 * 3600, sub: subject })));
  const sig = sign('sha256', Buffer.from(`${head}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${keys.publicKey}`;
}

export type PushOutcome = 'sent' | 'gone' | 'failed';

/**
 * Sends one message. 'gone' = the browser dropped the subscription (404/410): the caller forgets it. A message is kept by the push
 * service for up to an hour if the phone is offline (an order update older than that is no longer news).
 */
export async function sendPush(sub: PushSubscriptionKeys, message: object, keys: PushKeys, subject: string, fetchImpl: typeof fetch = fetch): Promise<PushOutcome> {
  try {
    const res = await fetchImpl(sub.endpoint, {
      method: 'POST',
      headers: {
        TTL: '3600',
        Urgency: 'high',
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        Authorization: vapidAuthorization(sub.endpoint, keys, subject),
      },
      body: encryptPayload(Buffer.from(JSON.stringify(message)), sub),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404 || res.status === 410) return 'gone';
    return res.ok ? 'sent' : 'failed';
  } catch {
    return 'failed';
  }
}
