import { expect } from '@playwright/test';

import { NOT_APPLICABLE } from './dapp-axis';
import { InfrastructureFault, type AxisLabel, type Deadline } from './dapp-cells';
import { normalizeHex } from './dapp-gates';
import { currentGuardianEndpoint, guardianOperatorView, type MobileWallet } from './dapp-mobile-wallet';
import { getEnvironmentConfig } from '../config/environments';
import type { EnvironmentConfig } from '../harness/types';

/**
 * The mobile `DappAxis` (spec 3.5): each account kind on purpose, since production onboarding creates Guardian accounts
 * only and the test bypass makes the single-sig one. The Guardian checks read the store and the operator through the
 * webview, where the extension's read its page and its own request capture.
 */
export interface MobileDappAxis {
  readonly label: AxisLabel;
  /** What `createAccount` builds for this kind, for the journey's second account (M1). */
  readonly walletType: 'off-chain' | 'guardian';
  create(wallet: MobileWallet): Promise<{ address: string }>;
  /** Waits until nothing the last write started is still settling off chain; `null` is an account the chain never saw. */
  settle(wallet: MobileWallet, account: string, chainCommitmentHex: string | null, deadline: Deadline): Promise<void>;
  /** Whether the key connect handed out is one of the account's signers, or `NOT_APPLICABLE`. */
  connectKeyMembership(wallet: MobileWallet, account: string, publicKeyHex: string): Promise<string>;
  readonly expected: {
    guardianInfo(env: EnvironmentConfig): unknown;
    connectKeyMembership: string;
    builder: 'plain' | 'guardian-twin';
  };
}

export interface AxisTiming {
  endpointMs: number;
  settleMs: number;
  pollMs: number;
}
const TIMING: AxisTiming = { endpointMs: 30_000, settleMs: 120_000, pollMs: 5_000 };
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export const mobileOffchainAxis: MobileDappAxis = {
  label: 'offchain',
  walletType: 'off-chain',
  create: wallet => wallet.createNewWallet(),
  settle: async () => undefined,
  connectKeyMembership: async () => NOT_APPLICABLE,
  expected: {
    guardianInfo: () => ({
      isGuardianAccount: false,
      guardianEndpoint: null,
      guardianProvider: null,
      guardianSyncStatus: null
    }),
    connectKeyMembership: NOT_APPLICABLE,
    builder: 'plain'
  }
};

export function mobileGuardianAxis(guardianUrl: string, timing: AxisTiming = TIMING): MobileDappAxis {
  return {
    label: 'guardian',
    walletType: 'guardian',
    // The bypass names the network's default operator; an account on any other endpoint is not this leg's kind.
    create: async wallet => {
      const created = await wallet.createGuardianWallet();
      const until = Date.now() + timing.endpointMs;
      let endpoint = await currentGuardianEndpoint(wallet);
      while (endpoint !== guardianUrl && Date.now() < until) {
        await sleep(1_000);
        endpoint = await currentGuardianEndpoint(wallet);
      }
      if (endpoint !== guardianUrl) {
        throw new Error(`the new account's Guardian endpoint is ${endpoint || 'unset'}, expected ${guardianUrl}`);
      }
      return created;
    },
    // The operator refuses a new proposal while the last delta is a candidate (KB guardian-state-advances-
    // asynchronously-after-execute), so the next write waits until it holds the chain's commitment.
    settle: async (wallet, account, chainCommitmentHex, deadline) => {
      if (chainCommitmentHex === null) return;
      const want = normalizeHex(chainCommitmentHex);
      const until = Date.now() + Math.min(timing.settleMs, deadline.remainingMs());
      let last = '';
      for (;;) {
        const view = await guardianOperatorView(wallet, account, guardianUrl);
        last =
          view.commitment === undefined ? `no commitment (${view.error ?? 'no error'})` : normalizeHex(view.commitment);
        if (last === want) return;
        if (Date.now() + timing.pollMs > until) break;
        await sleep(timing.pollMs);
      }
      throw new InfrastructureFault(
        `Guardian settle against ${guardianUrl}: the operator holds ${last}, the chain ${want}`
      );
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
      builder: 'guardian-twin'
    }
  };
}

/** Both legs, against the run's network's hosted Guardian. */
export const mobileDappAxes = (): MobileDappAxis[] => [
  mobileOffchainAxis,
  mobileGuardianAxis(getEnvironmentConfig().guardianUrl)
];
