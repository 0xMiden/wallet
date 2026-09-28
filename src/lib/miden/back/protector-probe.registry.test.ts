import fs from 'fs';
import path from 'path';

/**
 * A rejected hardware read answers nothing, so a page that refers to it directly has to guess a
 * credential or give up, and six pages once split four ways between those (#1056). The allow
 * list below admits the only three direct readers: the vault module itself (`vault.ts`), the
 * one indirection every other reader goes through (`probeHardwareProtector`, in
 * `protector-probe.ts`), and, kept by the #1056 scope decision, `actions.ts`'s
 * `getStrictAuthenticationProtectors`.
 */
const SRC = path.join(__dirname, '../../..');
const DIRECT_READERS = ['lib/miden/back/actions.ts', 'lib/miden/back/protector-probe.ts', 'lib/miden/back/vault.ts'];

// A member access on the `Vault` binding (`Vault.hasHardwareProtector`, whitespace or a newline
// tolerated around the dot, including one passed as a bare callback), a call
// (`hasHardwareProtector(`, whether on `Vault` or destructured from it) or a bracket access
// (`Vault['hasHardwareProtector']`). Case-sensitive, so the hook's own `hasHardwareProtector`
// field (never called) and `setHasHardwareProtector` (capital H) both stay clear of the guard,
// and the member arm is anchored on `Vault` so that same field, read off another binding (the
// hook's own `probe.hasHardwareProtector`), never trips it. A deliberate rename of either
// identifier is out of a text guard's reach.
const DIRECT_READ_PATTERN =
  /\bVault\s*\.\s*hasHardwareProtector\b|\bhasHardwareProtector\s*\(|['"]hasHardwareProtector['"]\]/;

it('reads the hardware protector only through probeHardwareProtector', () => {
  const readers = fs
    .readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter(file => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .filter(file => DIRECT_READ_PATTERN.test(fs.readFileSync(path.join(SRC, file), 'utf8')));

  expect(readers.sort()).toEqual(DIRECT_READERS);
});

it.each([
  ['a call on the Vault binding', 'Vault.hasHardwareProtector()', true],
  ['a bare callback on the Vault binding', '.then(Vault.hasHardwareProtector)', true],
  ['a member access split across a line', 'Vault\n  .hasHardwareProtector()', true],
  ['a destructured call', 'const { hasHardwareProtector } = Vault; hasHardwareProtector()', true],
  ['a bracket access on the Vault binding', "Vault['hasHardwareProtector']", true],
  ['the hook result field, read off another binding', 'probe.hasHardwareProtector', false],
  ['the hook call destructured', 'const { hasHardwareProtector, probeFailed } = useHardwareProtector();', false],
  ['the hook state setter', 'setHasHardwareProtector(true)', false],
  ['a bare ternary on the hook field', 'hasHardwareProtector ? a : b', false]
])('%s', (_label, snippet, shouldMatch) => {
  expect(DIRECT_READ_PATTERN.test(snippet)).toBe(shouldMatch);
});
