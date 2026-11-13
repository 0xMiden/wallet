import { decodePlatformBytes, parsePlatformCredentialMetadata } from './crypto';
import type { PlatformUnlockCommand } from './types';

function bytes(value: unknown, length: number | null): value is string {
  if (typeof value !== 'string') return false;
  try {
    const decoded = decodePlatformBytes(value);
    return length === null ? decoded.length <= 1023 : decoded.length === length;
  } catch {
    return false;
  }
}

export function parsePlatformUnlockCommand(value: unknown): PlatformUnlockCommand | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const action: unknown = Reflect.get(value, 'action');
  const enrollmentId: unknown = Reflect.get(value, 'enrollmentId');
  switch (action) {
    case 'state': case 'pending-signals': return { action };
    case 'begin': case 'remove': {
      const expectedCredentialId: unknown = Reflect.get(value, 'expectedCredentialId');
      return expectedCredentialId === null || bytes(expectedCredentialId, null)
        ? { action, expectedCredentialId } : null;
    }
    case 'track': {
      const credential = parsePlatformCredentialMetadata(Reflect.get(value, 'credential'));
      return bytes(enrollmentId, 32) && credential ? { action, enrollmentId, credential } : null;
    }
    case 'commit': {
      const password: unknown = Reflect.get(value, 'password');
      const prfSecret: unknown = Reflect.get(value, 'prfSecret');
      return bytes(enrollmentId, 32) && typeof password === 'string' && password.length > 0 && bytes(prfSecret, 32)
        ? { action, enrollmentId, password, prfSecret } : null;
    }
    case 'abandon': return bytes(enrollmentId, 32) ? { action, enrollmentId } : null;
    case 'unlock': {
      const credentialId: unknown = Reflect.get(value, 'credentialId');
      const prfSecret: unknown = Reflect.get(value, 'prfSecret');
      return bytes(credentialId, null) && bytes(prfSecret, 32) ? { action, credentialId, prfSecret } : null;
    }
    case 'signal-complete': {
      const credentialId: unknown = Reflect.get(value, 'credentialId');
      return bytes(credentialId, null) ? { action, credentialId } : null;
    }
    default: return null;
  }
}
