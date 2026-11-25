import { describe, expect, it } from 'vitest';
import { claudeProvider, estimateCost, ExtractError, extractTable, MODELS, sanitize, sniffMedia, type ExtractionProvider } from '../src/data-io/index.js';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const rowsOf = (n: number, withPrice = true) => Array.from({ length: n }, (_, i) => ({ category: 'مشروبات', name: 'صنف ' + i, price: withPrice ? String(10 + i) : '', description: '', group: '', option: '', delta: '' }));

describe('reading a menu photo with AI', () => {
  it('knows the file type from its bytes and refuses anything else', async () => {
    expect(sniffMedia(PNG)).toBe('image/png');
    expect(sniffMedia(Buffer.from('%PDF-1.4'))).toBe('application/pdf');
    expect(sniffMedia(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]))).toBe('image/jpeg');
    expect(sniffMedia(Buffer.from('hello'))).toBeNull();
    const never: ExtractionProvider = { extract: async () => { throw new Error('must not be called'); } };
    await expect(extractTable(never, Buffer.from('hello world'), 'menu')).rejects.toMatchObject({ code: 'ai_unsupported_type' });
    await expect(extractTable(never, Buffer.alloc(11 * 1024 * 1024), 'menu')).rejects.toMatchObject({ code: 'ai_file_too_big' });
  });

  it('uses the cheap model first and keeps its answer when it is good: a table in the import\'s own columns', async () => {
    const calls: string[] = [];
    const p: ExtractionProvider = { extract: async (r) => { calls.push(r.model); return { rows: rowsOf(5), notes: ['سعر الصنف 3 مقطوع'], usage: { inputTokens: 4000, outputTokens: 3500 } }; } };
    const t = await extractTable(p, PNG, 'menu');
    expect(calls).toEqual([MODELS.fast]);
    expect(t).toMatchObject({ model: MODELS.fast, passes: 1, notes: ['سعر الصنف 3 مقطوع'] });
    expect(t.table[0]).toEqual(['القسم', 'الصنف', 'السعر', 'الوصف', 'مجموعة الخيارات', 'الخيار', 'فرق السعر']);
    expect(t.table).toHaveLength(6);
    expect(t.costUsd).toBeCloseTo((4000 * 0.1 + 3500 * 0.5) / 1e6, 3);
  });

  it('tries the stronger model when the first result is poor (most rows without a price), and stops after two passes', async () => {
    const calls: string[] = [];
    const p: ExtractionProvider = { extract: async (r) => { calls.push(r.model); return { rows: r.model === MODELS.fast ? rowsOf(6, false) : rowsOf(6), notes: [], usage: { inputTokens: 1000, outputTokens: 1000 } }; } };
    const t = await extractTable(p, PNG, 'menu');
    expect(calls).toEqual([MODELS.fast, MODELS.strong]);
    expect(t.passes).toBe(2);
    expect(t.usage).toEqual({ inputTokens: 2000, outputTokens: 2000 });
    expect(t.costUsd).toBeCloseTo(estimateCost(MODELS.fast, { inputTokens: 1000, outputTokens: 1000 }) + estimateCost(MODELS.strong, { inputTokens: 1000, outputTokens: 1000 }), 3);
    const bad: ExtractionProvider = { extract: async () => ({ rows: [], notes: [], usage: { inputTokens: 1, outputTokens: 1 } }) };
    await expect(extractTable(bad, PNG, 'menu')).rejects.toMatchObject({ code: 'ai_unreadable' });
  });

  it('keeps only strings of sane length, drops unknown shapes, and refuses a table that is not one', () => {
    expect(sanitize({ rows: [{ name: '  شاي   ', price: 5, evil: { x: 1 }, 'bad key!': 'x' }, {}, { name: '' }], notes: ['a', 3, 'b'] })).toEqual({ rows: [{ name: 'شاي', price: '5' }], notes: ['a', 'b'] });
    expect(() => sanitize({ rows: 'x' })).toThrow(ExtractError);
    expect(() => sanitize(null)).toThrow(ExtractError);
    expect(sanitize({ rows: [{ name: 'x'.repeat(1000) }], notes: [] }).rows[0]!.name).toHaveLength(400);
  });

  it('the Claude provider sends the file as a document or image with the tool schema, and reads the tool call; failures become typed errors', async () => {
    let sent: any = null;
    const ok = claudeProvider({ apiKey: 'k', fetchImpl: async (url, init) => { sent = { url, init, body: JSON.parse(init.body) }; return { ok: true, status: 200, json: async () => ({ stop_reason: 'tool_use', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', input: { rows: rowsOf(2), notes: [] } }], usage: { input_tokens: 10, output_tokens: 20 } }) }; } });
    const r = await ok.extract({ bytes: Buffer.from('%PDF-1.4 x'), mediaType: 'application/pdf', kind: 'menu', model: MODELS.fast });
    expect(r.rows).toHaveLength(2);
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
    expect(sent.url).toBe('https://api.anthropic.com/v1/messages');
    expect(sent.init.headers['x-api-key']).toBe('k');
    expect(sent.body.model).toBe('claude-haiku-5-5');
    expect(sent.body.messages[0].content[0]).toMatchObject({ type: 'document', source: { type: 'base64', media_type: 'application/pdf' } });
    expect(sent.body.tools[0]).toMatchObject({ name: 'record_rows', strict: true });
    expect(sent.body.tools[0].input_schema.properties.rows.items.required).toContain('price');
    expect(sent.body.tool_choice).toEqual({ type: 'auto' });                         // forced tool choice is rejected by the newer models
    const img = claudeProvider({ apiKey: 'k', fetchImpl: async (_u, init) => { sent = JSON.parse(init.body); return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: JSON.stringify({ rows: rowsOf(1), notes: [] }) }] }) }; } });
    expect((await img.extract({ bytes: PNG, mediaType: 'image/png', kind: 'menu', model: MODELS.strong })).rows).toHaveLength(1);
    expect(sent.messages[0].content[0].type).toBe('image');
    const down = claudeProvider({ apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 529, json: async () => ({}) }) });
    await expect(down.extract({ bytes: PNG, mediaType: 'image/png', kind: 'menu', model: MODELS.fast })).rejects.toMatchObject({ code: 'ai_failed' });
    const throwing = claudeProvider({ apiKey: 'k', fetchImpl: async () => { throw new Error('network'); } });
    await expect(throwing.extract({ bytes: PNG, mediaType: 'image/png', kind: 'menu', model: MODELS.fast })).rejects.toMatchObject({ code: 'ai_failed' });
    const refusing = claudeProvider({ apiKey: 'k', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ stop_reason: 'refusal', content: [] }) }) });
    await expect(refusing.extract({ bytes: PNG, mediaType: 'image/png', kind: 'menu', model: MODELS.fast })).rejects.toMatchObject({ code: 'ai_refused' });
  });
});
