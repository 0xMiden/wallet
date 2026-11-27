import fs from 'fs';
import path from 'path';

// No jest test can run Swift, and the simulator has no Secure Enclave, so this checks the source for
// the key access control and the authentication step.
const source = fs.readFileSync(path.resolve(__dirname, '../../../ios/App/App/LocalBiometricPlugin.swift'), 'utf8');
const body = (name: string) => source.slice(source.indexOf(`func ${name}(`)).split('\n    }\n')[0]!;

describe('LocalBiometricPlugin.swift access control', () => {
  it('creates vault keys that need user presence and survive biometric re-enrolment', () => {
    expect(source.match(/SecAccessControlCreateWithFlags\(/g)).toHaveLength(1);
    expect(body('createPresenceKey')).toContain('[.privateKeyUsage, .userPresence]');
    expect(source).not.toMatch(/^[^/\n]*\.biometryCurrentSet/m);
  });

  it('authenticates the owner before decrypting any wrapper', () => {
    const decrypt = body('decryptWithHardwareKey');
    const prompt = decrypt.indexOf('context.evaluatePolicy(.deviceOwnerAuthentication');
    expect(prompt).toBeGreaterThan(-1);
    expect(decrypt).toContain('let noPasscode = isLegacy && ');
    expect(decrypt).toMatch(/if !success && !noPasscode \{\s+self\.rejectAuthentication\(call, error\)\s+return\s+\}/);
    expect(decrypt.indexOf('self.unwrap(')).toBeGreaterThan(prompt);
  });

  it('never deletes the legacy key while migrating, so an unsaved replacement cannot strand the wallet', () => {
    expect(source).not.toContain('deleteKey(tag: kLegacyKeyTag)');
  });
});
