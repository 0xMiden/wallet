import { findPowNonce } from './faucet-pow-solver';

globalThis.addEventListener('message', async (event: MessageEvent<{ challengeHex: string; target: bigint }>) => {
  try {
    const nonce = await findPowNonce(event.data.challengeHex, event.data.target);
    globalThis.postMessage({ nonce });
  } catch (error) {
    globalThis.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
});
