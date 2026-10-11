#!/usr/bin/env node
/**
 * E2E USDCx (.github/workflows/e2e-usdcx.yml) only: writes the repository secret USDCX_HARNESS_ARC_KEY as the runner's
 * harness Arc key file before any usdcx suite runs. Without that file the runner creates a fresh key, and the payouts
 * it collects would leave with the runner. Prints the address, never the key.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';

import { HARNESS_ARC_KEY_FILE, writeHarnessArcKey } from './e2e-real.mjs';

export const SECRET_NAME = 'USDCX_HARNESS_ARC_KEY';

/**
 * Writes `secret` to `file` as a harness key entry. Returns `{ address }`, or `{ error }` with nothing written. No
 * message carries the key.
 */
export async function writeCiHarnessArcKey(file, secret) {
  const privateKey = (secret ?? '').trim();
  if (privateKey === '') {
    return { error: `${SECRET_NAME} is not set: store the CI harness Arc key as that repository secret` };
  }
  // The one form the runner reads. GitHub masks the secret as stored, so a lowercased copy would reach logs unmasked.
  if (!/^0x[0-9a-f]{64}$/.test(privateKey)) return { error: `${SECRET_NAME} is not 0x and 64 lowercase hex` };
  try {
    privateKeyToAccount(privateKey);
  } catch {
    // viem's own message can carry the key's value.
    return { error: `${SECRET_NAME} is not a valid secp256k1 private key` };
  }
  try {
    return { address: await writeHarnessArcKey(file, privateKey) };
  } catch (err) {
    if (err?.code === 'EEXIST') return { error: `${file} already exists; it may hold USDC, so it is never replaced` };
    return { error: `cannot write ${file}: ${err?.code ?? 'unknown error'}` };
  }
}

// Only when run as a command, as scripts/e2e-real.mjs guards its own main.
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  writeCiHarnessArcKey(HARNESS_ARC_KEY_FILE, process.env[SECRET_NAME]).then(result => {
    if (result.error !== undefined) {
      console.error(`::error title=CI harness Arc key::${result.error}`);
      process.exit(1);
    }
    console.log(`CI harness Arc key ${result.address} written to ${HARNESS_ARC_KEY_FILE}`);
  });
}
