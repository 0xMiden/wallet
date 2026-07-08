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
export interface SendDraft {
  amount: string;
  recipientAddress: string;
  tokenId: string;
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

export function hasSendDraft(): boolean {
  return draft !== null;
}

export function clearSendDraft(): void {
  draft = null;
}
