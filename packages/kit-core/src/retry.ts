import type { IntegrationError } from './errors.js';

/** How long and how often a failed job is retried. */
export interface RetryPolicy {
  /** Attempts in total, the first one included. After the last one the job goes to the dead letters. */
  maxAttempts: number;
  /** Delay before the second attempt; it doubles every attempt. */
  baseMs: number;
  /** No single wait is longer than this. */
  capMs: number;
}

/**
 * The default: 10 s, 20 s, 40 s … capped at 6 hours, 20 attempts — about two and a half days in total, long enough to ride out a platform's
 * weekend outage, short enough that a job nobody can deliver ends up in front of a person the same week.
 */
export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 20, baseMs: 10_000, capMs: 6 * 60 * 60_000 };

/** For order status pushes: a platform stops caring about a status after an hour, so give up sooner and tell someone. */
export const FAST_RETRY: RetryPolicy = { maxAttempts: 8, baseMs: 5_000, capMs: 10 * 60_000 };

/**
 * The wait before attempt `attempt + 1`, after `attempt` failures (attempt starts at 1). "Equal jitter": half the exponential delay is fixed,
 * the other half random, so a crowd of jobs that failed together does not come back together.
 */
export function backoffMs(attempt: number, policy: RetryPolicy, rand: () => number = Math.random): number {
  const exp = Math.min(policy.capMs, policy.baseMs * 2 ** Math.max(0, attempt - 1));
  const half = exp / 2;
  return Math.round(half + rand() * half);
}

export type RetryDecision = { action: 'retry'; at: Date } | { action: 'dead'; reason: 'permanent' | 'auth' | 'exhausted' };

/** What to do with a job whose attempt number `attempt` just failed with `error`. */
export function decideRetry(error: IntegrationError, attempt: number, policy: RetryPolicy, now: Date, rand: () => number = Math.random): RetryDecision {
  if (error.cls === 'permanent') return { action: 'dead', reason: 'permanent' };
  if (error.cls === 'auth') return { action: 'dead', reason: 'auth' };
  if (attempt >= policy.maxAttempts) return { action: 'dead', reason: 'exhausted' };
  const wait = Math.max(backoffMs(attempt, policy, rand), error.retryAfterMs ?? 0);
  return { action: 'retry', at: new Date(now.getTime() + wait) };
}
