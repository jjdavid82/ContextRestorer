/**
 * Unit tests for the worker-thread pool.
 *
 * `node:worker_threads` is mocked so the tests never need a compiled `task.js` on disk
 * and never spawn a real thread: the fake `Worker` lets each case drive message timing,
 * task failures and worker death deterministically and synchronously.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

interface Payload {
  taskId: string;
  kind: string;
  data: unknown;
}

/**
 * Minimal stand-in for `worker_threads.Worker`: same `on`/`postMessage`/`terminate`
 * surface the pool uses, plus helpers for the test to reply, fail or crash on demand.
 */
class FakeWorker extends EventEmitter {
  /** Every worker the pool has ever constructed, in creation order. */
  static instances: FakeWorker[] = [];

  /** The task this worker is currently holding, or `null` when idle. */
  inFlight: Payload | null = null;
  terminated = false;

  constructor(public readonly scriptPath: string) {
    super();
    FakeWorker.instances.push(this);
  }

  postMessage(payload: Payload): void {
    this.inFlight = payload;
  }

  terminate(): Promise<number> {
    this.terminated = true;
    return Promise.resolve(0);
  }

  /** Reply successfully to the in-flight task. */
  respond(value: unknown): void {
    const payload = this.take();
    this.emit('message', { taskId: payload.taskId, ok: true, value });
  }

  /** Reply with a handler failure (the worker itself stays alive). */
  fail(message: string): void {
    const payload = this.take();
    this.emit('message', { taskId: payload.taskId, ok: false, error: message });
  }

  /** Simulate the thread crashing. */
  crash(message: string): void {
    this.emit('error', new Error(message));
  }

  private take(): Payload {
    const payload = this.inFlight;
    if (!payload) throw new Error('fake worker has no in-flight task');
    // Cleared before emitting so a task dispatched during this emit is recorded.
    this.inFlight = null;
    return payload;
  }
}

vi.mock('node:worker_threads', () => ({ Worker: FakeWorker }));

const { createPool } = await import('../src/workers/pool.js');

/** Workers currently holding a task. */
const busy = (): FakeWorker[] => FakeWorker.instances.filter((w) => w.inFlight !== null);
/** Let queued promise callbacks run. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const SCRIPT = '/build/workers/task.js';

beforeEach(() => {
  FakeWorker.instances = [];
});

describe('createPool', () => {
  it('spawns exactly `size` workers against the given script path', () => {
    const pool = createPool(2, SCRIPT);
    expect(pool.size()).toBe(2);
    expect(FakeWorker.instances).toHaveLength(2);
    expect(FakeWorker.instances[0]!.scriptPath).toBe(SCRIPT);
  });

  it('rejects a non-positive size', () => {
    expect(() => createPool(0, SCRIPT)).toThrow(TypeError);
  });

  it('runs at most `size` tasks concurrently and queues the rest', async () => {
    const pool = createPool(2, SCRIPT);

    const a = pool.run('echo', 'a');
    const b = pool.run('echo', 'b');
    const c = pool.run('echo', 'c');

    // Only two workers exist, so the third submission must be waiting in the queue.
    expect(busy()).toHaveLength(2);
    expect(FakeWorker.instances).toHaveLength(2);

    // Freeing one worker lets the queued task start immediately.
    FakeWorker.instances[0]!.respond('a');
    await expect(a).resolves.toBe('a');
    expect(busy()).toHaveLength(2);
    expect(FakeWorker.instances[0]!.inFlight?.data).toBe('c');

    FakeWorker.instances[1]!.respond('b');
    FakeWorker.instances[0]!.respond('c');
    await expect(b).resolves.toBe('b');
    await expect(c).resolves.toBe('c');
  });

  it('correlates replies by taskId, not submission order', async () => {
    const pool = createPool(2, SCRIPT);
    const first = pool.run('echo', 1);
    const second = pool.run('echo', 2);

    // Second worker answers first.
    FakeWorker.instances[1]!.respond('second');
    FakeWorker.instances[0]!.respond('first');

    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
  });

  it('ignores a reply whose taskId does not match the in-flight task', async () => {
    const pool = createPool(1, SCRIPT);
    const task = pool.run('echo', 'x');
    const worker = FakeWorker.instances[0]!;

    worker.emit('message', { taskId: 'stale-id', ok: true, value: 'wrong' });
    worker.respond('right');

    await expect(task).resolves.toBe('right');
  });

  it('fails only the failing task and stays usable afterwards', async () => {
    const pool = createPool(2, SCRIPT);
    const bad = pool.run('__throw_for_test__', null);
    const good = pool.run('echo', 'ok');

    FakeWorker.instances[0]!.fail('intentional test failure');
    FakeWorker.instances[1]!.respond('ok');

    await expect(bad).rejects.toThrow('intentional test failure');
    await expect(good).resolves.toBe('ok');

    // Pool still healthy: no worker was replaced and a new task runs normally.
    expect(FakeWorker.instances).toHaveLength(2);
    const next = pool.run('echo', 'after');
    FakeWorker.instances[0]!.respond('after');
    await expect(next).resolves.toBe('after');
  });

  it('replaces a crashed worker, rejects its in-flight task, and drains the backlog', async () => {
    const pool = createPool(1, SCRIPT);
    const crashed = pool.run('echo', 'doomed');
    const queued = pool.run('echo', 'survivor');

    const dead = FakeWorker.instances[0]!;
    expect(dead.inFlight?.data).toBe('doomed');

    dead.crash('thread died');

    // In-flight task fails instead of hanging forever.
    await expect(crashed).rejects.toThrow('thread died');
    expect(dead.terminated).toBe(true);

    // A replacement worker exists and has picked up the queued task.
    expect(FakeWorker.instances).toHaveLength(2);
    expect(pool.size()).toBe(1);
    const replacement = FakeWorker.instances[1]!;
    expect(replacement.inFlight?.data).toBe('survivor');

    replacement.respond('survivor');
    await expect(queued).resolves.toBe('survivor');
  });

  it('replaces a worker that exits unexpectedly', async () => {
    const pool = createPool(1, SCRIPT);
    const task = pool.run('echo', 'x');

    FakeWorker.instances[0]!.emit('exit', 1);

    await expect(task).rejects.toThrow(/exited unexpectedly with code 1/);
    expect(FakeWorker.instances).toHaveLength(2);
    expect(pool.size()).toBe(1);
  });

  it('drain() resolves only after queued and in-flight tasks have settled', async () => {
    const pool = createPool(1, SCRIPT);
    const inFlight = pool.run('echo', 'a');
    const queued = pool.run('echo', 'b');

    let drained = false;
    const draining = pool.drain().then(() => {
      drained = true;
    });

    await flush();
    expect(drained).toBe(false);

    FakeWorker.instances[0]!.respond('a');
    await expect(inFlight).resolves.toBe('a');
    await flush();
    // The queued task is still outstanding.
    expect(drained).toBe(false);

    FakeWorker.instances[0]!.respond('b');
    await expect(queued).resolves.toBe('b');
    await draining;
    expect(drained).toBe(true);
  });

  it('drain() counts rejected tasks as settled and resolves immediately when idle', async () => {
    const pool = createPool(1, SCRIPT);
    await expect(pool.drain()).resolves.toBeUndefined();

    const failing = pool.run('__throw_for_test__', null);
    const draining = pool.drain();
    FakeWorker.instances[0]!.fail('boom');

    await expect(failing).rejects.toThrow('boom');
    await expect(draining).resolves.toBeUndefined();
  });

  it('processes tasks in FIFO order', async () => {
    const pool = createPool(1, SCRIPT);
    const completed: string[] = [];
    const labels = ['t1', 't2', 't3', 't4'];

    const tasks = labels.map((label) =>
      pool.run<string>('echo', label).then((value) => {
        completed.push(value);
        return value;
      }),
    );

    const worker = FakeWorker.instances[0]!;
    const started: string[] = [];
    for (const _ of labels) {
      const current = worker.inFlight?.data as string;
      started.push(current);
      worker.respond(current);
      await flush();
    }

    await Promise.all(tasks);
    expect(started).toEqual(labels);
    expect(completed).toEqual(labels);
  });
});
