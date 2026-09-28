import fs from 'fs';
import path from 'path';

/**
 * A rejected hardware read answers nothing, so a page that refers to it directly has to guess a
 * credential or give up, and six pages once split four ways between those (#1056). Outside the
 * vault's own module, the hardware protector is read only through `probeHardwareProtector`.
 */
const SRC = path.join(__dirname, '../../..');
const DIRECT_READERS = ['lib/miden/back/actions.ts', 'lib/miden/back/protector-probe.ts', 'lib/miden/back/vault.ts'];

// A property access (`.hasHardwareProtector`, including one passed as a bare callback), a call
// (`hasHardwareProtector(`, whether on `Vault` or destructured from it) or a bracket access
// (`Vault['hasHardwareProtector']`). Case-sensitive, so the hook's own `hasHardwareProtector`
// field (never called) and `setHasHardwareProtector` (capital H) both stay clear of the guard.
const DIRECT_READ_PATTERN = /\.hasHardwareProtector\b|\bhasHardwareProtector\s*\(|['"]hasHardwareProtector['"]\]/;

it('reads the hardware protector only through probeHardwareProtector', () => {
  const readers = fs
    .readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter(file => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .filter(file => DIRECT_READ_PATTERN.test(fs.readFileSync(path.join(SRC, file), 'utf8')));

  expect(readers.sort()).toEqual(DIRECT_READERS);
});
