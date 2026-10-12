// Keep the literal URL at the construction site so Vite bundles this worker.
export function spawnFaucetPowWorker(): Worker {
  return new Worker(new URL('./faucet-pow-worker.ts', import.meta.url), { type: 'module' });
}
