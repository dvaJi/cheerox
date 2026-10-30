import { requireNative, type NativeWorkerPoolInfo } from './native.js';

export interface WorkerOptions { threads: number }
export type WorkerPoolInfo = NativeWorkerPoolInfo;

/** Set the process-wide native CPU-worker budget before starting async work. */
export function configureWorkers(options: WorkerOptions | number): WorkerPoolInfo {
  const threads = typeof options === 'number' ? options : options?.threads;
  if (!Number.isSafeInteger(threads) || threads < 1 || threads > 256) throw new RangeError('threads must be an integer from 1 to 256');
  const binding = requireNative();
  if (!binding.configureWorkerPool || !binding.workerPoolInfo) throw new Error('This native build does not support a shared worker pool');
  binding.configureWorkerPool(threads);
  return binding.workerPoolInfo();
}

/** Observe the configured budget and actual concurrent native CPU work. */
export function workerPoolInfo(): WorkerPoolInfo {
  const binding = requireNative();
  if (!binding.workerPoolInfo) throw new Error('This native build does not support worker pool diagnostics');
  return binding.workerPoolInfo();
}
