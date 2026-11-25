import { describe, expect, it } from 'vitest';
import {
  CircuitBreakers,
  IntegrationError,
  SealedValueError,
  assessHealth,
  backoffMs,
  checkCredentialFields,
  decideRetry,
  errorForStatus,
  idempotencyKey,
  isEnvelope,
  isPrivateAddress,
  hostAllowed,
  makeEnvelope,
  maskSecrets,
  needsRotation,
  newKeyringEntry,
  openCredentials,
  ownerMessage,
  parseKeyring,
  parseRetryAfter,
  pickCredentials,
  reconcileById,
  safeEqual,
  safeFetch,
  sealCredentials,
  signWebhook,
  verifyWebhook,
  generateWebhookSecret,
  DEFAULT_RETRY,
  type ConnectorManifest,
} from '../src/index.js';

describe('errors', () => {
  it('classifies platform statuses', () => {
    expect(errorForStatus(200)).toBeNull();
    expect(errorForStatus(401)?.cls).toBe('auth');
    expect(errorForStatus(403)?.cls).toBe('auth');
    expect(errorForStatus(429, { retryAfter: '30' })).toMatchObject({ cls: 'rate_limited', retryAfterMs: 30_000 });
    expect(errorForStatus(503)?.cls).toBe('retryable');
    expect(errorForStatus(408)?.cls).toBe('retryable');
    expect(errorForStatus(400)?.cls).toBe('permanent');
    expect(errorForStatus(404)?.code).toBe('not_found');
  });
  it('reads Retry-After as seconds or a date', () => {
    const now = new Date('2026-11-25T10:00:00Z');
    expect(parseRetryAfter('12', now)).toBe(12_000);
    expect(parseRetryAfter('Wed, 25 Nov 2026 10:01:00 GMT', now)).toBe(60_000);
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });
});

describe('retry', () => {
  const now = new Date('2026-11-25T10:00:00Z');
  it('backs off exponentially with jitter, capped', () => {
    expect(backoffMs(1, DEFAULT_RETRY, () => 0)).toBe(5_000);
    expect(backoffMs(1, DEFAULT_RETRY, () => 1)).toBe(10_000);
    expect(backoffMs(3, DEFAULT_RETRY, () => 1)).toBe(40_000);
    expect(backoffMs(40, DEFAULT_RETRY, () => 1)).toBe(DEFAULT_RETRY.capMs);
  });
  it('never retries permanent or auth errors, and stops when exhausted', () => {
    expect(decideRetry(new IntegrationError('x', 'x', 'permanent'), 1, DEFAULT_RETRY, now)).toEqual({ action: 'dead', reason: 'permanent' });
    expect(decideRetry(new IntegrationError('x', 'x', 'auth'), 1, DEFAULT_RETRY, now)).toEqual({ action: 'dead', reason: 'auth' });
    expect(decideRetry(new IntegrationError('x', 'x', 'retryable'), DEFAULT_RETRY.maxAttempts, DEFAULT_RETRY, now)).toEqual({ action: 'dead', reason: 'exhausted' });
  });
  it('honours Retry-After when it is longer than the backoff', () => {
    const d = decideRetry(new IntegrationError('x', 'x', 'rate_limited', { retryAfterMs: 120_000 }), 1, DEFAULT_RETRY, now, () => 0);
    expect(d).toEqual({ action: 'retry', at: new Date(now.getTime() + 120_000) });
  });
  it('the default policy rides out about two and a half days', () => {
    let total = 0;
    for (let a = 1; a < DEFAULT_RETRY.maxAttempts; a++) total += backoffMs(a, DEFAULT_RETRY, () => 1);
    expect(total / 3_600_000).toBeGreaterThan(48);
    expect(total / 3_600_000).toBeLessThan(80);
  });
});

describe('circuit breaker', () => {
  it('opens after the threshold, lets one trial through after the wait, closes on success', () => {
    let t = 0;
    const b = new CircuitBreakers({ failureThreshold: 3, openMs: 1000 }, () => t);
    for (let i = 0; i < 3; i++) b.failure('k');
    expect(b.state('k')).toBe('open');
    expect(b.allow('k')).toBe(false);
    t = 1000;
    expect(b.state('k')).toBe('half_open');
    expect(b.allow('k')).toBe(true);
    expect(b.allow('k')).toBe(false); // only one trial
    b.success('k');
    expect(b.state('k')).toBe('closed');
  });
  it('a failed trial opens it again at once', () => {
    let t = 0;
    const b = new CircuitBreakers({ failureThreshold: 2, openMs: 1000 }, () => t);
    b.failure('k');
    b.failure('k');
    t = 1500;
    expect(b.allow('k')).toBe(true);
    b.failure('k');
    expect(b.state('k')).toBe('open');
    expect(b.retryAt('k')).toBe(2500);
  });
  it('keys are independent', () => {
    const b = new CircuitBreakers({ failureThreshold: 1, openMs: 1000 }, () => 0);
    b.failure('a');
    expect(b.allow('a')).toBe(false);
    expect(b.allow('b')).toBe(true);
  });
});

describe('envelope', () => {
  it('builds and recognises the stored format', () => {
    const e = makeEnvelope({ type: 'sufra.order.status_changed', tenant: 'r1', data: { status: 'ready' } });
    expect(e.fmt).toBe('vc1');
    expect(isEnvelope(JSON.parse(JSON.stringify(e)))).toBe(true);
    expect(isEnvelope({ ...e, fmt: 'vc2' })).toBe(false);
    expect(() => makeEnvelope({ type: 'bad', tenant: 'r1', data: 1 })).toThrow();
    expect(() => makeEnvelope({ type: 'a.b.c', tenant: '', data: 1 })).toThrow();
  });
});

describe('signatures', () => {
  const secret = generateWebhookSecret();
  const now = new Date('2026-11-25T10:00:00Z');
  it('signs and verifies a Standard Webhooks message', () => {
    const body = JSON.stringify({ hello: 'عالم' });
    const headers = signWebhook({ id: 'msg_1', body, secret, now });
    expect(verifyWebhook({ headers: { ...headers }, body, secrets: [secret], now })).toEqual({ ok: true, id: 'msg_1' });
  });
  it('rejects a changed body, a wrong secret, a stale or future timestamp, and missing headers', () => {
    const body = '{"a":1}';
    const headers = signWebhook({ id: 'm', body, secret, now });
    expect(verifyWebhook({ headers: { ...headers }, body: '{"a":2}', secrets: [secret], now })).toEqual({ ok: false, code: 'bad_signature' });
    expect(verifyWebhook({ headers: { ...headers }, body, secrets: [generateWebhookSecret()], now })).toEqual({ ok: false, code: 'bad_signature' });
    expect(verifyWebhook({ headers: { ...headers }, body, secrets: [secret], now: new Date(now.getTime() + 6 * 60_000) })).toEqual({ ok: false, code: 'stale' });
    expect(verifyWebhook({ headers: { ...headers }, body, secrets: [secret], now: new Date(now.getTime() - 6 * 60_000) })).toEqual({ ok: false, code: 'stale' });
    expect(verifyWebhook({ headers: {}, body, secrets: [secret], now })).toEqual({ ok: false, code: 'missing_headers' });
  });
  it('accepts either secret during a rotation', () => {
    const next = generateWebhookSecret();
    const body = 'x';
    const headers = signWebhook({ id: 'm', body, secret: next, now });
    expect(verifyWebhook({ headers: { ...headers }, body, secrets: [secret, next], now }).ok).toBe(true);
  });
  it('safeEqual compares exactly', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('credential encryption', () => {
  const ring = parseKeyring([newKeyringEntry('k2'), newKeyringEntry('k1')].join(';'));
  it('round-trips and binds the tenant and the purpose', () => {
    const sealed = sealCredentials(ring, 'r1', 'paymob', { apiKey: 'secret-1' });
    expect(sealed.startsWith('vcs1.k2.')).toBe(true);
    expect(sealed).not.toContain('secret-1');
    expect(openCredentials(ring, 'r1', 'paymob', sealed)).toEqual({ apiKey: 'secret-1' });
    expect(() => openCredentials(ring, 'r2', 'paymob', sealed)).toThrow(SealedValueError);
    expect(() => openCredentials(ring, 'r1', 'whatsapp', sealed)).toThrow(SealedValueError);
  });
  it('detects tampering and unknown keys', () => {
    const sealed = sealCredentials(ring, 'r1', 'p', { a: 1 });
    const parts = sealed.split('.');
    parts[4] = Buffer.from('xxxx').toString('base64url');
    expect(() => openCredentials(ring, 'r1', 'p', parts.join('.'))).toThrow(SealedValueError);
    const other = parseKeyring(newKeyringEntry('k9'));
    expect(() => openCredentials(other, 'r1', 'p', sealed)).toThrow(/unknown_key/);
    expect(() => openCredentials(ring, 'r1', 'p', 'plain')).toThrow(/format/);
  });
  it('rotation: old values still open, and are flagged for re-sealing', () => {
    const oldRing = { current: 'k1', keys: ring.keys };
    const sealed = sealCredentials(oldRing, 'r1', 'p', { a: 1 });
    expect(needsRotation(ring, sealed)).toBe(true);
    expect(openCredentials(ring, 'r1', 'p', sealed)).toEqual({ a: 1 });
    expect(needsRotation(ring, sealCredentials(ring, 'r1', 'p', { a: 1 }))).toBe(false);
  });
  it('refuses a bad keyring', () => {
    expect(() => parseKeyring('')).toThrow();
    expect(() => parseKeyring('k1:short')).toThrow(/32 bytes/);
    expect(() => parseKeyring(`${newKeyringEntry('k1')};${newKeyringEntry('k1')}`)).toThrow(/duplicate/);
  });
  it('masks secrets for display', () => {
    expect(maskSecrets({ apiKey: 'abcdef1234', publicKey: 'pk_x', integrationIds: '1,2' }, ['apiKey'])).toEqual({ apiKey: '••••1234', publicKey: '••••', integrationIds: '1,2' });
  });
});

describe('safe outbound calls', () => {
  const ok = async () => new Response('{"ok":true}', { status: 200 });
  it('flags private and internal addresses', () => {
    for (const ip of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.5.5', '192.168.1.1', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '0.0.0.0'])
      expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ['8.8.8.8', '41.32.10.10', '2a00:1450:4001::200e']) expect(isPrivateAddress(ip), ip).toBe(false);
  });
  it('allows only listed hosts', () => {
    expect(hostAllowed('accept.paymob.com', ['accept.paymob.com'])).toBe(true);
    expect(hostAllowed('evil.com', ['accept.paymob.com'])).toBe(false);
    expect(hostAllowed('api.example.com', ['.example.com'])).toBe(true);
    expect(hostAllowed('example.com', ['.example.com'])).toBe(false);
    expect(hostAllowed('badexample.com', ['.example.com'])).toBe(false);
  });
  it('refuses http, unlisted hosts and private resolutions before calling', async () => {
    let called = 0;
    const fetchImpl = (async () => {
      called += 1;
      return new Response('{}');
    }) as typeof fetch;
    await expect(safeFetch('http://accept.paymob.com/x', {}, { allowHosts: ['accept.paymob.com'], fetchImpl })).rejects.toMatchObject({ code: 'insecure_url' });
    await expect(safeFetch('https://evil.com/x', {}, { allowHosts: ['accept.paymob.com'], fetchImpl })).rejects.toMatchObject({ code: 'host_not_allowed' });
    await expect(
      safeFetch('https://accept.paymob.com/x', {}, { allowHosts: ['accept.paymob.com'], fetchImpl, lookup: async () => ['10.1.1.1'] }),
    ).rejects.toMatchObject({ code: 'private_address' });
    expect(called).toBe(0);
  });
  it('returns the body on success and classifies failures', async () => {
    const opts = { allowHosts: ['api.test'], lookup: async () => ['8.8.8.8'] };
    const res = await safeFetch('https://api.test/x', {}, { ...opts, fetchImpl: ok as typeof fetch });
    expect(res.json()).toEqual({ ok: true });
    await expect(safeFetch('https://api.test/x', {}, { ...opts, fetchImpl: (async () => new Response('no', { status: 401 })) as typeof fetch })).rejects.toMatchObject({ cls: 'auth' });
    await expect(safeFetch('https://api.test/x', {}, { ...opts, fetchImpl: (async () => new Response('x', { status: 502 })) as typeof fetch })).rejects.toMatchObject({ cls: 'retryable' });
    await expect(
      safeFetch('https://api.test/x', {}, { ...opts, fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch }),
    ).rejects.toMatchObject({ code: 'network', cls: 'retryable' });
  });
  it('caps the response size', async () => {
    const big = (async () => new Response('x'.repeat(2000), { status: 200 })) as typeof fetch;
    await expect(safeFetch('https://api.test/x', {}, { allowHosts: ['api.test'], lookup: async () => ['8.8.8.8'], fetchImpl: big, maxBytes: 1000 })).rejects.toMatchObject({ code: 'too_large' });
  });
});

describe('health', () => {
  const now = new Date('2026-11-25T12:00:00Z');
  const base = { status: 'active' as const, now, lastSuccessAt: now, lastErrorAt: null, lastErrorCode: null, pendingOut: 0, pendingIn: 0, dead: 0, oldestPendingAt: null, breakerOpen: false, silenceAlertMs: null };
  it('is ok when nothing is wrong', () => expect(assessHealth(base)).toEqual({ level: 'ok', reasons: [] }));
  it('is down when the owner must act or the platform keeps failing', () => {
    expect(assessHealth({ ...base, status: 'needs_owner' }).level).toBe('down');
    expect(assessHealth({ ...base, breakerOpen: true }).level).toBe('down');
  });
  it('warns on dead letters, a backlog and a silent busy channel', () => {
    expect(assessHealth({ ...base, dead: 2 }).reasons[0]?.code).toBe('dead_letters');
    expect(assessHealth({ ...base, pendingOut: 3, oldestPendingAt: new Date(now.getTime() - 20 * 60_000) }).level).toBe('warning');
    expect(assessHealth({ ...base, lastSuccessAt: new Date(now.getTime() - 3 * 3600_000), silenceAlertMs: 60 * 60_000 }).reasons.map((r) => r.code)).toContain('silent');
  });
  it('paused and disconnected are not alarms', () => {
    expect(assessHealth({ ...base, status: 'paused', dead: 5 }).level).toBe('paused');
    expect(assessHealth({ ...base, status: 'disconnected' }).level).toBe('off');
  });
});

describe('owner messages and credential fields', () => {
  it('falls back to a generic message and lets connectors override', () => {
    expect(ownerMessage('auth_failed').action).toBe('update_credentials');
    expect(ownerMessage('no_such_code').text).toContain('غير متوقع');
    expect(ownerMessage('x', { x: { text: 'خاص' } }).text).toBe('خاص');
  });
  const manifest: ConnectorManifest = {
    id: 't', nameAr: 'تجربة', nameEn: 'Test', version: '1', kind: 'payments', activation: 'keys', capabilities: [], verifiedAgainst: 'docs',
    credentialFields: [
      { key: 'apiKey', labelAr: 'المفتاح', secret: true },
      { key: 'ids', labelAr: 'الأرقام', secret: false, pattern: '^\\d+(,\\d+)*$' },
      { key: 'note', labelAr: 'ملاحظة', secret: false, optional: true },
    ],
  };
  it('checks required fields and patterns, and drops unknown input', () => {
    expect(checkCredentialFields(manifest, { apiKey: 'a', ids: '1,2' })).toEqual([]);
    expect(checkCredentialFields(manifest, { ids: '1,x' })).toEqual(['apiKey', 'ids']);
    expect(pickCredentials(manifest, { apiKey: ' a ', ids: '1', evil: 'x' })).toEqual({ apiKey: 'a', ids: '1' });
  });
});

describe('reconciliation', () => {
  it('finds what the platform has and we do not, and the other way round', () => {
    const r = reconcileById([{ id: 'a' }, { id: 'b' }, { id: 'c' }], (x) => x.id, ['a', 'z']);
    expect(r.missing.map((x) => x.id)).toEqual(['b', 'c']);
    expect(r.unknown).toEqual(['z']);
  });
  it('idempotency keys are stable and distinct', () => {
    expect(idempotencyKey('r1', 'order', 5)).toBe(idempotencyKey('r1', 'order', 5));
    expect(idempotencyKey('r1', 'order', 5)).not.toBe(idempotencyKey('r1', 'order', 6));
    expect(idempotencyKey('a', 'bc')).not.toBe(idempotencyKey('ab', 'c'));
  });
});
