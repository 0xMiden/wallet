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

describe('one-use reveal approval', () => {
  const hotKey = fs.readFileSync(path.resolve(__dirname, '../../../ios/App/App/HotKeyPlugin.swift'), 'utf8');
  const code = (swift: string) => swift.replace(/^\s*\/\/.*$/gm, '');
  const both = code(source + hotKey);
  const store = code(
    source.slice(source.indexOf('final class RevealApprovalStore'), source.indexOf('@objc(LocalBiometricPlugin)'))
  );

  it('never lets one authentication be reused by time or by a kept context', () => {
    expect(both).not.toContain('touchIDAuthenticationAllowableReuseDuration');
    expect(both).not.toMatch(/(static|private) (var|let) \w+(: LAContext\??| = LAContext\()/);
  });

  it('invalidates the context of every prompt once its work is over', () => {
    const prompts = both.match(/\.evaluatePolicy\(/g)!;
    expect(both.match(/defer \{ RevealApprovalStore\.shared\.end\(\w+\) \}/g)).toHaveLength(prompts.length);
    expect(both.match(/RevealApprovalStore\.shared\.begin\(\w+\)/g)).toHaveLength(prompts.length);
    expect(store).toContain('context.invalidate()');
  });

  it('issues an approval only after a successful prompt that showed the fixed reveal text', () => {
    const decrypt = code(body('decryptWithHardwareKey'));
    expect(both.match(/\.issue\(ticket:/g)).toHaveLength(1);
    expect(decrypt).toContain('if success, let publicKey = revealPublicKey {');
    expect(decrypt).toMatch(
      /revealPublicKey == nil\s+\? promptReason\(call\.getString\("reason"\), fallback: kFallbackReason\)\s+: kRevealHotKeyReason/
    );
  });

  it('spends an approval once, under a lock, within 15 seconds, and drops it on lock and background', () => {
    expect(store).toContain('static let lifetimeNanoseconds: UInt64 = 15_000_000_000');
    expect(store).toContain('UIApplication.didEnterBackgroundNotification');
    expect(store).toMatch(
      /func consume\(_ id: String\) -> String\? \{\s+lock\.lock\(\)\s+defer \{ lock\.unlock\(\) \}\s+guard let current = approval, current\.id == id else \{ return nil \}\s+approval = nil/
    );
  });

  it('refuses a stale approval instead of prompting, and checks the revealed key against the approved one', () => {
    const reveal = code(
      hotKey.slice(hotKey.indexOf('@objc func revealHotKey'), hotKey.indexOf('@objc func deleteHotKey'))
    );
    expect(reveal).toMatch(
      /guard let publicKey = RevealApprovalStore\.shared\.consume\(approval\) else \{\s+call\.reject\([^\n]+"APPROVAL_EXPIRED"\)\s+return/
    );
    expect(reveal).toContain('guard publicKey == normalizedPublicKeyHex(approved) else {');
    expect(reveal.indexOf('"APPROVAL_MISMATCH"')).toBeLessThan(reveal.indexOf('"secretKeyHex"'));
  });

  it('leaves hot key signing silent', () => {
    const sign = code(
      hotKey.slice(hotKey.indexOf('@objc func signWithHotKey'), hotKey.indexOf('@objc func revealHotKey'))
    );
    expect(sign).not.toMatch(/LAContext|evaluatePolicy|RevealApprovalStore/);
    expect(code(hotKey)).not.toMatch(/\.userPresence|\.biometryCurrentSet/);
  });
});
