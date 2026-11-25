import { describe, expect, it } from 'vitest';
import { generateWebhookSecret } from '@v-coder/integration-kit';
import {
  SimulatedPlatform,
  checkReadiness,
  isForwardStatus,
  nameSimilarity,
  normalizeName,
  orderArithmeticOk,
  simulatorConnector,
  suggestMappings,
  translateOrder,
  type ChannelOrderLine,
} from '../src/index.js';

const line = (id: string, name: string, price: number, qty = 1, mods: ChannelOrderLine['modifiers'] = []): ChannelOrderLine => ({
  externalItemId: id, name, quantity: qty, unitPrice: price, modifiers: mods, note: null,
});

describe('Arabic-aware names', () => {
  it('normalises spelling variants', () => {
    expect(normalizeName('بيتزا مارجريتا')).toBe(normalizeName('بيتزا مارجريتآ'));
    expect(normalizeName('شاورمة فراخ')).toBe(normalizeName('شاورمه فراخ'));
    expect(normalizeName('برجر دبل  ٢')).toBe('برجر دبل 2');
    expect(normalizeName('كُشَري')).toBe('كشري');
  });
  it('scores close names high and different names low', () => {
    expect(nameSimilarity('بيتزا مارجريتا كبيرة', 'بيتزا مارجريتا كبيره')).toBe(1);
    expect(nameSimilarity('Chicken Shawarma', 'chicken shawerma')).toBeGreaterThan(0.7);
    expect(nameSimilarity('كشري', 'بيتزا')).toBeLessThan(0.3);
  });
});

describe('mapping suggestions', () => {
  const internal = [
    { internalId: '1', name: 'شاورمة فراخ', price: 9000, available: true, category: null },
    { internalId: '2', name: 'شاورمة لحم', price: 11000, available: true, category: null },
    { internalId: '3', name: 'بطاطس', price: 3000, available: true, category: null },
  ];
  it('proposes the best match once, and nothing for a stranger', () => {
    const s = suggestMappings(
      [{ externalId: 'a', name: 'شاورمه فراخ', price: 9000 }, { externalId: 'b', name: 'شاورما لحمة', price: 11000 }, { externalId: 'c', name: 'عصير مانجو', price: 2500 }],
      internal,
    );
    expect(s[0]).toMatchObject({ internalId: '1', confidence: 'sure' });
    expect(s[1]).toMatchObject({ internalId: '2' });
    expect(s[2]).toMatchObject({ internalId: null, confidence: 'none' });
  });
  it('never maps two platform items to the same item of ours', () => {
    const s = suggestMappings([{ externalId: 'a', name: 'بطاطس', price: null }, { externalId: 'b', name: 'بطاطس', price: null }], internal);
    expect(s.filter((x) => x.internalId === '3')).toHaveLength(1);
  });
});

describe('go-live checks', () => {
  const externalMenu = [{ externalId: 'a', name: 'شاورمة', price: 9000 }, { externalId: 'b', name: 'بيبسي', price: 1500 }];
  const internalMenu = [{ internalId: '1', name: 'شاورمة', price: 9000, available: true, category: null }];
  it('blocks until everything is mapped or excluded, the branch, tax mode and a test order are set', () => {
    const issues = checkReadiness({ externalMenu, mapping: { a: '1' }, internalMenu, branchId: null, taxMode: null, testOrderPassed: false });
    expect(issues.map((i) => i.code)).toEqual(['unmapped_items', 'no_branch', 'tax_mode_unset', 'no_test_order']);
    expect(checkReadiness({ externalMenu, mapping: { a: '1', b: null }, internalMenu, branchId: 1, taxMode: 'inclusive', testOrderPassed: true })).toEqual([]);
  });
  it('catches a mapping to an item that no longer exists', () => {
    expect(checkReadiness({ externalMenu, mapping: { a: '9', b: null }, internalMenu, branchId: 1, taxMode: 'inclusive', testOrderPassed: true }).map((i) => i.code)).toEqual(['unknown_internal_item']);
  });
});

describe('order translation', () => {
  const order = {
    externalId: 'X1', displayNumber: '77', externalStoreId: 's1', placedAt: '2026-11-25T12:00:00Z', pickupAt: null, deliveredBy: 'platform' as const,
    customer: { name: 'عميل', phone: null, address: null }, currency: 'EGP',
    lines: [line('a', 'شاورمة', 9000, 2, [{ externalId: 'm1', name: 'جبنة زيادة', quantity: 1, unitPrice: 1000 }]), line('z', 'صنف جديد', 2000)],
    totals: { subtotal: 22000, discount: 0, deliveryFee: 1500, total: 23500 },
    payment: { kind: 'prepaid' as const, amountToCollect: 0 }, note: null,
  };
  it('keeps the platform’s prices, folds modifiers in, and reports unmapped lines', () => {
    const t = translateOrder(order, { a: '1' });
    expect(t.lines).toEqual([{ internalId: '1', name: 'شاورمة', quantity: 2, unitPrice: 10000, lineTotal: 20000, note: null, modifiersText: 'جبنة زيادة' }]);
    expect(t.unmapped.map((l) => l.externalItemId)).toEqual(['z']);
    expect(orderArithmeticOk(order)).toBe(true);
    expect(orderArithmeticOk({ ...order, totals: { ...order.totals, total: 1 } })).toBe(false);
  });
});

describe('status order', () => {
  it('only moves forward', () => {
    expect(isForwardStatus(null, 'accepted')).toBe(true);
    expect(isForwardStatus('accepted', 'ready')).toBe(true);
    expect(isForwardStatus('ready', 'preparing')).toBe(false);
    expect(isForwardStatus('accepted', 'rejected')).toBe(false);
    expect(isForwardStatus(null, 'rejected')).toBe(true);
    expect(isForwardStatus('delivered', 'cancelled')).toBe(false);
    expect(isForwardStatus('preparing', 'cancelled')).toBe(true);
  });
});

describe('simulated platform', () => {
  it('signs its webhooks, and the connector refuses a forged one', () => {
    const platform = new SimulatedPlatform(generateWebhookSecret());
    const conn = simulatorConnector(platform);
    const { deliveries, order } = platform.placeOrder({ externalStoreId: 's1', lines: [line('a', 'شاورمة', 9000)] });
    const parsed = conn.parseInbound(deliveries[0]!);
    expect(parsed.events[0]).toMatchObject({ kind: 'order.created', order: { externalId: order.externalId } });
    expect(() => conn.parseInbound({ headers: deliveries[0]!.headers, rawBody: deliveries[0]!.rawBody.replace('9000', '1') })).toThrow(/rejected/);
  });
  it('can lose and duplicate webhooks, fail calls, and answers the reconciliation query', async () => {
    const platform = new SimulatedPlatform(generateWebhookSecret());
    const conn = simulatorConnector(platform);
    platform.faults = { dropNextWebhooks: 1, duplicateNextWebhooks: 1, failNextCalls: 1 };
    expect(platform.placeOrder({ externalStoreId: 's1', lines: [line('a', 'x', 100)] }).deliveries).toHaveLength(0);
    expect(platform.placeOrder({ externalStoreId: 's1', lines: [line('a', 'x', 100)] }).deliveries).toHaveLength(2);
    await expect(conn.pushAvailability({ externalStoreId: 's1', unavailableExternalItemIds: ['a'] })).rejects.toMatchObject({ cls: 'retryable' });
    await conn.pushAvailability({ externalStoreId: 's1', unavailableExternalItemIds: ['a'] });
    expect(platform.availability.get('s1')).toEqual(['a']);
    expect(await conn.listOrdersSince({ externalStoreId: 's1', sinceIso: '2000-01-01T00:00:00Z' })).toHaveLength(2);
  });
});
