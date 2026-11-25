import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WhatsAppClient, answerVerification, parseWebhook, toWhatsAppNumber, verifyWebhookSignature } from '../src/index.js';

const creds = { accessToken: 'EAAG-token', phoneNumberId: '1098765432', appSecret: 'app-secret' };
const lookup = async () => ['157.240.1.1'];

describe('numbers', () => {
  it('turns Egyptian mobiles into Meta’s format', () => {
    expect(toWhatsAppNumber('01001234567')).toBe('201001234567');
    expect(toWhatsAppNumber('+20 100 123 4567')).toBe('201001234567');
    expect(toWhatsAppNumber('00201001234567')).toBe('201001234567');
    expect(toWhatsAppNumber('٠١٠٠١٢٣٤٥٦٧')).toBe('201001234567');
    expect(toWhatsAppNumber('0223456789')).toBeNull();
  });
});

describe('webhooks', () => {
  it('verifies Meta’s signature over the raw body', () => {
    const raw = '{"entry":[]}';
    const sig = `sha256=${createHmac('sha256', creds.appSecret).update(raw).digest('hex')}`;
    expect(verifyWebhookSignature(raw, sig, creds.appSecret)).toBe(true);
    expect(verifyWebhookSignature('{"entry":[1]}', sig, creds.appSecret)).toBe(false);
    expect(verifyWebhookSignature(raw, 'sha1=abc', creds.appSecret)).toBe(false);
  });
  it('answers the subscription check only with our token', () => {
    expect(answerVerification({ 'hub.mode': 'subscribe', 'hub.verify_token': 'mine', 'hub.challenge': '42' }, 'mine')).toBe('42');
    expect(answerVerification({ 'hub.mode': 'subscribe', 'hub.verify_token': 'theirs', 'hub.challenge': '42' }, 'mine')).toBeNull();
  });
  it('parses statuses and inbound messages', () => {
    const body = {
      entry: [{ changes: [{ value: {
        statuses: [{ id: 'wamid.1', status: 'delivered', recipient_id: '201001234567', timestamp: '1795600000' }, { id: 'wamid.2', status: 'failed', recipient_id: '2010', timestamp: '1795600001', errors: [{ code: 131047 }] }],
        messages: [{ id: 'wamid.3', from: '201001234567', timestamp: '1795600002', type: 'text', text: { body: 'شكرًا' } }],
      } }] }],
    };
    const events = parseWebhook(body);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ kind: 'status', messageId: 'wamid.1', status: 'delivered' });
    expect(events[1]).toMatchObject({ kind: 'status', status: 'failed', errorCode: 131047 });
    expect(events[2]).toMatchObject({ kind: 'inbound', from: '201001234567', text: 'شكرًا' });
    expect(parseWebhook(null)).toEqual([]);
  });
});

describe('client', () => {
  it('sends a template with body parameters', async () => {
    let sent: { url: string; body: unknown; auth: string } | null = null;
    const fetch = (async (url: URL | string, init?: RequestInit) => {
      sent = { url: String(url), body: JSON.parse(String(init?.body)), auth: (init?.headers as Record<string, string>).authorization! };
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.X' }] }), { status: 200 });
    }) as typeof globalThis.fetch;
    const res = await new WhatsAppClient(creds, { fetch, lookup }).sendTemplate({ to: '01001234567', template: 'order_ready', params: ['#42', 'سفرة'] });
    expect(res.messageId).toBe('wamid.X');
    expect(sent!.url).toBe('https://graph.facebook.com/v21.0/1098765432/messages');
    expect(sent!.auth).toBe('Bearer EAAG-token');
    expect(sent!.body).toMatchObject({ messaging_product: 'whatsapp', to: '201001234567', type: 'template', template: { name: 'order_ready', language: { code: 'ar' }, components: [{ type: 'body', parameters: [{ type: 'text', text: '#42' }, { type: 'text', text: 'سفرة' }] }] } });
  });
  it('maps Meta’s errors to the owner’s terms', async () => {
    const reply = (code: number, status: number) => (async () => new Response(JSON.stringify({ error: { code, message: 'x' } }), { status })) as typeof globalThis.fetch;
    await expect(new WhatsAppClient(creds, { fetch: reply(131047, 400), lookup }).sendText({ to: '01001234567', text: 'hi' })).rejects.toMatchObject({ code: 'outside_window', cls: 'permanent' });
    await expect(new WhatsAppClient(creds, { fetch: reply(190, 401), lookup }).sendText({ to: '01001234567', text: 'hi' })).rejects.toMatchObject({ code: 'auth_failed', cls: 'auth' });
    await expect(new WhatsAppClient(creds, { fetch: reply(130429, 429), lookup }).sendText({ to: '01001234567', text: 'hi' })).rejects.toMatchObject({ cls: 'rate_limited' });
    await expect(new WhatsAppClient(creds, { lookup }).sendText({ to: '123', text: 'hi' })).rejects.toMatchObject({ code: 'bad_phone' });
  });
  it('tests the connection by reading the phone number', async () => {
    const fetch = (async () => new Response(JSON.stringify({ display_phone_number: '+20 100 123 4567', verified_name: 'سفرة' }), { status: 200 })) as typeof globalThis.fetch;
    expect(await new WhatsAppClient(creds, { fetch, lookup }).testConnection()).toEqual({ ok: true, accountLabel: 'سفرة · +20 100 123 4567' });
  });
});
