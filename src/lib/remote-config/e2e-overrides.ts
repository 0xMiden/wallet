export interface MidenUsdc {
  faucetId: string;
  symbol: string;
  decimals: number;
}

export interface E2eOverrides {
  earnCollateralFaucet: MidenUsdc | null;
}

// The Earn suite creates its collateral faucet at runtime, so it can put it neither in the served document nor on
// chain. Every function is a no-op unless the build defines MIDEN_E2E_TEST as 'true'.
const INERT: E2eOverrides = { earnCollateralFaucet: null };
// One object per state, so useSyncExternalStore sees a change only when a setter made one.
let snapshot: E2eOverrides = INERT;
const listeners = new Set<() => void>();

const enabled = () => process.env.MIDEN_E2E_TEST === 'true';

function publish(next: E2eOverrides): void {
  snapshot = next;
  for (const listener of [...listeners]) listener();
}

/** The same object until a setter changes it; do not mutate it. */
export function getE2eOverrides(): E2eOverrides {
  return enabled() ? snapshot : INERT;
}

export function subscribeE2eOverrides(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** symbol defaults to 'USDC' and decimals to 6, matching the Earn E2E faucet. The id is stored lowercase. */
export function setEarnCollateralFaucetOverride(
  override: { faucetId: string; symbol?: string; decimals?: number } | null
): void {
  if (!enabled()) return;
  publish({
    earnCollateralFaucet: override && {
      faucetId: override.faucetId.toLowerCase(),
      symbol: override.symbol ?? 'USDC',
      decimals: override.decimals ?? 6
    }
  });
}

export function _resetE2eOverridesForTest(): void {
  publish({ earnCollateralFaucet: null });
}
