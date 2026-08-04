import { DEPOSIT_TOKEN_IDS, getDepositToken, type DepositTokenId } from './tokens';
import { watermarkKey, type DepositWatermarkStore } from './watermarks';

/** One detected, not-yet-acknowledged deposit. */
export interface DepositArrival {
  /** `${lowercasedAddress}:${token}` — stable across ticks for the same balance. */
  key: string;
  address: string;
  token: DepositTokenId;
  /** Balance delta over the acknowledged watermark (base units). */
  amount: bigint;
  /** Full current balance (base units) — what an acknowledge raises the watermark to. */
  balance: bigint;
  /** The arrival drawer was already opened for this exact balance. */
  drawerShown: boolean;
}

/** A watermark write the caller must persist for the detection to stay correct. */
export interface DepositWatermarkCorrection {
  token: DepositTokenId;
  acknowledged: bigint;
  drawerShown: bigint;
}

export interface DetectArrivalsArgs {
  address: string;
  balances: Partial<Record<DepositTokenId, bigint | null>>;
  store: DepositWatermarkStore;
}

export interface DetectArrivalsResult {
  arrivals: DepositArrival[];
  corrections: DepositWatermarkCorrection[];
}

function parseMark(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

/**
 * Pure arrival detection. Four rules, in order:
 *
 *  1. No record ⇒ SEED at the current balance and report no arrival. This is the
 *     upgrade path: an address already holding funds must not prompt on the very
 *     first poll after the feature ships.
 *  2. `balance < acknowledged` ⇒ CLAMP both marks down to the balance. Critical:
 *     a bridge drops the balance, and without the clamp every later deposit
 *     smaller than the pre-bridge balance would be invisible forever.
 *  3. `balance > acknowledged` ⇒ arrival of the delta.
 *  4. A delta below the token's dust floor is ignored — and NOT seeded, so a
 *     later top-up that crosses the floor still reports the cumulative delta.
 */
export function detectArrivals({ address, balances, store }: DetectArrivalsArgs): DetectArrivalsResult {
  const arrivals: DepositArrival[] = [];
  const corrections: DepositWatermarkCorrection[] = [];

  for (const token of DEPOSIT_TOKEN_IDS) {
    const raw = balances[token];
    if (raw === null || raw === undefined) continue;

    const record = store[watermarkKey(address, token)];
    if (!record) {
      corrections.push({ token, acknowledged: raw, drawerShown: raw });
      continue;
    }

    const acknowledged = parseMark(record.acknowledged);
    const drawerShown = parseMark(record.drawerShown);

    if (raw < acknowledged) {
      corrections.push({ token, acknowledged: raw, drawerShown: drawerShown > raw ? raw : drawerShown });
      continue;
    }
    if (raw === acknowledged) continue;

    const amount = raw - acknowledged;
    if (amount < getDepositToken(token).dustFloor) continue;

    arrivals.push({
      key: watermarkKey(address, token),
      address,
      token,
      amount,
      balance: raw,
      drawerShown: raw <= drawerShown
    });
  }

  return { arrivals, corrections };
}
