import { assertWalletAccessAllowed, ensureWalletAccessAllowed } from 'lib/remote-config/wallet-access';
import { WalletMessageType, type WalletRequest } from 'lib/shared/types';

const MAINTENANCE = new Set<WalletRequest['type']>([
  WalletMessageType.LockRequest,
  WalletMessageType.ReleaseRecoveryRequest,
  WalletMessageType.NoteDeliveryWrittenRequest,
  WalletMessageType.ReportTelemetryEventRequest
]);

export async function withWalletRequestAccess<T>(request: WalletRequest, action: () => Promise<T>): Promise<T> {
  if (MAINTENANCE.has(request?.type)) return action();
  await ensureWalletAccessAllowed();
  const result = await action();
  assertWalletAccessAllowed();
  return result;
}
