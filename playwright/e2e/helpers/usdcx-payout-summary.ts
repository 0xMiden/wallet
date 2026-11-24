import fs from 'fs';
import path from 'path';
import { formatUnits } from 'viem';

import { USDCX_DECIMALS } from '../../../src/lib/usdcx/protocol';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const HEADER = [
  '### USDCx payout fees',
  '',
  '| Suite | Chain | Burned (USDCx) | Received (USDC) | Circle fee (USDC) | Payout mint |',
  '| --- | --- | --- | --- | --- | --- |'
];

/** One proven payout: the suite and chain it ran on, the burn the node consumed and what Circle's mint paid. */
export interface PayoutFeeEntry {
  suite: string;
  chain: string;
  burnUnits: bigint;
  value: bigint;
  transactionHash: string;
}

/**
 * Appends `entry` as one row of a markdown table, writing the table's header first when `file` does not exist, and logs
 * the row. Circle's fee is whatever it kept of the burn, so the run reports it rather than gating on it; the E2E
 * workflows add the file to the job summary. `file` is relative to the repository root, under the Playwright output
 * directory by default.
 */
export function recordPayoutFee(entry: PayoutFeeEntry, file = 'test-results/usdcx-payout-fees.md'): void {
  const target = path.resolve(REPO_ROOT, file);
  const units = (amount: bigint) => formatUnits(amount, USDCX_DECIMALS);
  const row =
    `| ${entry.suite} | ${entry.chain} | ${units(entry.burnUnits)} | ${units(entry.value)} | ` +
    `${units(entry.burnUnits - entry.value)} | ${entry.transactionHash} |`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const lines = fs.existsSync(target) ? [row] : [...HEADER, row];
  fs.appendFileSync(target, `${lines.join('\n')}\n`);
  console.log(`USDCx payout fee: ${row}`);
}
