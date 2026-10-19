import { getAddress, isAddress, isAddressEqual, type Address } from 'viem';

/** Every `path: address` pair in `value`, for the log. The paths say where Transak puts each address. */
export function addressFields(value: unknown, path = '', found: Record<string, Address> = {}): Record<string, Address> {
  switch (true) {
    case typeof value === 'string':
      if (isAddress(value, { strict: false })) found[path] = getAddress(value);
      break;
    case Array.isArray(value):
      value.forEach((item, index) => addressFields(item, `${path}[${index}]`, found));
      break;
    case typeof value === 'object' && value !== null:
      for (const [key, item] of Object.entries(value)) {
        addressFields(item, path === '' ? key : `${path}.${key}`, found);
      }
      break;
    default:
      break;
  }
  return found;
}

/**
 * The address that Transak tells the user to pay to. A staging sell order (2026-10-09) carries it as
 * `cryptoPaymentData.paymentAddress`, and nowhere else: the order has no `walletAddress`. The docs do not name the
 * field, so the other candidates stay as fallbacks: the `sell_order_fields` log line shows which path held it.
 */
export function findDepositAddress(raw: unknown, sourceAddress: Address): { path: string; address: Address } | null {
  const fields = addressFields(raw);
  const preferred = [
    'cryptoPaymentData.paymentAddress',
    'cryptoPaymentData.walletAddress',
    'cryptoPaymentData.address',
    'depositAddress'
  ];
  for (const path of preferred) {
    const address = fields[path];
    if (address !== undefined && !isAddressEqual(address, sourceAddress)) return { path, address };
  }
  for (const [path, address] of Object.entries(fields)) {
    if (path === 'walletAddress' || path === 'tokenContractAddress') continue;
    if (!isAddressEqual(address, sourceAddress)) return { path, address };
  }
  return null;
}

/** The `autoExpiresAt` of the order object as unix seconds, when it is a date string. */
export function autoExpiresAtOf(raw: unknown): number | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const value = Reflect.get(raw, 'autoExpiresAt');
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}
