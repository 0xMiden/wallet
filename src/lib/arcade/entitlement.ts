import { AccountStorageRequirements, RpcClient, SlotAndKeys, Word } from '@miden-sdk/miden-sdk/lazy';

import { accountRefToSdk } from 'lib/miden/sdk/helpers';
import { ensureSdkWasmReady, getRpcEndpoint } from 'lib/miden-chain/constants';
import { getEffectiveNetworkName } from 'lib/miden-chain/effective-endpoints';
import { withRpcTimeout } from 'lib/miden-chain/rpc-timeout';

const CLAIMS_SLOT = 'bread::gc::weekly_claims';
const NETWORK_SLOT = 'bread::gc::network';
const WEEK_SECONDS = 604800;
const MONDAY_OFFSET = 259200;

export interface GcIssuerIdentity {
  genesisCommitment: string;
  issuerId: string;
  issuerCodeCommitment: string;
}

export interface GcEntitlement {
  approvedWeek: number;
  claimed: boolean;
  referenceBlock: number;
  referenceTimestamp: number;
  verificationBaseFee: number;
  nextEligibleAt: string;
}

/** Fresh trusted-RPC observations; SDK account proofs are not independently bound to a header root here. */
export async function readGcEntitlement(config: GcIssuerIdentity, accountId: string): Promise<GcEntitlement> {
  if (getEffectiveNetworkName() !== 'testnet') throw new Error('GC claims are configured for Testnet only');
  await ensureSdkWasmReady();
  return withRpcTimeout(
    async () => {
      const rpc = new RpcClient(getRpcEndpoint());
      try {
        const genesis = await rpc.getBlockHeaderByNumber(0);
        if (genesis.commitment().toHex() !== config.genesisCommitment) throw new Error('GC genesis mismatch');
        const header = await rpc.getBlockHeaderByNumber();
        const referenceBlock = header.blockNum();
        const referenceTimestamp = header.timestamp();
        const verificationBaseFee = header.verificationBaseFee();
        if (
          ![referenceBlock, referenceTimestamp, verificationBaseFee].every(
            value => Number.isSafeInteger(value) && value >= 0
          ) ||
          referenceTimestamp > 0xffffffff
        ) {
          throw new Error('Invalid GC reference block');
        }
        const approvedWeek = Math.floor((referenceTimestamp + MONDAY_OFFSET) / WEEK_SECONDS);
        const account = accountRefToSdk(accountId);
        const key = new Word(
          new BigUint64Array([account.suffix().asInt(), account.prefix().asInt(), BigInt(approvedWeek), 0n])
        );
        // SlotAndKeys takes the key by value. Keep its identity before handing the handle over.
        const keyHex = key.toHex();
        const issuer = accountRefToSdk(config.issuerId);
        const issuerHex = issuer.toString();
        const proof = await rpc.getAccountProof(
          issuer,
          AccountStorageRequirements.fromSlotAndKeysArray([new SlotAndKeys(CLAIMS_SLOT, [key])]),
          referenceBlock
        );
        if (
          proof.blockNum() !== referenceBlock ||
          proof.accountId().toString() !== issuerHex ||
          proof.accountHeader()?.codeCommitment().toHex() !== config.issuerCodeCommitment ||
          proof.getStorageSlotValue(NETWORK_SLOT)?.toHex() !== config.genesisCommitment
        ) {
          throw new Error('GC issuer proof does not match the approved deployment');
        }
        const entries = proof.getStorageMapEntries(CLAIMS_SLOT);
        if (proof.hasStorageMapTooManyEntries(CLAIMS_SLOT) !== false || !entries) {
          throw new Error('GC weekly entitlement proof is unavailable');
        }
        const entry = entries.find(item => item.key().toHex() === keyHex);
        if (!entry) throw new Error('GC weekly entitlement key is missing');
        const values = Array.from(entry.value().toU64s());
        if (
          values.length !== 4 ||
          (values[0] !== 0n && values[0] !== 1n) ||
          values.slice(1).some(value => value !== 0n)
        ) {
          throw new Error('Invalid GC weekly entitlement value');
        }
        return {
          approvedWeek,
          claimed: values[0] === 1n,
          referenceBlock,
          referenceTimestamp,
          verificationBaseFee,
          nextEligibleAt: new Date(((approvedWeek + 1) * WEEK_SECONDS - MONDAY_OFFSET) * 1000).toISOString()
        };
      } finally {
        // A timeout abandons the read, not the pending RPC; free only once that read settles.
        rpc.free();
      }
    },
    'GC entitlement',
    { retries: 0 }
  );
}
