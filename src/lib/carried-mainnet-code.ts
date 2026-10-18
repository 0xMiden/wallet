import { getStorageProvider } from 'lib/platform/storage-adapter';

/**
 * The access code a wallet switching to mainnet had accepted, kept across the switch's reset and
 * reload for the mainnet code step. Not a preserved key: the wipe a wallet setup starts with removes
 * it, so the registration that uses the code ends it, and any other wipe does too.
 */
export const CARRIED_MAINNET_CODE_STORAGE_KEY = 'carried_mainnet_access_code';

// Wrapped in an object: the mobile and desktop stores parse a stored string as JSON, which would
// turn an all-digit code into a number.
interface CarriedCode {
  code: string;
}

const isCarriedCode = (value: unknown): value is CarriedCode =>
  typeof value === 'object' && value !== null && 'code' in value && typeof value.code === 'string';

export async function carryMainnetAccessCode(code: string): Promise<void> {
  const carried: CarriedCode = { code };
  await getStorageProvider().set({ [CARRIED_MAINNET_CODE_STORAGE_KEY]: carried });
}

/** The carried code, or undefined, also when storage cannot be read: the code step then asks for it. */
export async function readCarriedMainnetAccessCode(): Promise<string | undefined> {
  try {
    const items = await getStorageProvider().get([CARRIED_MAINNET_CODE_STORAGE_KEY]);
    const stored: unknown = items[CARRIED_MAINNET_CODE_STORAGE_KEY];
    return isCarriedCode(stored) ? stored.code : undefined;
  } catch {
    return undefined;
  }
}

/** Never rejects: a code left behind is offered once more, and the node still checks it. */
export async function forgetCarriedMainnetAccessCode(): Promise<void> {
  try {
    await getStorageProvider().remove([CARRIED_MAINNET_CODE_STORAGE_KEY]);
  } catch (error) {
    console.warn('[carried-mainnet-code] Could not forget the carried access code', error);
  }
}
