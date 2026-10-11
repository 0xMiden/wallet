/**
 * @jest-environment node
 */
import os from 'os';
import path from 'path';
import { keccak256, toBytes } from 'viem';

import {
  ARC_ATTESTATION_API,
  ARC_CHAIN_ID,
  ARC_CIRCLE_DOMAIN,
  ARC_DRPC_URL,
  ARC_KEY_LEDGER_DIR,
  ARC_PUBLIC_URL,
  ARC_QUICKNODE_URL,
  ARC_USDC,
  ARC_XRESERVE,
  ATTESTATION_USED_TOPIC,
  BURN_UNITS,
  DEFAULT_ARC_RPCS,
  DEPOSIT_UNITS,
  GAS_RESERVE_UNITS,
  GRANT_MARGIN_UNITS,
  minimumUsdcxPayout
} from './usdcx-constants';

describe('usdcx-constants', () => {
  it("reads the Arc Testnet xReserve source from the wallet's own table", () => {
    expect(ARC_CHAIN_ID).toBe(5042002);
    expect(ARC_XRESERVE).toBe('0x008888878f94C0d87defdf0B07f46B93C1934442');
    expect(ARC_USDC).toBe('0x3600000000000000000000000000000000000000');
    expect(ARC_ATTESTATION_API).toBe('https://xreserve-api-testnet.circle.com');
    expect(ARC_CIRCLE_DOMAIN).toBe(26);
  });

  it('names the GatewayMinter mint event by its signature hash', () => {
    expect(ATTESTATION_USED_TOPIC).toBe(
      keccak256(toBytes('AttestationUsed(address,address,bytes32,uint32,bytes32,bytes32,uint256)'))
    );
  });

  it("reads Arc through drpc, then QuickNode, and the wallet's own arc.io last", () => {
    expect(DEFAULT_ARC_RPCS).toEqual([ARC_DRPC_URL, ARC_QUICKNODE_URL, ARC_PUBLIC_URL]);
    expect(ARC_PUBLIC_URL).toBe('https://rpc.testnet.arc.io');
  });

  it('keeps the key ledger in the home directory, outside the repository', () => {
    expect(ARC_KEY_LEDGER_DIR).toBe(path.join(os.homedir(), '.miden-e2e', 'arc-keys'));
  });

  it('sizes the round trip so the payout floor and the deposit back both fit', () => {
    expect(BURN_UNITS).toBe(10_000_000n);
    expect(GRANT_MARGIN_UNITS).toBe(1_000_000n);
    expect(minimumUsdcxPayout(ARC_CHAIN_ID, BURN_UNITS) >= DEPOSIT_UNITS + GAS_RESERVE_UNITS).toBe(true);
  });
});
