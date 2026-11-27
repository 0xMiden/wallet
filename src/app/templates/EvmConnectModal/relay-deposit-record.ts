/**
 * The form state that a pending relay deposit keeps (`PendingRelayDeposit.form`), so the deposit screen can open
 * again on that deposit, and the claim that lets one page only start the bridge of a pending deposit.
 */
import {
  type PendingRelayDeposit,
  parsePendingRelayDeposit,
  parsePendingRelayDeposits,
  pendingRelayDepositsKey
} from 'lib/evm-relay/pending-deposit';
import { fetchFromStorage, inStorageTurn, putToStorage } from 'lib/miden/front/storage';

import type { DepositToken } from './deposit-token';

/**
 * A route that a relay source can take: Agglayer, Epoch or Circle xReserve (`usdcx`). The pending record keeps the
 * route as an id that the relay library does not read; `decodeRoute` checks that a stored id is one of these.
 */
export type RelayRoute = 'agglayer' | 'epoch' | 'usdcx';

/** The deposit screen's form for one pending deposit. */
export interface RelayDepositForm {
  token: DepositToken;
  chainId: number;
  route: RelayRoute;
  /** The typed amount, decimal text. */
  amount: string;
}

const AMOUNT_TEXT = /^[0-9]+(\.[0-9]+)?$/;
const EPOCH_KEY = /^[A-Za-z0-9_-]{1,32}$/;
const CONTRACT = /^0x[0-9a-f]{40}$/;

function encodeToken(token: DepositToken): { tokenKind: string; tokenId: string } {
  if (typeof token === 'string') return { tokenKind: token, tokenId: '' };
  switch (token.kind) {
    case 'epoch':
      return { tokenKind: 'epoch', tokenId: token.key };
    case 'erc20':
      return { tokenKind: 'erc20', tokenId: token.contractAddress };
  }
}

function decodeToken(kind: string | undefined, id: string | undefined): DepositToken | null {
  switch (kind) {
    case 'ETH':
    case 'USDC':
    case 'CIRCLE_USDC':
      return kind;
    case 'epoch':
      return id !== undefined && EPOCH_KEY.test(id) ? { kind: 'epoch', key: id } : null;
    case 'erc20': {
      if (id === undefined || !CONTRACT.test(id)) return null;
      const contractAddress: `0x${string}` = `0x${id.slice(2)}`;
      return { kind: 'erc20', contractAddress };
    }
    default:
      return null;
  }
}

function decodeRoute(route: string | undefined): RelayRoute | null {
  switch (route) {
    case 'agglayer':
    case 'epoch':
    case 'usdcx':
      return route;
    default:
      return null;
  }
}

/** The route of a pending deposit, or null when there is no deposit or its route id is not one the screen knows. */
export function relayRouteOf(deposit: Pick<PendingRelayDeposit, 'route'> | null): RelayRoute | null {
  return deposit === null ? null : decodeRoute(deposit.route);
}

/** The fields of a pending deposit that the screen saves, with the route of the screen. */
export type RelayDepositFields = Omit<PendingRelayDeposit, 'route'> & { route: RelayRoute };

/**
 * The pending deposit record of `fields`, as the strict parser of the record reads it, or null when the record cannot
 * hold it (a route that the parser does not take, or a field that does not parse).
 */
export function pendingRelayDepositOf(fields: RelayDepositFields): PendingRelayDeposit | null {
  return parsePendingRelayDeposit(fields, fields.accountPublicKey);
}

/** The form as the strings that `PendingRelayDeposit.form` keeps. */
export function encodeRelayDepositForm(form: RelayDepositForm): Record<string, string> {
  return { ...encodeToken(form.token), chainId: String(form.chainId), route: form.route, amount: form.amount };
}

/** The form that `encodeRelayDepositForm` wrote, or null when `form` is missing or does not read back exactly. */
export function decodeRelayDepositForm(form: Record<string, string> | undefined): RelayDepositForm | null {
  if (form === undefined) return null;
  const token = decodeToken(form.tokenKind, form.tokenId);
  const route = decodeRoute(form.route);
  const chainId = Number(form.chainId);
  const amount = form.amount;
  if (token === null || route === null || amount === undefined || !AMOUNT_TEXT.test(amount)) return null;
  if (!Number.isSafeInteger(chainId) || chainId <= 0) return null;
  return { token, chainId, route, amount };
}

/**
 * Takes the pending deposit `id` of an account out of storage and gives it back, or null when it is not there (another
 * page took it, or the user removed it). The read and the write are one storage turn under the Web Lock of the key,
 * which every extension surface shares, so two pages cannot both take one deposit. The caller that gets the record
 * starts the bridge, and saves the record again when the bridge did not start.
 */
export async function claimPendingRelayDeposit(
  accountPublicKey: string,
  id: string
): Promise<PendingRelayDeposit | null> {
  const key = pendingRelayDepositsKey(accountPublicKey);
  return inStorageTurn(key, async () => {
    const deposits = parsePendingRelayDeposits(await fetchFromStorage(key), accountPublicKey);
    const claimed = deposits.find(deposit => deposit.id === id) ?? null;
    if (claimed !== null) {
      await putToStorage(
        key,
        deposits.filter(deposit => deposit.id !== id)
      );
    }
    return claimed;
  });
}
