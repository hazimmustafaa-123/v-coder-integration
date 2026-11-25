import { createHash } from 'node:crypto';

/**
 * Reconciliation (reliability mechanism 3): compares what the platform says happened with what we recorded, so a message that never
 * reached us is found by our own periodic check instead of by an angry customer.
 */
export interface ReconcileResult<T> {
  /** On the platform but not with us: fetch and apply them. */
  missing: T[];
  /** With us but not on the platform (within the same window): worth a look, never deleted automatically. */
  unknown: string[];
}

export function reconcileById<T>(external: readonly T[], idOf: (item: T) => string, internalIds: Iterable<string>): ReconcileResult<T> {
  const internal = new Set(internalIds);
  const externalIds = new Set<string>();
  const missing: T[] = [];
  for (const item of external) {
    const id = idOf(item);
    externalIds.add(id);
    if (!internal.has(id)) missing.push(item);
  }
  const unknown = [...internal].filter((id) => !externalIds.has(id));
  return { missing, unknown };
}

/** A stable idempotency key from the parts that identify an operation (same parts → same key, so a retried push is recognised). */
export function idempotencyKey(...parts: (string | number)[]): string {
  return createHash('sha256').update(parts.map(String).join('\u001f')).digest('hex').slice(0, 40);
}
