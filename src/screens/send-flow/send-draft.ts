/**
 * In-memory handoff between the send form (`/send`, mounted under TabLayout's
 * HomeSwipeContainer) and the full-screen review page (`/send/review`). The two
 * routes live in disjoint React trees, so SendManager fully unmounts when the
 * user confirms the amount; backing out of review would otherwise land on an
 * empty recipient step. The draft lets SendManager restore the entered values
 * and reopen on the Amount step.
 *
 * Module-scoped on purpose: the draft should live exactly as long as the JS
 * context (like the form state it mirrors), never persist, and needs no
 * reactivity — it's read once on mount.
 */
import { createListenerSet } from 'lib/listener-set';
import type { AccountScope } from 'lib/miden-chain/account-scope';

import { BridgeNetworkId } from './bridge-networks';
import { BridgeRoute } from './types';

export interface SendDraft {
  amount: string;
  recipientAddress: string;
  tokenId: string;
  reviewEntry?: string;
  /** Destination network (a `SendNetwork` id, EVM or NEAR Intents), only set when the recipient is not a Miden address. */
  bridgeNetwork?: BridgeNetworkId;
  /** Cross-chain route, only set when the recipient is not a Miden address. */
  bridgeRoute?: BridgeRoute;
  /**
   * The Miden Name that the recipient input resolved to. Only set when the
   * input is a name (for example `alice.miden`). Command admission keeps the
   * resolved address in `recipientAddress`, and `input` restores the editable name.
   */
  midenName?: SendDraftMidenName;
}

export interface SendDraftMidenName {
  /** The label without ".miden". */
  label: string;
  /** The bech32 address that the label resolved to. */
  address: string;
  input: string;
  registryScope: string;
}

let draft: SendDraft | null = null;

export interface CompactSendAdmission {
  sessionToken: number;
  txId?: string;
}

// A wallet lock removes the review tree while the in-process producer can still return a row.
const admissions = new Map<string, CompactSendAdmission>();
const admissionListeners = createListenerSet();
export const subscribeCompactSendAdmissions = admissionListeners.subscribe;

export function compactSendAdmissionKey(reviewEntry: string, scope: AccountScope): string {
  return JSON.stringify([reviewEntry, scope.accountId, scope.network, scope.rpcUrl]);
}

export function readCompactSendAdmission(key: string | undefined): CompactSendAdmission | undefined {
  return key === undefined ? undefined : admissions.get(key);
}

export function writeCompactSendAdmission(key: string, admission?: CompactSendAdmission): void {
  if (admission === undefined) admissions.delete(key);
  else admissions.set(key, admission);
  admissionListeners.notify();
}

export function hasOtherCompactSendAdmission(key: string | undefined, sessionToken: number): boolean {
  if (sessionToken === 0) return false;
  for (const [entry, admission] of admissions) {
    if (entry !== key && admission.sessionToken === sessionToken) return true;
  }
  return false;
}

export function sameSendDraft(first: SendDraft, second: SendDraft): boolean {
  return (
    first.amount === second.amount &&
    (first.midenName?.address ?? first.recipientAddress) === (second.midenName?.address ?? second.recipientAddress) &&
    first.tokenId === second.tokenId &&
    first.bridgeNetwork === second.bridgeNetwork &&
    first.bridgeRoute === second.bridgeRoute
  );
}

export function setSendDraft(next: SendDraft): void {
  draft = next;
}

export function retainSendDraftForReview(reviewEntry: string, reviewed: SendDraft): void {
  if (draft === null || sameSendDraft(draft, reviewed)) {
    draft = { ...(draft ?? reviewed), reviewEntry };
  }
}

export function releaseSendDraftReview(reviewEntry: string): void {
  if (draft?.reviewEntry === reviewEntry) draft = { ...draft, reviewEntry: undefined };
}

/** Read the draft and clear it — one-shot, consumed by NavigatorWrapper on mount. */
export function consumeSendDraft(): SendDraft | null {
  const current = draft;
  draft = null;
  return current;
}

export function clearSendDraft(reviewEntry?: string): void {
  if (reviewEntry === undefined || draft?.reviewEntry === reviewEntry) draft = null;
}
