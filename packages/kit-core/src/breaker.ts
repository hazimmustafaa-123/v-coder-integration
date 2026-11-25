/**
 * A circuit breaker per key (one key per connector and restaurant, usually): after `failureThreshold` failures in a row it opens and stops
 * calls for `openMs`; then it lets ONE trial call through (half-open). A success closes it, a failure opens it again.
 *
 * It lives in the worker's memory on purpose: a restart simply closes every breaker, which costs at most one failed call per key.
 */
export type BreakerState = 'closed' | 'open' | 'half_open';

export interface BreakerOptions {
  failureThreshold: number;
  openMs: number;
}

export const DEFAULT_BREAKER: BreakerOptions = { failureThreshold: 5, openMs: 60_000 };

interface Entry {
  failures: number;
  openedAt: number | null;
  trialInFlight: boolean;
}

export class CircuitBreakers {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly options: BreakerOptions = DEFAULT_BREAKER,
    private readonly clock: () => number = Date.now,
  ) {}

  private entry(key: string): Entry {
    let e = this.entries.get(key);
    if (!e) {
      e = { failures: 0, openedAt: null, trialInFlight: false };
      this.entries.set(key, e);
    }
    return e;
  }

  state(key: string): BreakerState {
    const e = this.entries.get(key);
    if (!e || e.openedAt === null) return 'closed';
    return this.clock() - e.openedAt >= this.options.openMs ? 'half_open' : 'open';
  }

  /** May a call go out now? In half-open state only one call at a time is allowed through. */
  allow(key: string): boolean {
    const s = this.state(key);
    if (s === 'closed') return true;
    if (s === 'open') return false;
    const e = this.entry(key);
    if (e.trialInFlight) return false;
    e.trialInFlight = true;
    return true;
  }

  /** When the breaker will let a trial call through (ms since epoch); now when closed. */
  retryAt(key: string): number {
    const e = this.entries.get(key);
    if (!e || e.openedAt === null) return this.clock();
    return e.openedAt + this.options.openMs;
  }

  success(key: string): void {
    this.entries.set(key, { failures: 0, openedAt: null, trialInFlight: false });
  }

  failure(key: string): void {
    const e = this.entry(key);
    e.trialInFlight = false;
    e.failures += 1;
    if (e.openedAt !== null || e.failures >= this.options.failureThreshold) e.openedAt = this.clock();
  }

  /** Keys whose breaker is open right now (for the health report). */
  openKeys(): string[] {
    return [...this.entries.keys()].filter((k) => this.state(k) !== 'closed');
  }
}
