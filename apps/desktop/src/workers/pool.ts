/**
 * Fixed-size `worker_threads` pool, owned by the Electron main process.
 *
 * Why a pool at all: `better-sqlite3` is synchronous and Layer 1/2 inference calls are
 * long-running. Running either inline on main would block the event loop and freeze the
 * tray, so poller/extractor/synthesizer work is executed on worker threads instead.
 * Two workers is the intended production size — enough to overlap an I/O-bound poll
 * with a CPU/network-bound extraction without thrashing a laptop.
 *
 * Invariants:
 *  - Exactly `size` workers exist for the pool's lifetime; a worker that dies is
 *    replaced immediately so the queue keeps draining.
 *  - A worker handles at most one task at a time. Extra submissions queue in FIFO order.
 *  - Requests and responses are correlated by a generated `taskId`, never by array
 *    position: with more than one worker, responses arrive out of submission order.
 *  - Only structured-cloneable plain data crosses `postMessage`. Class instances,
 *    functions and the SQLite handle must not be passed; workers open their own
 *    read-only connections, and all writes stay on the main thread.
 *
 * The pool is deliberately agnostic about *where* the worker script lives — the caller
 * knows its own build output layout and passes an absolute path (or `file:` URL) to the
 * compiled `task.js`.
 */
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import type { WorkerTaskPayload, WorkerTaskResult } from './task.js';

/** Public handle returned by {@link createPool}. */
export interface Pool {
  /**
   * Submit one task. Resolves/rejects with *that* task's outcome only; a task that
   * throws inside its worker leaves the pool and every other task unaffected.
   *
   * @param kind Task-type discriminator understood by the worker script.
   * @param data Structured-cloneable input.
   */
  run<T = unknown>(kind: string, data: unknown): Promise<T>;
  /** Resolves once everything queued or in flight *at the time of the call* has settled. */
  drain(): Promise<void>;
  /** Number of workers in the pool (constant). */
  size(): number;
}

/** A submitted task awaiting dispatch or a reply. */
interface PendingTask {
  payload: WorkerTaskPayload;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}

/** One worker plus the task it is currently executing. */
interface Slot {
  worker: Worker;
  /** The in-flight task, or `null` when the worker is idle. */
  current: PendingTask | null;
}

/**
 * Create a fixed-size worker pool.
 *
 * @param size Number of worker threads. Must be a positive integer.
 * @param workerScriptPath Absolute path (or `file:` URL string) of the compiled worker
 *   entry point, e.g. `join(import.meta.dirname, 'workers/task.js')`.
 */
export function createPool(size: number, workerScriptPath: string): Pool {
  if (!Number.isInteger(size) || size < 1) {
    throw new TypeError(`pool size must be a positive integer, got ${String(size)}`);
  }
  if (!workerScriptPath) {
    throw new TypeError('workerScriptPath is required');
  }

  const slots: Slot[] = [];
  /** FIFO backlog of tasks with no free worker. */
  const queue: PendingTask[] = [];
  /** Resolvers for outstanding {@link Pool.drain} calls. */
  const drainWaiters: Array<() => void> = [];

  /**
   * Spawn a worker and wire it into `slot`. Used both at construction and for
   * replacing a dead worker in place, so the pool never shrinks.
   */
  function spawn(slot: Slot): void {
    const worker = new Worker(workerScriptPath);
    // Guards against handling the same death twice: Node emits `'error'` and then
    // `'exit'`, and our own `terminate()` of the corpse emits `'exit'` again.
    let retired = false;

    worker.on('message', (result: WorkerTaskResult) => {
      const task = slot.current;
      // Late reply from a task we already abandoned (worker death), or a mismatched
      // id — dropping it is safer than settling the wrong promise.
      if (!task || task.payload.taskId !== result.taskId) return;
      slot.current = null;
      if (result.ok) {
        task.resolve(result.value);
      } else {
        task.reject(new Error(result.error ?? 'worker task failed'));
      }
      pump();
    });

    const die = (reason: Error): void => {
      if (retired) return;
      retired = true;
      worker.removeAllListeners();
      // Best effort: the thread may already be gone, and we never want the corpse to
      // outlive its replacement.
      void worker.terminate().catch(() => undefined);

      const task = slot.current;
      slot.current = null;
      // Replace before draining the queue so the backlog has somewhere to go.
      spawn(slot);
      // The in-flight task can never get a reply now; fail it instead of hanging.
      if (task) task.reject(reason);
      pump();
    };

    worker.on('error', (err: Error) => {
      die(err instanceof Error ? err : new Error(String(err)));
    });
    worker.on('exit', (code: number) => {
      die(new Error(`worker exited unexpectedly with code ${code}`));
    });

    slot.worker = worker;
  }

  /** Hand queued tasks to idle workers until one side runs out. */
  function pump(): void {
    for (;;) {
      const slot = slots.find((s) => s.current === null);
      if (!slot) break; // every worker busy — the rest stays queued
      const task = queue.shift();
      if (!task) break; // nothing left to dispatch
      slot.current = task;
      try {
        slot.worker.postMessage(task.payload);
      } catch (err) {
        // Almost always a non-cloneable payload. Fail this task only; the worker is
        // still healthy, so the loop keeps feeding it the rest of the queue.
        slot.current = null;
        task.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
    settleDrains();
  }

  /** Resolve pending {@link Pool.drain} promises once nothing is outstanding. */
  function settleDrains(): void {
    if (drainWaiters.length === 0) return;
    if (queue.length > 0) return;
    if (slots.some((slot) => slot.current !== null)) return;
    // Splice first: a waiter's continuation could submit more work.
    for (const resolve of drainWaiters.splice(0, drainWaiters.length)) resolve();
  }

  for (let i = 0; i < size; i += 1) {
    // `spawn` needs the slot to close over, and assigns `worker` synchronously before
    // returning; the cast only bridges those two statements.
    const slot: Slot = { worker: null as unknown as Worker, current: null };
    spawn(slot);
    slots.push(slot);
  }

  return {
    run<T = unknown>(kind: string, data: unknown): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        queue.push({
          payload: { taskId: randomUUID(), kind, data },
          resolve: resolve as (value: unknown) => void,
          reject,
        });
        pump();
      });
    },

    drain(): Promise<void> {
      if (queue.length === 0 && slots.every((slot) => slot.current === null)) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        drainWaiters.push(resolve);
      });
    },

    size(): number {
      return slots.length;
    },
  };
}
