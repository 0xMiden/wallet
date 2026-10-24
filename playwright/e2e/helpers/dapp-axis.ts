import { expect } from '@playwright/test';

import { InfrastructureFault, type AxisLabel } from './dapp-cells';
import { normalizeHex } from './dapp-gates';
import pinned from './dapp-pinned.json';
import { guardianAxis, offChainAxis, type AccountAxis } from './money-path';
import { getEnvironmentConfig } from '../config/environments';
import type { GuardianAwareWalletPage } from '../fixtures/two-wallets';
import type { EnvironmentConfig } from '../harness/types';

/**
 * The money-path account axis plus what a dApp journey needs per kind. Per-kind behaviour lives here as data, so no
 * spec asserts inside a branch (eslint-rules/no-conditional-expect.js).
 */
export const NOT_APPLICABLE = 'not-applicable';
// waitForGuardianLedgerSettled's timeout (harness/guardian-commitments.ts).
const CANONICALIZATION_TIMEOUT = /the guardian has not canonicalized the last pushed delta/;

export interface DappAxis extends AccountAxis {
  readonly label: AxisLabel;
  /** Runs before the wallet's account is created. */
  prepare(wallet: GuardianAwareWalletPage): void;
  /** Waits until nothing the last write started is still settling off chain. */
  settle(wallet: GuardianAwareWalletPage): Promise<void>;
  guardianCommitment(wallet: GuardianAwareWalletPage, account: string): Promise<string>;
  /** Whether the key connect handed out is one of the account's signers, or `NOT_APPLICABLE`. */
  connectKeyMembership(wallet: GuardianAwareWalletPage, account: string, publicKeyHex: string): Promise<string>;
  readonly expected: {
    guardianInfo(env: EnvironmentConfig): unknown;
    connectKeyMembership: string;
    guardianCommitment(chainCommitmentHex: string): string;
    builder: 'plain' | 'guardian-twin';
    /** Single-sig previews gross note flows (decode.ts:212-227); Guardian the net vault delta (decode.ts:95-128). */
    previewAmount: 'gross' | 'net';
  };
}

export const offchainDappAxis: DappAxis = {
  ...offChainAxis,
  label: 'offchain',
  prepare: () => undefined,
  settle: async () => undefined,
  guardianCommitment: async () => NOT_APPLICABLE,
  connectKeyMembership: async () => NOT_APPLICABLE,
  expected: {
    guardianInfo: () => ({
      isGuardianAccount: false,
      guardianEndpoint: null,
      guardianProvider: null,
      guardianSyncStatus: null
    }),
    connectKeyMembership: NOT_APPLICABLE,
    guardianCommitment: () => NOT_APPLICABLE,
    builder: 'plain',
    previewAmount: 'gross'
  }
};

export function guardianDappAxis(guardianUrl: string): DappAxis {
  const comparable = pinned.guardianCommitmentComparable === true;
  return {
    ...guardianAxis(guardianUrl),
    label: 'guardian',
    // The settle ledger has to see the first delta push, so tracking starts before the wallet transacts.
    prepare: wallet => wallet.trackGuardianCommitments(),
    // Every run is against a hosted operator. A settle follows the write's chain step, so only the operator's
    // canonicalization timing out is infrastructure (spec section 6). The settle's other refusals, a missing ledger
    // or no push seen (harness/guardian-commitments.ts:154-159), are the harness's own and stay as they are.
    settle: wallet =>
      wallet.waitForGuardianSettled().catch((error: unknown) => {
        const text = error instanceof Error ? error.message : String(error);
        if (!CANONICALIZATION_TIMEOUT.test(text)) throw error;
        throw new InfrastructureFault(`Guardian settle against ${guardianUrl}: ${text}`);
      }),
    guardianCommitment: async (wallet, account) => {
      const view = comparable ? await wallet.guardianOperatorView(account, guardianUrl) : undefined;
      return view === undefined ? NOT_APPLICABLE : normalizeHex(view.commitment ?? `missing: ${view.error ?? 'none'}`);
    },
    connectKeyMembership: async (wallet, account, publicKeyHex) => {
      const info = await wallet.getGuardianAuthInfo(account);
      return info.signerCommitments.map(normalizeHex).includes(normalizeHex(publicKeyHex)) ? 'member' : 'not-member';
    },
    expected: {
      guardianInfo: env => ({
        isGuardianAccount: true,
        guardianEndpoint: env.guardianUrl,
        guardianProvider: expect.any(String),
        guardianSyncStatus: 'in-sync'
      }),
      connectKeyMembership: 'member',
      guardianCommitment: chain => (comparable ? normalizeHex(chain) : NOT_APPLICABLE),
      builder: 'guardian-twin',
      previewAmount: 'net'
    }
  };
}

/** Both legs, against the run's network's hosted Guardian. */
export const dappAxes = (): DappAxis[] => {
  const env = getEnvironmentConfig();
  return [offchainDappAxis, guardianDappAxis(env.guardianUrl)];
};
