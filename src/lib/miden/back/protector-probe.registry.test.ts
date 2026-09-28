import fs from 'fs';
import path from 'path';

/**
 * A rejected hardware read answers nothing, so a page that calls it directly has to guess a
 * credential or give up, and six pages once split four ways between those (#1056). Outside the
 * vault's own module, the hardware protector is read only through `probeHardwareProtector`.
 */
const SRC = path.join(__dirname, '../../..');
const DIRECT_READERS = ['lib/miden/back/actions.ts', 'lib/miden/back/protector-probe.ts', 'lib/miden/back/vault.ts'];

it('reads the hardware protector only through probeHardwareProtector', () => {
  const readers = fs
    .readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter(file => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .filter(file => fs.readFileSync(path.join(SRC, file), 'utf8').includes('hasHardwareProtector('));

  expect(readers.sort()).toEqual(DIRECT_READERS);
});
