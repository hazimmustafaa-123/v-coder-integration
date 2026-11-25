import { describe, expect, it } from 'vitest';
import { CircuitBreakers, IntegrationError, runJobsOnce, type Job, type JobError, type JobStore } from '../src/index.js';

/** An in-memory store with the same rules a product's SQL store must follow (lease on claim, attempts counted only when tried). */
class MemoryStore implements JobStore {
  jobs: (Job & { dueAt: number; state: 'pending' | 'leased' | 'done' | 'dead'; lastError?: JobError; deadReason?: string })[] = [];
  add(job: Partial<Job> & { id: string }, dueAt = 0) {
    this.jobs.push({ tenant: 't1', connector: 'c', kind: 'k', payload: null, attempts: 0, ...job, dueAt, state: 'pending' });
  }
  async claimDue(now: Date, limit: number) {
    const due = this.jobs.filter((j) => j.state === 'pending' && j.dueAt <= now.getTime()).slice(0, limit);
    for (const j of due) j.state = 'leased';
    return due.map((j) => ({ ...j }));
  }
  private find(job: Job) {
    return this.jobs.find((j) => j.id === job.id)!;
  }
  async markDone(job: Job) {
    this.find(job).state = 'done';
  }
  async markRetry(job: Job, at: Date, error: JobError, countAttempt: boolean) {
    const j = this.find(job);
    j.state = 'pending';
    j.dueAt = at.getTime();
    j.lastError = error;
    if (countAttempt) j.attempts += 1;
  }
  async markDead(job: Job, error: JobError, reason: string) {
    const j = this.find(job);
    j.state = 'dead';
    j.lastError = error;
    j.deadReason = reason;
    j.attempts += 1;
  }
}

describe('job runner', () => {
  it('runs due jobs and marks them done', async () => {
    const store = new MemoryStore();
    store.add({ id: '1' });
    store.add({ id: '2' }, Date.now() + 60_000); // not due yet
    const seen: string[] = [];
    const s = await runJobsOnce(store, () => async (job) => void seen.push(job.id));
    expect(seen).toEqual(['1']);
    expect(s).toMatchObject({ claimed: 1, done: 1 });
    expect(store.jobs[0]!.state).toBe('done');
  });

  it('retries a retryable failure later and counts the attempt', async () => {
    const store = new MemoryStore();
    store.add({ id: '1' });
    const now = new Date('2026-11-25T10:00:00Z');
    const s = await runJobsOnce(store, () => async () => { throw new IntegrationError('platform_unavailable', 'down', 'retryable'); }, { now: () => now, rand: () => 0 });
    expect(s.retried).toBe(1);
    expect(store.jobs[0]).toMatchObject({ state: 'pending', attempts: 1, dueAt: now.getTime() + 5_000 });
  });

  it('sends permanent and auth failures straight to the dead letters', async () => {
    const store = new MemoryStore();
    store.add({ id: 'p' });
    store.add({ id: 'a' });
    await runJobsOnce(store, (job) => async () => {
      throw new IntegrationError(job.id === 'p' ? 'rejected' : 'auth_failed', 'no', job.id === 'p' ? 'permanent' : 'auth');
    });
    expect(store.jobs.map((j) => [j.state, j.deadReason])).toEqual([['dead', 'permanent'], ['dead', 'auth']]);
  });

  it('gives up after the last attempt', async () => {
    const store = new MemoryStore();
    store.add({ id: '1', attempts: 2 });
    await runJobsOnce(store, () => async () => { throw new Error('boom'); }, { policyFor: () => ({ maxAttempts: 3, baseMs: 1, capMs: 1 }) });
    expect(store.jobs[0]).toMatchObject({ state: 'dead', deadReason: 'exhausted' });
  });

  it('an open circuit defers the restaurant’s jobs without using attempts, and leaves other restaurants alone', async () => {
    const store = new MemoryStore();
    let t = 0;
    const breakers = new CircuitBreakers({ failureThreshold: 1, openMs: 30_000 }, () => t);
    store.add({ id: 'x1', tenant: 'bad' });
    store.add({ id: 'x2', tenant: 'bad' });
    store.add({ id: 'y1', tenant: 'good' });
    const ran: string[] = [];
    await runJobsOnce(
      store,
      () => async (job) => {
        ran.push(job.id);
        if (job.tenant === 'bad') throw new IntegrationError('platform_unavailable', 'x', 'retryable');
      },
      { breakers, now: () => new Date(t), rand: () => 0 },
    );
    expect(ran).toEqual(['x1', 'y1']); // x2 was not tried: the breaker opened after x1
    const x2 = store.jobs.find((j) => j.id === 'x2')!;
    expect(x2).toMatchObject({ state: 'pending', attempts: 0, dueAt: 30_000 });
    expect(store.jobs.find((j) => j.id === 'y1')!.state).toBe('done');
  });

  it('a 4xx does not trip the breaker (it says nothing about the platform)', async () => {
    const store = new MemoryStore();
    const breakers = new CircuitBreakers({ failureThreshold: 1, openMs: 30_000 }, () => 0);
    store.add({ id: '1' });
    store.add({ id: '2' });
    const ran: string[] = [];
    await runJobsOnce(store, () => async (job) => {
      ran.push(job.id);
      if (job.id === '1') throw new IntegrationError('rejected', 'x', 'permanent');
    }, { breakers });
    expect(ran).toEqual(['1', '2']);
  });

  it('leaves a job of an unknown kind for a newer version (rollback safety)', async () => {
    const store = new MemoryStore();
    store.add({ id: '1', kind: 'from_the_future' });
    const s = await runJobsOnce(store, () => undefined);
    expect(s.deferred).toBe(1);
    expect(store.jobs[0]).toMatchObject({ state: 'pending', attempts: 0 });
  });

  it('reports every outcome', async () => {
    const store = new MemoryStore();
    store.add({ id: '1' });
    store.add({ id: '2' });
    const outcomes: string[] = [];
    await runJobsOnce(store, (job) => async () => { if (job.id === '2') throw new IntegrationError('rejected', 'x', 'permanent'); }, { onOutcome: (o) => void outcomes.push(`${o.job.id}:${o.result}`) });
    expect(outcomes).toEqual(['1:done', '2:dead']);
  });
});
