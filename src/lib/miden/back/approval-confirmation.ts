import { MidenMessageType } from 'lib/miden/types';

/** The requests an approval's popup sends to answer it; its payload and simulate requests are served separately. */
export const APPROVAL_CONFIRMATION_TYPES: ReadonlySet<unknown> = new Set([
  MidenMessageType.DAppUnlockConfirmationRequest,
  MidenMessageType.DAppPermConfirmationRequest,
  MidenMessageType.DAppTransactionConfirmationRequest,
  MidenMessageType.DAppPrivateNotesConfirmationRequest,
  MidenMessageType.DAppSignConfirmationRequest,
  MidenMessageType.DAppAssetsConfirmationRequest,
  MidenMessageType.DAppImportPrivateNoteConfirmationRequest,
  MidenMessageType.DAppConsumableNotesConfirmationRequest
]);
