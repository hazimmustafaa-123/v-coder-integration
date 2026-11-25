/**
 * The neutral delivery-channel contract. Whatever the platform (Talabat directly, or through a middleware such as Deliverect or
 * Grubtech), its adapter turns the platform's messages into THESE shapes, and the product only ever deals with these. Changing partner
 * later means writing one adapter, not touching the restaurant system.
 *
 * Money is always integer minor units (piastres) with an ISO currency; times are ISO-8601 instants.
 */
export interface ChannelOrderModifier {
  externalId: string;
  name: string;
  quantity: number;
  /** Price of ONE of this modifier, minor units. */
  unitPrice: number;
}

export interface ChannelOrderLine {
  /** The platform's id for the menu item (what the owner maps to their own item). */
  externalItemId: string;
  name: string;
  quantity: number;
  /** Price of ONE item as the platform charged it, minor units, modifiers not included. */
  unitPrice: number;
  modifiers: ChannelOrderModifier[];
  note: string | null;
}

export interface ChannelOrder {
  /** The platform's order id — unique per channel; our duplicate guard is (restaurant, channel, externalId). */
  externalId: string;
  /** A short number the courier and the customer use (shown big on the ticket). */
  displayNumber: string;
  /** Which of the restaurant's locations on the platform (mapped to one of our branches). */
  externalStoreId: string;
  placedAt: string;
  /** When the platform expects it ready for pickup, if it says. */
  pickupAt: string | null;
  /** Who delivers: the platform's courier (most common) or the restaurant's own driver. */
  deliveredBy: 'platform' | 'restaurant';
  customer: { name: string; phone: string | null; address: string | null };
  lines: ChannelOrderLine[];
  currency: string;
  totals: { subtotal: number; discount: number; deliveryFee: number; total: number };
  /** Paid on the platform (nothing to collect) or cash to collect on delivery. */
  payment: { kind: 'prepaid' | 'cash_on_delivery'; amountToCollect: number };
  note: string | null;
}

/** What the restaurant tells the platform about an order, in order. */
export type ChannelOrderStatus = 'accepted' | 'rejected' | 'preparing' | 'ready' | 'picked_up' | 'delivered' | 'cancelled';

export type RejectReason = 'busy' | 'closed' | 'item_unavailable' | 'other';

/** What the platform tells us. */
export type ChannelEvent =
  | { kind: 'order.created'; order: ChannelOrder }
  | { kind: 'order.cancelled'; externalId: string; reason: string | null }
  | { kind: 'order.picked_up'; externalId: string }
  | { kind: 'order.delivered'; externalId: string }
  | { kind: 'store.status'; externalStoreId: string; open: boolean };

export interface MenuItemForChannel {
  /** OUR item id (as text so every product fits). */
  internalId: string;
  name: string;
  price: number;
  available: boolean;
  category: string | null;
}

export interface ExternalMenuItem {
  externalId: string;
  name: string;
  price: number | null;
}

/**
 * What a channel adapter must do. Every method may throw IntegrationError (kit-core) — the product's job runner retries according to
 * the error's class. Adapters never write to the product; they translate.
 */
export interface DeliveryConnector {
  readonly id: string;
  /** Turns one inbound webhook request into events, after checking its signature. Throws on a bad signature (never applied). */
  parseInbound(input: { headers: Record<string, string | string[] | undefined>; rawBody: string }): { eventId: string; events: ChannelEvent[] };
  pushStatus(input: { externalStoreId: string; externalId: string; status: ChannelOrderStatus; reason?: RejectReason; readyInMinutes?: number }): Promise<void>;
  pushAvailability(input: { externalStoreId: string; unavailableExternalItemIds: string[] }): Promise<void>;
  setStoreOpen(input: { externalStoreId: string; open: boolean; untilIso?: string }): Promise<void>;
  /** The platform's menu items, for the mapping screen. */
  listMenu(input: { externalStoreId: string }): Promise<ExternalMenuItem[]>;
  /** Orders placed since `sinceIso` — the reconciliation that catches webhooks that never reached us. */
  listOrdersSince(input: { externalStoreId: string; sinceIso: string }): Promise<ChannelOrder[]>;
}
