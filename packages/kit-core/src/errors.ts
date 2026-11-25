/**
 * How a failed call is treated. The class decides what the runners do next:
 * - retryable: try again later (network trouble, 5xx, timeouts);
 * - rate_limited: try again after the platform's Retry-After (or our backoff, whichever is later);
 * - auth: the stored credentials are no longer accepted — stop, mark the connection as needing the owner, never hammer;
 * - permanent: the request itself is wrong (4xx) — retrying cannot help, it goes to the dead letters with an alert.
 */
export type ErrorClass = 'retryable' | 'rate_limited' | 'auth' | 'permanent';

export class IntegrationError extends Error {
  readonly code: string;
  readonly cls: ErrorClass;
  readonly retryAfterMs: number | undefined;
  readonly status: number | undefined;

  constructor(code: string, message: string, cls: ErrorClass, opts: { retryAfterMs?: number; status?: number; cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'IntegrationError';
    this.code = code;
    this.cls = cls;
    this.retryAfterMs = opts.retryAfterMs;
    this.status = opts.status;
  }
}

/** Parses a Retry-After header (seconds or an HTTP date) into milliseconds; undefined when absent or unreadable. */
export function parseRetryAfter(value: string | null | undefined, now: Date = new Date()): number | undefined {
  if (value == null) return undefined;
  const text = value.trim();
  if (text === '') return undefined;
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now.getTime());
}

/** Classifies an HTTP status from a platform into an IntegrationError (or null for a success status). */
export function errorForStatus(status: number, opts: { retryAfter?: string | null; detail?: string; now?: Date } = {}): IntegrationError | null {
  if (status >= 200 && status < 300) return null;
  const detail = opts.detail ? `: ${opts.detail.slice(0, 300)}` : '';
  if (status === 401 || status === 403) return new IntegrationError('auth_failed', `platform refused the credentials (${status})${detail}`, 'auth', { status });
  if (status === 429) {
    const retryAfterMs = parseRetryAfter(opts.retryAfter, opts.now);
    return new IntegrationError('rate_limited', `platform rate limit (429)${detail}`, 'rate_limited', { status, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
  }
  if (status === 408 || status === 425 || status >= 500) {
    const retryAfterMs = parseRetryAfter(opts.retryAfter, opts.now);
    return new IntegrationError('platform_unavailable', `platform error (${status})${detail}`, 'retryable', { status, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
  }
  if (status === 404) return new IntegrationError('not_found', `not found on the platform (404)${detail}`, 'permanent', { status });
  return new IntegrationError('rejected', `platform rejected the request (${status})${detail}`, 'permanent', { status });
}

/** Turns anything thrown by a handler into an IntegrationError: unknown errors (bugs, network failures) count as retryable. */
export function toIntegrationError(error: unknown): IntegrationError {
  if (error instanceof IntegrationError) return error;
  const e = error as { name?: string; message?: string; code?: string };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return new IntegrationError('timeout', 'the platform did not answer in time', 'retryable', { cause: error });
  if (e?.name === 'TypeError' && /fetch failed/i.test(e.message ?? '')) return new IntegrationError('network', 'could not reach the platform', 'retryable', { cause: error });
  return new IntegrationError('unexpected', e?.message ? String(e.message).slice(0, 300) : 'unexpected error', 'retryable', { cause: error });
}
