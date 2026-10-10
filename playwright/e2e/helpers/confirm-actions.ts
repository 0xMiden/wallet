/**
 * Approve and decline test ids per confirm-popup kind. The values are `ConfirmPageSelectors`
 * (src/app/ConfirmPage.selectors.ts), which a Playwright spec cannot import; the Jest test keeps the two in step.
 */
export type ConfirmKind =
  | 'connect'
  | 'transaction'
  | 'consume'
  | 'sign'
  | 'assets'
  | 'privateNotes'
  | 'consumableNotes'
  | 'importPrivateNote';

/**
 * The buttons `ConfirmPage.tsx` renders for each payload type. A connect popup shows `RetryButton` in place of
 * `ConnectButton` only after a failed connect, so approving names the first-attempt button.
 */
export const CONFIRM_ACTIONS: Readonly<Record<ConfirmKind, { approve: string; decline: string }>> = {
  connect: { approve: 'ConfirmPage/ConnectAction/ConnectButton', decline: 'ConfirmPage/ConnectAction/CancelButton' },
  transaction: {
    approve: 'ConfirmPage/TransactionAction/AcceptButton',
    decline: 'ConfirmPage/TransactionAction/RejectButton'
  },
  consume: { approve: 'ConfirmPage/ConsumeAction/AcceptButton', decline: 'ConfirmPage/ConsumeAction/RejectButton' },
  sign: { approve: 'ConfirmPage/SignData/AcceptButton', decline: 'ConfirmPage/SignData/RejectButton' },
  assets: { approve: 'ConfirmPage/RequestAssets/AcceptButton', decline: 'ConfirmPage/RequestAssets/RejectButton' },
  privateNotes: {
    approve: 'ConfirmPage/RequestPrivateNotes/AcceptButton',
    decline: 'ConfirmPage/RequestPrivateNotes/RejectButton'
  },
  consumableNotes: {
    approve: 'ConfirmPage/RequestConsumableNotes/AcceptButton',
    decline: 'ConfirmPage/RequestConsumableNotes/RejectButton'
  },
  importPrivateNote: {
    approve: 'ConfirmPage/RequestImportPrivateNote/AcceptButton',
    decline: 'ConfirmPage/RequestImportPrivateNote/RejectButton'
  }
};
