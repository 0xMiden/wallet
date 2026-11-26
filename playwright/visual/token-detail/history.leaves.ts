// `HistoryView`'s two leaves that reach the whole wallet front end. A plain received row, the only
// kind the history fixture draws, needs just these answers.
export const FIXTURE_NOW = Math.floor(new Date('2026-10-05T12:00:00Z').getTime() / 1000);

export default function HistoryItem() {
  return null;
}
export const isReceiveEntry = () => true;
export const isFaucetRequest = () => false;
export const isBridgeInEntry = () => false;
export const isEarnWithdrawEntry = () => false;
export const hasOwnBridgeBadge = () => false;
export const networkHasFaucetClaims = () => false;
export const earnDepositSettlementOf = () => 'confirmed' as const;
export const bridgeStatusOf = () => 'confirmed' as const;
export const bridgeBadgeStatusOf = () => 'confirmed' as const;
export const formatMoneyAmount = (amount: unknown) => String(amount);
export const bridgeRowDisplay = (): never => {
  throw new Error('The history fixture draws no bridge row');
};
export const bridgeInRowDisplay = bridgeRowDisplay;
export const TRANSACTION_COLORS = {};
