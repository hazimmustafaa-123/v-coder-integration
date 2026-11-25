import { randomUUID } from 'node:crypto';

/**
 * The one shape every V CODER integration event has, in every product (contract §2). It is stored (outbox, inbox, audit), so it carries
 * its own format marker: a reader that meets a format it does not know leaves the row alone instead of guessing.
 *
 * - `type` is `<product>.<entity>.<what happened>`, e.g. `sufra.order.status_changed`;
 * - `version` is the version of `data`'s shape for that type (additive changes keep the number; a breaking change is a new number);
 * - `tenant` is the product's own tenant id (restaurant, shop, gym) — never trusted from a platform message, always set by our code.
 */
export const ENVELOPE_FORMAT = 'vc1' as const;

export interface EventEnvelope<T = unknown> {
  fmt: typeof ENVELOPE_FORMAT;
  id: string;
  type: string;
  version: number;
  tenant: string;
  occurredAt: string;
  data: T;
}

const TYPE_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$/;

export function makeEnvelope<T>(input: { type: string; version?: number; tenant: string; data: T; id?: string; occurredAt?: Date }): EventEnvelope<T> {
  if (!TYPE_RE.test(input.type)) throw new Error(`event type must look like product.entity.event, got "${input.type}"`);
  if (!input.tenant) throw new Error('event needs a tenant');
  const version = input.version ?? 1;
  if (!Number.isInteger(version) || version < 1) throw new Error('event version must be a positive integer');
  return {
    fmt: ENVELOPE_FORMAT,
    id: input.id ?? randomUUID(),
    type: input.type,
    version,
    tenant: input.tenant,
    occurredAt: (input.occurredAt ?? new Date()).toISOString(),
    data: input.data,
  };
}

/** True for a stored value in a format this version understands. Unknown formats are left for a newer version of the library. */
export function isEnvelope(value: unknown): value is EventEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.fmt === ENVELOPE_FORMAT &&
    typeof v.id === 'string' &&
    typeof v.type === 'string' &&
    TYPE_RE.test(v.type) &&
    typeof v.version === 'number' &&
    typeof v.tenant === 'string' &&
    typeof v.occurredAt === 'string' &&
    'data' in v
  );
}
