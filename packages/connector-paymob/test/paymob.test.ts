import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { checkCredentialFields } from '@v-coder/integration-kit';
import {
  PaymobClient,
  callbackHmac,
  integrationIdList,
  isTestMode,
  judgeTransaction,
  normalizeTransaction,
  paymobManifest,
  verifyRedirectQuery,
  verifyTransactionCallback,
  type PaymobCredentials,
} from '../src/index.js';

const creds: PaymobCredentials = {
  secretKey: 'egy_sk_test_abc123',
  publicKey: 'egy_pk_test_xyz789',
  apiKey: 'ZXlKaGJHY2lPaUpJVXpVeE1pSXNJblI1Y0NJNklrcFhWQ0o5',
  hmacSecret: 'HMACSECRET123',
  integrationIds: '4567, 8910',
};

/** A transaction callback shaped like Paymob's documented "transaction processed callback". */
const callbackObj = {
  id: 192036465,
  pending: false,
  amount_cents: 15050,
  success: true,
  is_auth: false,
  is_capture: false,
  is_standalone_payment: true,
  is_voided: false,
  is_refunded: false,
  is_3d_secure: true,
  integration_id: 4567,
  has_parent_transaction: false,
  order: { id: 217503754, merchant_order_id: 'pay_r1_ord42_1' },
  created_at: '2026-11-25T10:00:00.000000',
  currency: 'EGP',
  source_data: { pan: '2346', type: 'card', sub_type: 'MasterCard' },
  error_occured: false,
  owner: 302852,
};

const lookup = async () => ['8.8.8.8'];

describe('Paymob manifest and credentials', () => {
  it('validates the owner input', () => {
    expect(checkCredentialFields(paymobManifest, creds as unknown as Record<string, unknown>)).toEqual([]);
    expect(checkCredentialFields(paymobManifest, { ...creds, secretKey: 'abc', integrationIds: 'x' })).toEqual(['secretKey', 'integrationIds']);
  });
  it('reads the integration ids and the test mode', () => {
    expect(integrationIdList(creds)).toEqual([4567, 8910]);
    expect(isTestMode(creds)).toBe(true);
    expect(isTestMode({ secretKey: 'egy_sk_live_1' })).toBe(false);
  });
});

describe('callback signature', () => {
  it('matches an HMAC computed independently over the documented field order', () => {
    const o = callbackObj;
    const concatenated = [
      o.amount_cents, o.created_at, o.currency, o.error_occured, o.has_parent_transaction, o.id, o.integration_id, o.is_3d_secure, o.is_auth,
      o.is_capture, o.is_refunded, o.is_standalone_payment, o.is_voided, o.order.id, o.owner, o.pending, o.source_data.pan,
      o.source_data.sub_type, o.source_data.type, o.success,
    ].map(String).join('');
    const independent = createHmac('sha512', creds.hmacSecret).update(concatenated).digest('hex');
    expect(callbackHmac(o, creds.hmacSecret)).toBe(independent);
    expect(verifyTransactionCallback({ type: 'TRANSACTION', obj: o }, independent, creds.hmacSecret)).toBe(true);
    expect(verifyTransactionCallback({ type: 'TRANSACTION', obj: o }, independent.toUpperCase(), creds.hmacSecret)).toBe(true);
  });
  it('rejects a changed amount, a wrong secret, a missing hmac and other message types', () => {
    const good = callbackHmac(callbackObj, creds.hmacSecret);
    expect(verifyTransactionCallback({ type: 'TRANSACTION', obj: { ...callbackObj, amount_cents: 1 } }, good, creds.hmacSecret)).toBe(false);
    expect(verifyTransactionCallback({ type: 'TRANSACTION', obj: callbackObj }, good, 'other')).toBe(false);
    expect(verifyTransactionCallback({ type: 'TRANSACTION', obj: callbackObj }, undefined, creds.hmacSecret)).toBe(false);
    expect(verifyTransactionCallback({ type: 'TOKEN', obj: callbackObj }, good, creds.hmacSecret)).toBe(false);
  });
  it('checks the browser redirect query the same way', () => {
    const q: Record<string, unknown> = {
      amount_cents: '15050', created_at: callbackObj.created_at, currency: 'EGP', error_occured: 'false', has_parent_transaction: 'false',
      id: '192036465', integration_id: '4567', is_3d_secure: 'true', is_auth: 'false', is_capture: 'false', is_refunded: 'false',
      is_standalone_payment: 'true', is_voided: 'false', order: '217503754', owner: '302852', pending: 'false', 'source_data.pan': '2346',
      'source_data.sub_type': 'MasterCard', 'source_data.type': 'card', success: 'true',
    };
    q.hmac = callbackHmac(callbackObj, creds.hmacSecret);
    expect(verifyRedirectQuery(q, creds.hmacSecret)).toBe(true);
    expect(verifyRedirectQuery({ ...q, success: 'false' }, creds.hmacSecret)).toBe(false);
  });
});

describe('transactions', () => {
  it('normalises the state', () => {
    expect(normalizeTransaction({ obj: callbackObj })).toMatchObject({ transactionId: '192036465', reference: 'pay_r1_ord42_1', amountMinor: 15050, currency: 'EGP', state: 'paid', sourceType: 'card' });
    expect(normalizeTransaction({ ...callbackObj, success: false }).state).toBe('failed');
    expect(normalizeTransaction({ ...callbackObj, pending: true }).state).toBe('pending');
    expect(normalizeTransaction({ ...callbackObj, is_refunded: true }).state).toBe('refunded');
    expect(() => normalizeTransaction({})).toThrow();
  });
  it('accepts a payment only for the exact amount, currency and reference', () => {
    const tx = normalizeTransaction(callbackObj);
    const expected = { reference: 'pay_r1_ord42_1', amountMinor: 15050, currency: 'EGP' };
    expect(judgeTransaction(tx, expected)).toEqual({ outcome: 'paid' });
    expect(judgeTransaction(tx, { ...expected, amountMinor: 15000 })).toEqual({ outcome: 'mismatch', reason: 'amount' });
    expect(judgeTransaction(tx, { ...expected, reference: 'other' })).toEqual({ outcome: 'mismatch', reason: 'reference' });
    expect(judgeTransaction({ ...tx, state: 'failed' }, expected)).toEqual({ outcome: 'failed' });
  });
});

describe('client', () => {
  it('creates an intention with the right request and builds the checkout link', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetch = (async (url: URL | string, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ id: 'int_1', client_secret: 'egy_csk_test_999' }), { status: 201 });
    }) as typeof globalThis.fetch;
    const client = new PaymobClient(creds, { fetch, lookup });
    const res = await client.createIntention({
      amountMinor: 15050,
      currency: 'EGP',
      reference: 'pay_r1_ord42_1',
      items: [{ name: 'برجر', amountMinor: 15050, quantity: 1 }],
      customer: { firstName: 'أحمد', lastName: 'علي', phone: '+201001234567' },
      notificationUrl: 'https://r1.example/api/integrations/paymob/callback',
      redirectionUrl: 'https://r1.example/track/ABC',
    });
    expect(res.checkoutUrl).toBe('https://accept.paymob.com/unifiedcheckout/?publicKey=egy_pk_test_xyz789&clientSecret=egy_csk_test_999');
    expect(calls[0]!.url).toBe('https://accept.paymob.com/v1/intention/');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Token egy_sk_test_abc123');
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toMatchObject({ amount: 15050, currency: 'EGP', payment_methods: [4567, 8910], special_reference: 'pay_r1_ord42_1' });
  });
  it('refuses a bad amount before any call', async () => {
    const client = new PaymobClient(creds, { fetch: (async () => { throw new Error('should not be called'); }) as typeof globalThis.fetch, lookup });
    await expect(client.createIntention({ amountMinor: 0, currency: 'EGP', reference: 'r', items: [], customer: { firstName: '', lastName: '', phone: '' }, notificationUrl: '', redirectionUrl: '' })).rejects.toMatchObject({ code: 'bad_amount' });
  });
  it('caches the auth token and fetches a transaction with it', async () => {
    let tokenCalls = 0;
    const fetch = (async (url: URL | string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/api/auth/tokens')) {
        tokenCalls += 1;
        return new Response(JSON.stringify({ token: 'tok' }), { status: 201 });
      }
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tok');
      return new Response(JSON.stringify(callbackObj), { status: 200 });
    }) as typeof globalThis.fetch;
    const client = new PaymobClient(creds, { fetch, lookup });
    expect((await client.getTransaction('192036465')).state).toBe('paid');
    await client.getTransaction('192036465');
    expect(tokenCalls).toBe(1);
  });
  it('the connection test reports a refused key in the owner’s terms', async () => {
    const client = new PaymobClient(creds, { fetch: (async () => new Response('{"detail":"incorrect credentials"}', { status: 403 })) as typeof globalThis.fetch, lookup });
    expect(await client.testConnection()).toMatchObject({ ok: false, code: 'auth_failed' });
    const ok = new PaymobClient(creds, { fetch: (async () => new Response('{"token":"t"}', { status: 201 })) as typeof globalThis.fetch, lookup });
    expect(await ok.testConnection()).toEqual({ ok: true, accountLabel: 'وضع تجريبي' });
  });
});
