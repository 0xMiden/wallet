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
import { BridgeNetworkId } from './bridge-networks';
import { BridgeRoute } from './types';

export interface SendDraft {
  amount: string;
  recipientAddress: string;
  tokenId: string;
  /** Destination network, only set when the recipient is a 0x (Ethereum) address. */
  bridgeNetwork?: BridgeNetworkId;
  /** Cross-chain route, only set when the recipient is a 0x (Ethereum) address. */
  bridgeRoute?: BridgeRoute;
  /**
   * The Miden Name that the recipient input resolved to. Only set when the
   * input is a name (for example `alice.miden`). `recipientAddress` keeps the
   * name as the user typed it, and `address` is the resolved bech32 address.
   */
  midenName?: SendDraftMidenName;
}

export interface SendDraftMidenName {
  /** The label without ".miden". */
  label: string;
  /** The bech32 address that the label resolved to. */
  address: string;
}

let draft: SendDraft | null = null;

export function setSendDraft(next: SendDraft): void {
  draft = next;
}

/** Read the draft and clear it — one-shot, consumed by NavigatorWrapper on mount. */
export function consumeSendDraft(): SendDraft | null {
  const current = draft;
  draft = null;
  return current;
}

export function clearSendDraft(): void {
  draft = null;
}
