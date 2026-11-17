export function useCommandBridge() {
  return { amount: '', setAmount: (_value: string) => undefined, direction: 'in', setDirection: (_value: 'in' | 'out') => undefined, externalAccountId: '', setExternalAccountId: (_value: string) => undefined };
}
