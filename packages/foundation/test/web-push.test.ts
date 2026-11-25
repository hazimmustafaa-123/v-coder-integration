import { createDecipheriv, createECDH, createHmac, createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encryptPayload, generatePushKeys, sendPush, validSubscription, vapidAuthorization } from '../src/web-push.js';

const unb64u = (s: string) => Buffer.from(s, 'base64url');
const hmac = (k: Buffer, d: Buffer) => createHmac('sha256', k).update(d).digest();

/** what a browser does with a pushed message: RFC 8291 decryption with its own private key */
function decrypt(msg: Buffer, uaPrivate: string, auth: string): string {
  const salt = msg.subarray(0, 16), idlen = msg[20]!, asPublic = msg.subarray(21, 21 + idlen), body = msg.subarray(21 + idlen);
  const ua = createECDH('prime256v1');
  ua.setPrivateKey(unb64u(uaPrivate));
  const secret = ua.computeSecret(asPublic);
  const prkKey = hmac(unb64u(auth), secret);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0', 'latin1'), ua.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01', 'latin1')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01', 'latin1')).subarray(0, 12);
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(body.subarray(body.length - 16));
  const plain = Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]);
  expect(plain[plain.length - 1]).toBe(2); // the last-record delimiter
  return plain.subarray(0, plain.length - 1).toString();
}

describe('web push (RFC 8291 / RFC 8292)', () => {
  it('matches the RFC 8291 appendix A example byte for byte', () => {
    const out = encryptPayload(
      Buffer.from('When I grow up, I want to be a watermelon'),
      { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
      { privateKey: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw' },
      unb64u('DGv6ra1nlYgDCS1FRnbzlw'),
    );
    expect(out.toString('base64url')).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
  });

  it('a browser holding the private key reads what was sent', () => {
    const ua = generatePushKeys();
    const auth = Buffer.alloc(16, 7).toString('base64url');
    const msg = encryptPayload(Buffer.from('{"title":"طلبك جاهز"}'), { p256dh: ua.publicKey, auth });
    expect(decrypt(msg, ua.privateKey, auth)).toBe('{"title":"طلبك جاهز"}');
  });

  it('signs a VAPID token the push service can verify with the public key', () => {
    const keys = generatePushKeys();
    const h = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys, 'mailto:ops@example.com', 1_800_000_000);
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h)!;
    expect(m[4]).toBe(keys.publicKey);
    const claims = JSON.parse(unb64u(m[2]!).toString());
    expect(claims).toEqual({ aud: 'https://fcm.googleapis.com', exp: 1_800_000_000 + 43200, sub: 'mailto:ops@example.com' });
    const pub = unb64u(keys.publicKey);
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
    expect(verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: 'ieee-p1363' }, unb64u(m[3]!))).toBe(true);
  });

  it('accepts only an https endpoint with keys of the right size', () => {
    const ua = generatePushKeys();
    const auth = Buffer.alloc(16, 1).toString('base64url');
    expect(validSubscription({ endpoint: 'https://push.example/abc', keys: { p256dh: ua.publicKey, auth } })).not.toBeNull();
    expect(validSubscription({ endpoint: 'http://push.example/abc', keys: { p256dh: ua.publicKey, auth } })).toBeNull();
    expect(validSubscription({ endpoint: 'https://push.example/abc', keys: { p256dh: 'AAAA', auth } })).toBeNull();
    expect(validSubscription({ endpoint: 'https://push.example/abc', keys: { p256dh: ua.publicKey, auth: 'AAAA' } })).toBeNull();
    expect(validSubscription(null)).toBeNull();
  });

  it('reports a dropped subscription as gone and never throws', async () => {
    const ua = generatePushKeys();
    const sub = { endpoint: 'https://push.example/x', p256dh: ua.publicKey, auth: Buffer.alloc(16, 2).toString('base64url') };
    const keys = generatePushKeys();
    const seen: RequestInit[] = [];
    const ok = (async (_u: string, init: RequestInit) => { seen.push(init); return new Response(null, { status: 201 }); }) as unknown as typeof fetch;
    expect(await sendPush(sub, { t: 1 }, keys, 'mailto:a@b.c', ok)).toBe('sent');
    expect((seen[0]!.headers as Record<string, string>)['Content-Encoding']).toBe('aes128gcm');
    expect(await sendPush(sub, { t: 1 }, keys, 'mailto:a@b.c', (async () => new Response(null, { status: 410 })) as unknown as typeof fetch)).toBe('gone');
    expect(await sendPush(sub, { t: 1 }, keys, 'mailto:a@b.c', (async () => { throw new Error('down'); }) as unknown as typeof fetch)).toBe('failed');
  });
});
