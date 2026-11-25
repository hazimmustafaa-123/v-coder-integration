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
 * WhatsApp Business Cloud API (Meta). Written from Meta's public documentation; verifiedAgainst = 'docs'.
 *
 * Activation today is 'keys' (the owner pastes a permanent access token and the phone number id from Meta's Business Manager). The
 * easier one-click «Embedded Signup» needs V CODER to be registered with Meta as a Tech Provider first — a business step, not code;
 * the manifest can switch to 'oauth' then without the products changing.
 *
 * Rules the products must respect (Meta's, not ours): a business may message a customer freely only within 24 hours of the customer's
 * last message; outside that window only pre-approved TEMPLATES may be sent. Marketing needs the customer's consent.
 */
export const WHATSAPP_VERSION = '0.1.0';
export const GRAPH_HOST = 'graph.facebook.com';
export const GRAPH_API_VERSION = 'v21.0';

export const whatsappManifest: ConnectorManifest = {
  id: 'whatsapp',
  nameAr: 'واتساب للأعمال',
  nameEn: 'WhatsApp Business',
  version: WHATSAPP_VERSION,
  kind: 'messaging',
  activation: 'keys',
  capabilities: ['messages.template', 'messages.text', 'messages.status'],
  verifiedAgainst: 'docs',
  docsUrl: 'https://developers.facebook.com/docs/whatsapp/cloud-api',
  credentialFields: [
    { key: 'accessToken', labelAr: 'رمز الوصول الدائم (Access Token)', secret: true, helpAr: 'من Meta Business Manager: مستخدمو النظام ← إنشاء رمز بصلاحية whatsapp_business_messaging' },
    { key: 'phoneNumberId', labelAr: 'معرّف رقم الهاتف (Phone number ID)', secret: false, pattern: '^\\d{6,20}$', helpAr: 'من WhatsApp Manager: الأرقام ← معرّف الرقم' },
    { key: 'appSecret', labelAr: 'سر التطبيق (App Secret)', secret: true, helpAr: 'من إعدادات تطبيق Meta ← أساسي. لازم عشان نتأكد إن رسائل واتساب جاية فعلًا من Meta' },
  ],
};

export const whatsappMessages: Record<string, OwnerMessage> = {
  auth_failed: { text: 'Meta رفضت رمز الوصول. اعمل رمز جديد من Business Manager وحدّثه هنا.', action: 'update_credentials' },
  outside_window: { text: 'العميل ما بعتش رسالة من أكتر من 24 ساعة، فمسموح نبعتله رسائل جاهزة معتمدة بس.', action: 'none' },
  template_missing: { text: 'نموذج الرسالة مش معتمد في حسابك على واتساب. اعتمده من WhatsApp Manager.', action: 'none' },
};

export interface WhatsAppCredentials {
  accessToken: string;
  phoneNumberId: string;
  appSecret: string;
}

export interface WhatsAppClientOptions {
  fetch?: SafeFetchOptions['fetchImpl'];
  lookup?: SafeFetchOptions['lookup'];
}

/** Egyptian mobile numbers in any common writing (01xxxxxxxxx, +20…, 0020…, Arabic digits) to Meta's format: digits only with 20. */
export function toWhatsAppNumber(phone: string): string | null {
  const latin = phone.replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace(/[^\d+]/g, '');
  let digits = latin.replace(/^\+/, '').replace(/^00/, '');
  if (/^01\d{9}$/.test(digits)) digits = `2${digits}`;
  return /^201\d{9}$/.test(digits) ? digits : null;
}

export class WhatsAppClient {
  constructor(
    private readonly creds: WhatsAppCredentials,
    private readonly opts: WhatsAppClientOptions = {},
  ) {}

  private fetchOpts(): SafeFetchOptions {
    return {
      allowHosts: [GRAPH_HOST],
      timeoutMs: 15_000,
      ...(this.opts.fetch ? { fetchImpl: this.opts.fetch } : {}),
      ...(this.opts.lookup ? { lookup: this.opts.lookup } : {}),
    };
  }

  private url(path: string): string {
    return `https://${GRAPH_HOST}/${GRAPH_API_VERSION}/${path}`;
  }

  private async send(payload: Record<string, unknown>): Promise<{ messageId: string }> {
    try {
      const res = await safeFetch(
        this.url(`${encodeURIComponent(this.creds.phoneNumberId)}/messages`),
        { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.creds.accessToken}` }, body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }) },
        this.fetchOpts(),
      );
      const body = res.json<{ messages?: { id?: string }[] }>();
      const id = body.messages?.[0]?.id;
      if (!id) throw new IntegrationError('bad_response', 'WhatsApp did not return a message id', 'retryable');
      return { messageId: id };
    } catch (error) {
      throw mapGraphError(error);
    }
  }

  /** A pre-approved template (allowed any time). `params` fill {{1}}, {{2}}… of the template's body in order. */
  sendTemplate(input: { to: string; template: string; language?: string; params?: string[] }): Promise<{ messageId: string }> {
    const to = toWhatsAppNumber(input.to);
    if (!to) return Promise.reject(new IntegrationError('bad_phone', 'not an Egyptian mobile number', 'permanent'));
    return this.send({
      to,
      type: 'template',
      template: {
        name: input.template,
        language: { code: input.language ?? 'ar' },
        ...(input.params && input.params.length > 0 ? { components: [{ type: 'body', parameters: input.params.map((text) => ({ type: 'text', text: text.slice(0, 1000) })) }] } : {}),
      },
    });
  }

  /** Free text — only inside the 24-hour window after the customer's last message (Meta refuses it otherwise). */
  sendText(input: { to: string; text: string }): Promise<{ messageId: string }> {
    const to = toWhatsAppNumber(input.to);
    if (!to) return Promise.reject(new IntegrationError('bad_phone', 'not an Egyptian mobile number', 'permanent'));
    return this.send({ to, type: 'text', text: { body: input.text.slice(0, 4096), preview_url: false } });
  }

  async testConnection(): Promise<ConnectionTest> {
    try {
      const res = await safeFetch(
        this.url(`${encodeURIComponent(this.creds.phoneNumberId)}?fields=display_phone_number,verified_name`),
        { method: 'GET', headers: { authorization: `Bearer ${this.creds.accessToken}` } },
        this.fetchOpts(),
      );
      const b = res.json<{ display_phone_number?: string; verified_name?: string }>();
      return { ok: true, accountLabel: [b.verified_name, b.display_phone_number].filter(Boolean).join(' · ') || 'متصل' };
    } catch (error) {
      const e = mapGraphError(error);
      return { ok: false, code: e.code, detail: e.message };
    }
  }
}

/** Meta's error codes that mean something specific to the owner. */
function mapGraphError(error: unknown): IntegrationError {
  if (!(error instanceof IntegrationError)) return error instanceof Error ? new IntegrationError('unexpected', error.message, 'retryable') : new IntegrationError('unexpected', String(error), 'retryable');
  const m = /"code"\s*:\s*(\d+)/.exec(error.message);
  const code = m ? Number(m[1]) : null;
  if (code === 131047) return new IntegrationError('outside_window', 'outside the 24-hour customer service window', 'permanent', error.status === undefined ? {} : { status: error.status });
  if (code === 132001) return new IntegrationError('template_missing', 'template does not exist or is not approved', 'permanent', error.status === undefined ? {} : { status: error.status });
  if (code === 190) return new IntegrationError('auth_failed', 'access token expired or revoked', 'auth', error.status === undefined ? {} : { status: error.status });
  if (code === 130429 || code === 131056) return new IntegrationError('rate_limited', 'WhatsApp rate limit', 'rate_limited', error.status === undefined ? {} : { status: error.status });
  return error;
}

/** Meta signs every webhook: header `x-hub-signature-256: sha256=<hex HMAC-SHA256 of the RAW body with the app secret>`. */
export function verifyWebhookSignature(rawBody: string | Buffer, header: unknown, appSecret: string): boolean {
  if (typeof header !== 'string' || !header.startsWith('sha256=') || !appSecret) return false;
  return safeEqual(hmacHex('sha256', appSecret, rawBody), header.slice('sha256='.length).toLowerCase());
}

/** Meta's one-time subscription check: echo hub.challenge only when the verify token is ours. */
export function answerVerification(query: Record<string, unknown>, verifyToken: string): string | null {
  if (query['hub.mode'] !== 'subscribe' || typeof query['hub.verify_token'] !== 'string' || typeof query['hub.challenge'] !== 'string') return null;
  return safeEqual(query['hub.verify_token'], verifyToken) ? query['hub.challenge'] : null;
}

export type WhatsAppEvent =
  | { kind: 'status'; messageId: string; status: 'sent' | 'delivered' | 'read' | 'failed'; recipient: string; at: Date; errorCode?: number }
  | { kind: 'inbound'; messageId: string; from: string; at: Date; text: string | null };

/** Turns a webhook body into events (statuses of our messages, and customers' replies, which open the 24-hour window). */
export function parseWebhook(body: unknown): WhatsAppEvent[] {
  const out: WhatsAppEvent[] = [];
  const entries = (body as { entry?: unknown[] })?.entry;
  if (!Array.isArray(entries)) return out;
  for (const entry of entries) {
    for (const change of ((entry as { changes?: unknown[] }).changes ?? []) as { value?: Record<string, unknown> }[]) {
      const v = change.value ?? {};
      for (const s of (v.statuses ?? []) as Record<string, unknown>[]) {
        const status = s.status;
        if (status !== 'sent' && status !== 'delivered' && status !== 'read' && status !== 'failed') continue;
        const errors = s.errors as { code?: number }[] | undefined;
        out.push({
          kind: 'status',
          messageId: String(s.id ?? ''),
          status,
          recipient: String(s.recipient_id ?? ''),
          at: new Date(Number(s.timestamp ?? 0) * 1000),
          ...(errors?.[0]?.code !== undefined ? { errorCode: errors[0].code } : {}),
        });
      }
      for (const m of (v.messages ?? []) as Record<string, unknown>[]) {
        out.push({
          kind: 'inbound',
          messageId: String(m.id ?? ''),
          from: String(m.from ?? ''),
          at: new Date(Number(m.timestamp ?? 0) * 1000),
          text: typeof (m.text as { body?: unknown } | undefined)?.body === 'string' ? (m.text as { body: string }).body : null,
        });
      }
    }
  }
  return out;
}
