import { randomUUID } from 'node:crypto';
import { IntegrationError, signWebhook, verifyWebhook } from '@v-coder/integration-kit';
import type { ChannelEvent, ChannelOrder, ChannelOrderStatus, DeliveryConnector, ExternalMenuItem, RejectReason } from './types.js';

/**
 * A simulated delivery platform. It stands in for Talabat or a middleware until a partner is chosen (ق-ت3) and is kept afterwards for
 * tests, demos and training: it sends signed order webhooks (Standard Webhooks), records what the restaurant pushes back, and answers the
 * reconciliation query. It can also misbehave on purpose (drop a webhook, send one twice, fail calls) to prove the product copes.
 */
export const SIMULATOR_ID = 'simulator';

export interface SimulatorFaults {
  /** The next N webhooks are "lost" (not delivered) — the reconciliation must find them. */
  dropNextWebhooks?: number;
  /** The next N webhooks are delivered twice — the duplicate guard must hold. */
  duplicateNextWebhooks?: number;
  /** The next N calls from the restaurant fail with 503 — the retries must cope. */
  failNextCalls?: number;
}

export interface PushedStatus {
  externalStoreId: string;
  externalId: string;
  status: ChannelOrderStatus;
  reason?: RejectReason;
  at: Date;
}

export class SimulatedPlatform {
  readonly secret: string;
  readonly orders = new Map<string, ChannelOrder & { platformStatus: ChannelOrderStatus | 'placed' }>();
  readonly statuses: PushedStatus[] = [];
  readonly availability = new Map<string, string[]>();
  readonly storeOpen = new Map<string, boolean>();
  menu: ExternalMenuItem[] = [];
  faults: SimulatorFaults = {};
  private seq = 1000;

  constructor(secret: string, private readonly clock: () => Date = () => new Date()) {
    this.secret = secret;
  }

  /** Builds an order (as the platform would) and returns the webhook deliveries it produces (0, 1 or 2 depending on the faults). */
  placeOrder(input: Partial<ChannelOrder> & { externalStoreId: string; lines: ChannelOrder['lines'] }): { order: ChannelOrder; deliveries: { headers: Record<string, string>; rawBody: string }[] } {
    this.seq += 1;
    const subtotal = input.lines.reduce((s, l) => s + (l.unitPrice + l.modifiers.reduce((m, x) => m + x.unitPrice * x.quantity, 0)) * l.quantity, 0);
    const deliveryFee = input.totals?.deliveryFee ?? 1500;
    const discount = input.totals?.discount ?? 0;
    const order: ChannelOrder = {
      externalId: input.externalId ?? `SIM-${this.seq}`,
      displayNumber: input.displayNumber ?? String(this.seq),
      externalStoreId: input.externalStoreId,
      placedAt: input.placedAt ?? this.clock().toISOString(),
      pickupAt: input.pickupAt ?? null,
      deliveredBy: input.deliveredBy ?? 'platform',
      customer: input.customer ?? { name: 'عميل تجريبي', phone: null, address: null },
      lines: input.lines,
      currency: input.currency ?? 'EGP',
      totals: { subtotal, discount, deliveryFee, total: subtotal - discount + deliveryFee },
      payment: input.payment ?? { kind: 'prepaid', amountToCollect: 0 },
      note: input.note ?? null,
    };
    this.orders.set(order.externalId, { ...order, platformStatus: 'placed' });
    return { order, deliveries: this.deliver({ kind: 'order.created', order }) };
  }

  cancelOrder(externalId: string, reason: string | null = null) {
    const o = this.orders.get(externalId);
    if (o) o.platformStatus = 'cancelled';
    return this.deliver({ kind: 'order.cancelled', externalId, reason });
  }

  pickUp(externalId: string) {
    const o = this.orders.get(externalId);
    if (o) o.platformStatus = 'picked_up';
    return this.deliver({ kind: 'order.picked_up', externalId });
  }

  private deliver(event: ChannelEvent): { headers: Record<string, string>; rawBody: string }[] {
    const rawBody = JSON.stringify({ events: [event] });
    const headers = { ...signWebhook({ id: `evt_${randomUUID()}`, body: rawBody, secret: this.secret, now: this.clock() }), 'content-type': 'application/json' };
    if ((this.faults.dropNextWebhooks ?? 0) > 0) {
      this.faults.dropNextWebhooks! -= 1;
      return [];
    }
    if ((this.faults.duplicateNextWebhooks ?? 0) > 0) {
      this.faults.duplicateNextWebhooks! -= 1;
      return [{ headers, rawBody }, { headers, rawBody }];
    }
    return [{ headers, rawBody }];
  }

  /** Used by the connector for every call the restaurant makes. */
  callGate(): void {
    if ((this.faults.failNextCalls ?? 0) > 0) {
      this.faults.failNextCalls! -= 1;
      throw new IntegrationError('platform_unavailable', 'simulated platform outage (503)', 'retryable', { status: 503 });
    }
  }
}

/** The DeliveryConnector over a SimulatedPlatform (in-process). */
export function simulatorConnector(platform: SimulatedPlatform, clock: () => Date = () => new Date()): DeliveryConnector {
  return {
    id: SIMULATOR_ID,
    parseInbound({ headers, rawBody }) {
      const lower: Record<string, string | string[] | undefined> = {};
      for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
      const check = verifyWebhook({ headers: lower, body: rawBody, secrets: [platform.secret], now: clock() });
      if (!check.ok) throw new IntegrationError('bad_signature', `simulator webhook rejected (${check.code})`, 'permanent');
      const parsed = JSON.parse(rawBody) as { events?: ChannelEvent[] };
      return { eventId: check.id, events: Array.isArray(parsed.events) ? parsed.events : [] };
    },
    async pushStatus({ externalStoreId, externalId, status, reason }) {
      platform.callGate();
      const o = platform.orders.get(externalId);
      if (!o) throw new IntegrationError('not_found', `no order ${externalId} on the simulated platform`, 'permanent', { status: 404 });
      o.platformStatus = status;
      platform.statuses.push({ externalStoreId, externalId, status, ...(reason ? { reason } : {}), at: clock() });
    },
    async pushAvailability({ externalStoreId, unavailableExternalItemIds }) {
      platform.callGate();
      platform.availability.set(externalStoreId, [...unavailableExternalItemIds].sort());
    },
    async setStoreOpen({ externalStoreId, open }) {
      platform.callGate();
      platform.storeOpen.set(externalStoreId, open);
    },
    async listMenu() {
      platform.callGate();
      return platform.menu.map((m) => ({ ...m }));
    },
    async listOrdersSince({ externalStoreId, sinceIso }) {
      platform.callGate();
      const since = Date.parse(sinceIso);
      return [...platform.orders.values()]
        .filter((o) => o.externalStoreId === externalStoreId && Date.parse(o.placedAt) >= since)
        .map(({ platformStatus: _s, ...o }) => o);
    },
  };
}
