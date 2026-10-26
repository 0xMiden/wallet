/**
 * @jest-environment node
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { recordPayoutFee } from './usdcx-payout-summary';

const SEPOLIA_MINT = '0x5be8f3e3b7a1f2a4b6e9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1';
const ARC_MINT = '0x0d9d4f2b1c7a5e3f9b8a6c4d2e0f1a3b5c7d9e1f2a4b6c8d0e2f4a6b8c0d2e4f';

describe('recordPayoutFee', () => {
  it('appends one row per payout under a single header', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'usdcx-fees-')), 'nested', 'usdcx-payout-fees.md');
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    recordPayoutFee(
      {
        suite: 'usdcx-burn-l2 sepolia',
        chain: 'Ethereum Sepolia',
        burnUnits: 5_000_000n,
        value: 2_436_500n,
        transactionHash: SEPOLIA_MINT
      },
      file
    );
    recordPayoutFee(
      {
        suite: 'usdcx-burn standard',
        chain: 'Arc',
        burnUnits: 5_000_000n,
        value: 4_983_600n,
        transactionHash: ARC_MINT
      },
      file
    );

    const sepoliaRow = `| usdcx-burn-l2 sepolia | Ethereum Sepolia | 5 | 2.4365 | 2.5635 | ${SEPOLIA_MINT} |`;
    const arcRow = `| usdcx-burn standard | Arc | 5 | 4.9836 | 0.0164 | ${ARC_MINT} |`;
    expect(readFileSync(file, 'utf8')).toBe(
      [
        '### USDCx payout fees',
        '',
        '| Suite | Chain | Burned (USDCx) | Received (USDC) | Circle fee (USDC) | Payout mint |',
        '| --- | --- | --- | --- | --- | --- |',
        sepoliaRow,
        arcRow,
        ''
      ].join('\n')
    );
    expect(log.mock.calls).toEqual([[`USDCx payout fee: ${sepoliaRow}`], [`USDCx payout fee: ${arcRow}`]]);
    log.mockRestore();
  });
});
