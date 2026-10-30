import { parentPort, workerData } from 'node:worker_threads';
import { LIBS } from './libs.mjs';

const lib = LIBS[workerData.lib];
parentPort.on('message', ({ id, pages }) => {
  parentPort.postMessage({ id, results: pages.map(lib.extract) });
});
