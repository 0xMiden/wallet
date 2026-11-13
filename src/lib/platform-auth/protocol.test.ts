import type { PlatformUnlockCommand } from './types';
import { parsePlatformUnlockCommand } from './protocol';

const token = 'A'.repeat(43);
const secret = 'E'.repeat(42) + 'A';
const credential = { credentialId: 'AQIDBA', prfSalt: secret, backupEligible: true };
const commands: PlatformUnlockCommand[] = [
  { action: 'state' }, { action: 'begin', expectedCredentialId: null },
  { action: 'begin', expectedCredentialId: credential.credentialId },
  { action: 'track', enrollmentId: token, credential },
  { action: 'commit', enrollmentId: token, password: 'correct', prfSecret: secret },
  { action: 'abandon', enrollmentId: token }, { action: 'remove', expectedCredentialId: credential.credentialId },
  { action: 'unlock', credentialId: credential.credentialId, prfSecret: secret },
  { action: 'pending-signals' }, { action: 'signal-complete', credentialId: credential.credentialId }
];
it.each(commands)('accepts the bounded $action command', command => {
  expect(parsePlatformUnlockCommand(command)).toEqual(command);
});
it.each([
  null, [], {}, { action: 'other' }, { action: 'begin', expectedCredentialId: '' },
  { action: 'commit', enrollmentId: token, password: 123, prfSecret: secret },
  { action: 'commit', enrollmentId: '', password: 'correct', prfSecret: secret },
  { action: 'unlock', credentialId: 'AB', prfSecret: secret },
  { action: 'unlock', credentialId: credential.credentialId, prfSecret: 'short' },
  { action: 'track', enrollmentId: token, credential: { ...credential, backupEligible: 'true' } },
  { action: 'signal-complete', credentialId: null }
])('refuses malformed wire input %#', command => {
  expect(parsePlatformUnlockCommand(command)).toBeNull();
});
it('does not forward unknown secret-bearing fields', () => {
  expect(parsePlatformUnlockCommand({ action: 'state', password: 'private' })).toEqual({ action: 'state' });
});
