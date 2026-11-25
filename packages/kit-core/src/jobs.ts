import { CircuitBreakers } from './breaker.js';
import { IntegrationError, toIntegrationError } from './errors.js';
import { DEFAULT_RETRY, decideRetry, type RetryPolicy } from './retry.js';

/**
 * The outbox and the inbox share one runner (reliability mechanisms 2, 3 and 4).
 *
 * OUTBOX: work WE must do towards a platform (push an order status, push sold-out items, send a message). The product writes the job in
 *   the SAME transaction as the change that caused it, so a committed change always has its job and a rolled-back one never does.
 * INBOX: messages a platform sent US. The product saves the raw message durably BEFORE answering the platform, then applies it here,
 *   so a crash after the answer loses nothing.
 *
 * The library never touches a database: each product implements `JobStore` over its own tables (its own RLS, its own migrations).
 * Claiming must be exclusive (e.g. `FOR UPDATE SKIP LOCKED` plus a lease), so two workers never run the same job.
 */
export interface Job {
  id: string;
  tenant: string;
  connector: string;
  kind: string;
  payload: unknown;
  /** Attempts already made (0 for a new job). */
  attempts: number;
}

export interface JobError {
  code: string;
  message: string;
}

export interface JobStore<J extends Job = Job> {
  /** Up to `limit` jobs that are due at `now`, leased to this worker so nobody else takes them meanwhile. */
  claimDue(now: Date, limit: number): Promise<J[]>;
  markDone(job: J, now: Date): Promise<void>;
  /** Try again at `at`. `countAttempt` false = the job was not even tried (its circuit was open): do not use up an attempt. */
  markRetry(job: J, at: Date, error: JobError, countAttempt: boolean): Promise<void>;
  /** Give up: the job goes to the dead letters, where a person (owner or our team) can replay it. */
  markDead(job: J, error: JobError, reason: 'permanent' | 'auth' | 'exhausted', now: Date): Promise<void>;
}

export type JobHandler<J extends Job = Job> = (job: J) => Promise<void>;

export interface RunOptions<J extends Job = Job> {
  breakers?: CircuitBreakers;
  /** Retry policy per job (status pushes give up sooner than menu uploads, for example). */
  policyFor?: (job: J) => RetryPolicy;
  now?: () => Date;
  rand?: () => number;
  limit?: number;
  /** Called for every outcome — the product turns these into metrics, the connection's last success/error, and alerts. */
  onOutcome?: (outcome: JobOutcome<J>) => void | Promise<void>;
}

export type JobOutcome<J extends Job = Job> =
  | { job: J; result: 'done' }
  | { job: J; result: 'retry'; at: Date; error: IntegrationError }
  | { job: J; result: 'deferred'; at: Date }
  | { job: J; result: 'dead'; reason: 'permanent' | 'auth' | 'exhausted'; error: IntegrationError }
  | { job: J; result: 'no_handler' };

export interface RunSummary {
  claimed: number;
  done: number;
  retried: number;
  deferred: number;
  dead: number;
}

const breakerKey = (job: Job) => `${job.connector}:${job.tenant}`;

/**
 * Runs one batch of due jobs. Jobs of different restaurants and connectors are independent: one restaurant's broken credentials or one
 * platform's outage never stops the others (each has its own breaker key).
 */
export async function runJobsOnce<J extends Job>(store: JobStore<J>, handlerFor: (job: J) => JobHandler<J> | undefined, options: RunOptions<J> = {}): Promise<RunSummary> {
  const now = options.now ?? (() => new Date());
  const breakers = options.breakers ?? new CircuitBreakers();
  const summary: RunSummary = { claimed: 0, done: 0, retried: 0, deferred: 0, dead: 0 };
  const jobs = await store.claimDue(now(), options.limit ?? 50);
  summary.claimed = jobs.length;

  for (const job of jobs) {
    const handler = handlerFor(job);
    if (!handler) {
      // An unknown job kind is left for a newer version of the product/library (rollback safety): retry much later, attempt not counted.
      await store.markRetry(job, new Date(now().getTime() + 60 * 60_000), { code: 'no_handler', message: `no handler for ${job.connector}/${job.kind}` }, false);
      await options.onOutcome?.({ job, result: 'no_handler' });
      summary.deferred += 1;
      continue;
    }
    const key = breakerKey(job);
    if (!breakers.allow(key)) {
      const at = new Date(breakers.retryAt(key));
      await store.markRetry(job, at, { code: 'circuit_open', message: 'platform failing repeatedly; waiting before trying again' }, false);
      await options.onOutcome?.({ job, result: 'deferred', at });
      summary.deferred += 1;
      continue;
    }
    try {
      await handler(job);
      breakers.success(key);
      await store.markDone(job, now());
      await options.onOutcome?.({ job, result: 'done' });
      summary.done += 1;
    } catch (thrown) {
      const error = toIntegrationError(thrown);
      // Only the platform's own failures trip the breaker; a rejected request (4xx) says nothing about the platform's health.
      if (error.cls === 'retryable' || error.cls === 'rate_limited') breakers.failure(key);
      else breakers.success(key);
      const attempt = job.attempts + 1;
      const decision = decideRetry(error, attempt, options.policyFor?.(job) ?? DEFAULT_RETRY, now(), options.rand);
      const jobError = { code: error.code, message: error.message };
      if (decision.action === 'retry') {
        await store.markRetry(job, decision.at, jobError, true);
        await options.onOutcome?.({ job, result: 'retry', at: decision.at, error });
        summary.retried += 1;
      } else {
        await store.markDead(job, jobError, decision.reason, now());
        await options.onOutcome?.({ job, result: 'dead', reason: decision.reason, error });
        summary.dead += 1;
      }
    }
  }
  return summary;
}
