import { Worker } from 'node:worker_threads';

/** Reused, globally bounded workers; input and result structured clones count. */
export class CheerioPool {
  constructor(threads) {
    this.threads = threads; this.workers = []; this.queue = []; this.pending = new Map();
    this.next = 1; this.active = 0; this.peakActive = 0;
    this.ready = Promise.all(Array.from({ length: threads }, () => new Promise((resolve, reject) => {
      const worker = new Worker(new URL('./cheerio-worker.mjs', import.meta.url));
      const slot = { worker, busy: false }; this.workers.push(slot);
      worker.on('error', (error) => { reject(error); for (const task of this.pending.values()) task.reject(error); });
      worker.on('message', (message) => {
        if (message.ready) { resolve(); this.dispatch(); return; }
        const task = this.pending.get(message.id); this.pending.delete(message.id);
        slot.busy = false; this.active--;
        if (message.error) task.reject(new Error(message.error)); else task.resolve(message.result);
        this.dispatch();
      });
    })));
  }
  dispatch() {
    for (const slot of this.workers) if (!slot.busy && this.queue.length) {
      const task = this.queue.shift(); slot.busy = true; this.active++;
      this.peakActive = Math.max(this.peakActive, this.active); this.pending.set(task.message.id, task);
      slot.worker.postMessage(task.message);
    }
  }
  task(message) { return new Promise((resolve, reject) => { this.queue.push({ message: { ...message, id: this.next++ }, resolve, reject }); this.dispatch(); }); }
  async run(documents, mode) {
    await this.ready;
    const chunks = Math.min(this.threads, documents.length);
    if (!chunks) return [];
    const size = Math.ceil(documents.length / chunks);
    return (await Promise.all(Array.from({ length: chunks }, (_, index) => documents.slice(index * size, (index + 1) * size)).filter((chunk) => chunk.length).map((chunk) => this.task({ documents: chunk, mode })))).flat();
  }
  async gc(requireGc = false) { await this.ready; await Promise.all(this.workers.map(() => this.task({ gc: true, requireGc }))); }
  info() { return { threads: this.threads, activeWorkers: this.active, peakActiveWorkers: this.peakActive }; }
  async close() { await Promise.all(this.workers.map(({ worker }) => worker.terminate())); }
}
