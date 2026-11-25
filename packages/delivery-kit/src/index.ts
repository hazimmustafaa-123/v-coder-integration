export type {
  ChannelEvent,
  ChannelOrder,
  ChannelOrderLine,
  ChannelOrderModifier,
  ChannelOrderStatus,
  DeliveryConnector,
  ExternalMenuItem,
  MenuItemForChannel,
  RejectReason,
} from './types.js';
export {
  BLOCKING_READINESS,
  checkReadiness,
  nameSimilarity,
  normalizeName,
  orderArithmeticOk,
  suggestMappings,
  translateOrder,
  type MappingSuggestion,
  type MenuMapping,
  type ReadinessIssue,
  type TranslatedLine,
} from './mapping.js';
export { SIMULATOR_ID, SimulatedPlatform, simulatorConnector, type PushedStatus, type SimulatorFaults } from './simulator.js';

/** Allowed next statuses the restaurant may push, so a late or repeated push never moves an order backwards on the platform. */
export const STATUS_ORDER = ['accepted', 'preparing', 'ready', 'picked_up', 'delivered'] as const;

export function isForwardStatus(from: string | null, to: string): boolean {
  if (to === 'rejected') return from === null;
  if (to === 'cancelled') return from !== 'delivered' && from !== 'cancelled' && from !== 'rejected';
  const a = from === null ? -1 : STATUS_ORDER.indexOf(from as (typeof STATUS_ORDER)[number]);
  const b = STATUS_ORDER.indexOf(to as (typeof STATUS_ORDER)[number]);
  return b > a && a >= -1 && b >= 0 && from !== 'cancelled' && from !== 'rejected';
}

export const DELIVERY_KIT_VERSION = '0.1.0';
