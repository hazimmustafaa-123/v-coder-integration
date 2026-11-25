import {
  IntegrationError,
  hmacHex,
  safeEqual,
  safeFetch,
  type ConnectionTest,
  type ConnectorManifest,
  type OwnerMessage,
  type SafeFetchOptions,
} from '@v-coder/integration-kit';

/**
 * Paymob (Accept) for Egypt — written from Paymob's public developer documentation (developers.paymob.com). verifiedAgainst = 'docs':
 * every request and callback shape below must be confirmed against a Paymob test account before the first real restaurant uses it
 * (see docs/connectors/paymob.md for the checklist).
 *
 * Model (decision ق-ت4): every merchant connects THEIR OWN Paymob account; money goes from the customer to the merchant through Paymob,
 * never through V CODER.
 */
export const PAYMOB_VERSION = '0.1.0';
export const PAYMOB_HOST = 'accept.paymob.com';

export const paymobManifest: ConnectorManifest = {
  id: 'paymob',
  nameAr: 'Paymob',
  nameEn: 'Paymob',
  version: PAYMOB_VERSION,
  kind: 'payments',
  activation: 'keys',
  capabilities: ['payments.checkout', 'payments.callback', 'payments.confirm', 'payments.refund'],
  verifiedAgainst: 'docs',
  docsUrl: 'https://developers.paymob.com/egypt',
  credentialFields: [
    { key: 'secretKey', labelAr: 'المفتاح السري (Secret Key)', secret: true, pattern: '^[a-z]{3}_sk_[A-Za-z0-9_]+$', helpAr: 'من لوحة Paymob: الإعدادات ← مفاتيح الحساب. يبدأ بـ egy_sk_' },
    { key: 'publicKey', labelAr: 'المفتاح العام (Public Key)', secret: false, pattern: '^[a-z]{3}_pk_[A-Za-z0-9_]+$', helpAr: 'من نفس الصفحة. يبدأ بـ egy_pk_' },
    { key: 'apiKey', labelAr: 'مفتاح API', secret: true, helpAr: 'من لوحة Paymob: الإعدادات ← مفتاح API (نص طويل)' },
    { key: 'hmacSecret', labelAr: 'سر HMAC', secret: true, helpAr: 'من لوحة Paymob: الإعدادات ← HMAC' },
    { key: 'integrationIds', labelAr: 'أرقام وسائل الدفع (Integration IDs)', secret: false, pattern: '^\\d+(\\s*,\\s*\\d+)*$', helpAr: 'من لوحة Paymob: Payment Integrations. رقم لكل وسيلة (كارت، محفظة) مفصولة بفاصلة' },
  ],
};

export const paymobMessages: Record<string, OwnerMessage> = {
  auth_failed: { text: 'Paymob رفض المفاتيح. اتأكد إنك نسخت المفتاح السري ومفتاح API صح، أو إنها ما اتغيرتش من لوحة Paymob.', action: 'update_credentials' },
  amount_mismatch: { text: 'مبلغ الدفع في Paymob مختلف عن مبلغ الطلب. الطلب ما اتأكدش، راجع العملية في لوحة Paymob.', action: 'none' },
  bad_hmac: { text: 'وصلتنا رسالة دفع توقيعها غلط واتجاهلت. لو بيتكرر، اتأكد من «سر HMAC».', action: 'update_credentials' },
};

export interface PaymobCredentials {
  secretKey: string;
  publicKey: string;
  apiKey: string;
  hmacSecret: string;
  /** Comma-separated integration ids (one per payment method enabled on the merchant's account). */
  integrationIds: string;
}

export function integrationIdList(creds: Pick<PaymobCredentials, 'integrationIds'>): number[] {
  return creds.integrationIds
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/** A secret key containing `_test_` belongs to Paymob's test mode: the owner screen shows it, and real orders must not use it. */
export function isTestMode(creds: Pick<PaymobCredentials, 'secretKey'>): boolean {
  return /_sk_test_/.test(creds.secretKey);
}

export interface IntentionInput {
  amountMinor: number;
  currency: 'EGP';
  /** Our reference for the payment (unique per attempt); comes back on the callback so we can find the order. */
  reference: string;
  items: { name: string; amountMinor: number; quantity: number }[];
  customer: { firstName: string; lastName: string; phone: string; email?: string };
  notificationUrl: string;
  redirectionUrl: string;
  /** Seconds the link stays valid. */
  expiresInSeconds?: number;
}

export interface Intention {
  intentionId: string;
  clientSecret: string;
  checkoutUrl: string;
}

export type PaymentState = 'paid' | 'pending' | 'failed' | 'refunded' | 'voided';

export interface PaymobTransaction {
  transactionId: string;
  paymobOrderId: string;
  /** Our reference as Paymob echoes it (merchant order id / special reference). */
  reference: string | null;
  amountMinor: number;
  currency: string;
  state: PaymentState;
  integrationId: number | null;
  sourceType: string | null;
}

export interface PaymobClientOptions {
  fetch?: SafeFetchOptions['fetchImpl'];
  lookup?: SafeFetchOptions['lookup'];
  /** Only for local simulations. */
  baseUrl?: string;
  allowInsecureLocalForTests?: boolean;
  now?: () => Date;
}

export class PaymobClient {
  private token: { value: string; at: number } | null = null;
  private readonly base: string;

  constructor(
    private readonly creds: PaymobCredentials,
    private readonly opts: PaymobClientOptions = {},
  ) {
    this.base = opts.baseUrl ?? `https://${PAYMOB_HOST}`;
  }

  private fetchOpts(): SafeFetchOptions {
    return {
      allowHosts: [PAYMOB_HOST],
      timeoutMs: 15_000,
      ...(this.opts.fetch ? { fetchImpl: this.opts.fetch } : {}),
      ...(this.opts.lookup ? { lookup: this.opts.lookup } : {}),
      ...(this.opts.allowInsecureLocalForTests ? { allowInsecureLocalForTests: true } : {}),
    };
  }

  private async post(path: string, body: unknown, auth: string): Promise<unknown> {
    const res = await safeFetch(`${this.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: auth }, body: JSON.stringify(body) }, this.fetchOpts());
    return res.json();
  }

  /** The short-lived token for the older Accept endpoints (transaction lookups, refunds); cached for 50 minutes. */
  async authToken(): Promise<string> {
    const now = (this.opts.now?.() ?? new Date()).getTime();
    if (this.token && now - this.token.at < 50 * 60_000) return this.token.value;
    const res = (await this.post('/api/auth/tokens', { api_key: this.creds.apiKey }, '')) as { token?: unknown };
    if (typeof res.token !== 'string' || res.token === '') throw new IntegrationError('bad_response', 'Paymob did not return a token', 'retryable');
    this.token = { value: res.token, at: now };
    return res.token;
  }

  /** Creates a payment intention and returns the hosted checkout link to send the customer to. */
  async createIntention(input: IntentionInput): Promise<Intention> {
    if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) throw new IntegrationError('bad_amount', 'amount must be a positive whole number of piastres', 'permanent');
    const methods = integrationIdList(this.creds);
    if (methods.length === 0) throw new IntegrationError('no_methods', 'no Paymob integration id is configured', 'permanent');
    const body = {
      amount: input.amountMinor,
      currency: input.currency,
      payment_methods: methods,
      items: input.items.map((i) => ({ name: i.name.slice(0, 50), amount: i.amountMinor, quantity: i.quantity })),
      billing_data: {
        first_name: input.customer.firstName || 'NA',
        last_name: input.customer.lastName || 'NA',
        phone_number: input.customer.phone,
        email: input.customer.email ?? 'NA',
      },
      special_reference: input.reference,
      notification_url: input.notificationUrl,
      redirection_url: input.redirectionUrl,
      ...(input.expiresInSeconds ? { expiration: input.expiresInSeconds } : {}),
    };
    const res = (await this.post('/v1/intention/', body, `Token ${this.creds.secretKey}`)) as { id?: unknown; client_secret?: unknown };
    if (typeof res.client_secret !== 'string') throw new IntegrationError('bad_response', 'Paymob intention without client_secret', 'retryable');
    return {
      intentionId: String(res.id ?? ''),
      clientSecret: res.client_secret,
      checkoutUrl: checkoutUrl(this.creds.publicKey, res.client_secret),
    };
  }

  async getTransaction(transactionId: string): Promise<PaymobTransaction> {
    if (!/^\d+$/.test(transactionId)) throw new IntegrationError('bad_id', 'transaction id must be numeric', 'permanent');
    const token = await this.authToken();
    const res = await safeFetch(`${this.base}/api/acceptance/transactions/${transactionId}`, { method: 'GET', headers: { authorization: `Bearer ${token}` } }, this.fetchOpts());
    return normalizeTransaction(res.json());
  }

  /** Finds the transactions Paymob has for OUR reference (used by the reconciliation when a callback never arrived). */
  async inquireByReference(reference: string): Promise<PaymobTransaction | null> {
    const token = await this.authToken();
    try {
      const res = await this.post('/api/ecommerce/orders/transaction_inquiry', { merchant_order_id: reference }, `Bearer ${token}`);
      return normalizeTransaction(res);
    } catch (error) {
      if (error instanceof IntegrationError && error.code === 'not_found') return null;
      throw error;
    }
  }

  async refund(transactionId: string, amountMinor: number): Promise<PaymobTransaction> {
    const token = await this.authToken();
    const res = await this.post('/api/acceptance/void_refund/refund', { transaction_id: transactionId, amount_cents: amountMinor }, `Bearer ${token}`);
    return normalizeTransaction(res);
  }

  /** The owner screen's «اختبر الاتصال»: the API key must give a token. (The secret key is proven by the first real intention.) */
  async testConnection(): Promise<ConnectionTest> {
    try {
      await this.authToken();
      return { ok: true, accountLabel: isTestMode(this.creds) ? 'وضع تجريبي' : 'وضع فعلي' };
    } catch (error) {
      const e = error instanceof IntegrationError ? error : new IntegrationError('unexpected', String(error), 'retryable');
      return { ok: false, code: e.code, detail: e.message };
    }
  }
}

export function checkoutUrl(publicKey: string, clientSecret: string): string {
  return `https://${PAYMOB_HOST}/unifiedcheckout/?publicKey=${encodeURIComponent(publicKey)}&clientSecret=${encodeURIComponent(clientSecret)}`;
}

/**
 * The fields Paymob signs on a transaction callback, in Paymob's documented order. The HMAC (SHA-512, key = the merchant's HMAC secret,
 * hex) is over the plain concatenation of their values; booleans are written "true"/"false". It is sent as the `hmac` query parameter.
 */
export const HMAC_FIELDS = [
  'amount_cents',
  'created_at',
  'currency',
  'error_occured',
  'has_parent_transaction',
  'id',
  'integration_id',
  'is_3d_secure',
  'is_auth',
  'is_capture',
  'is_refunded',
  'is_standalone_payment',
  'is_voided',
  'order.id',
  'owner',
  'pending',
  'source_data.pan',
  'source_data.sub_type',
  'source_data.type',
  'success',
] as const;

function pick(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function asText(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

export function callbackHmac(obj: unknown, hmacSecret: string): string {
  return hmacHex('sha512', hmacSecret, HMAC_FIELDS.map((f) => asText(pick(obj, f))).join(''));
}

/** Checks a transaction callback (`{ type: 'TRANSACTION', obj }` body + `?hmac=`) against the merchant's HMAC secret. */
export function verifyTransactionCallback(body: unknown, hmacFromQuery: unknown, hmacSecret: string): boolean {
  if (typeof hmacFromQuery !== 'string' || hmacFromQuery === '' || !hmacSecret) return false;
  const b = body as { type?: unknown; obj?: unknown };
  if (b?.type !== 'TRANSACTION' || typeof b.obj !== 'object' || b.obj === null) return false;
  return safeEqual(callbackHmac(b.obj, hmacSecret), hmacFromQuery.toLowerCase());
}

/**
 * The customer's browser comes back to the redirection URL with the same fields flattened into the query string (`order` instead of
 * `order.id`, `source_data.pan` as is). Used only to show the right page; the order is confirmed by the callback/query, never by this.
 */
export function verifyRedirectQuery(query: Record<string, unknown>, hmacSecret: string): boolean {
  const text = HMAC_FIELDS.map((f) => asText(f === 'order.id' ? query.order : query[f])).join('');
  const expected = hmacHex('sha512', hmacSecret, text);
  return typeof query.hmac === 'string' && safeEqual(expected, query.hmac.toLowerCase());
}

export function normalizeTransaction(raw: unknown): PaymobTransaction {
  const t = (raw as { obj?: unknown })?.obj ?? raw;
  const o = t as Record<string, unknown>;
  if (!o || typeof o !== 'object' || o.id === undefined) throw new IntegrationError('bad_response', 'not a Paymob transaction', 'permanent');
  const order = (o.order ?? {}) as Record<string, unknown>;
  const reference =
    (typeof order.merchant_order_id === 'string' && order.merchant_order_id) || (typeof o.special_reference === 'string' && o.special_reference) || null;
  let state: PaymentState;
  if (o.is_refunded === true) state = 'refunded';
  else if (o.is_voided === true) state = 'voided';
  else if (o.pending === true) state = 'pending';
  else if (o.success === true) state = 'paid';
  else state = 'failed';
  const source = (o.source_data ?? {}) as Record<string, unknown>;
  return {
    transactionId: String(o.id),
    paymobOrderId: String(order.id ?? ''),
    reference,
    amountMinor: Number(o.amount_cents ?? 0),
    currency: String(o.currency ?? ''),
    state,
    integrationId: typeof o.integration_id === 'number' ? o.integration_id : null,
    sourceType: typeof source.type === 'string' ? source.type : null,
  };
}

/**
 * Decides what a confirmed transaction means for OUR payment. The order becomes paid only when Paymob's own record (fetched by us)
 * says paid, for the exact amount and currency we asked for, for our reference.
 */
export function judgeTransaction(tx: PaymobTransaction, expected: { reference: string; amountMinor: number; currency: string }): { outcome: 'paid' | 'pending' | 'failed' | 'refunded' } | { outcome: 'mismatch'; reason: 'amount' | 'currency' | 'reference' } {
  if (tx.reference !== null && tx.reference !== expected.reference) return { outcome: 'mismatch', reason: 'reference' };
  if (tx.state === 'paid' || tx.state === 'refunded') {
    if (tx.amountMinor !== expected.amountMinor) return { outcome: 'mismatch', reason: 'amount' };
    if (tx.currency.toUpperCase() !== expected.currency.toUpperCase()) return { outcome: 'mismatch', reason: 'currency' };
  }
  if (tx.state === 'paid') return { outcome: 'paid' };
  if (tx.state === 'pending') return { outcome: 'pending' };
  if (tx.state === 'refunded') return { outcome: 'refunded' };
  return { outcome: 'failed' };
}
