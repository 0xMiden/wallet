import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readInviteCodes, writeAccountSecrets } from './e2e-mainnet-accounts';

describe('mainnet invite codes', () => {
  it('reads the public code first and the Guardian code second', () => {
    expect(readInviteCodes('ABCD23456789\n12345678\n')).toEqual({
      plain: 'ABCD23456789',
      guardian: '12345678'
    });
  });

  it('rejects a file that does not hold exactly two well-shaped codes', () => {
    expect(() => readInviteCodes('ABCD23456789\n')).toThrow('expected 2 invite codes, found 1');
    expect(() => readInviteCodes('not-a-code\nABCD23456789\n')).toThrow('an invite code has the wrong shape');
  });
});

describe('mainnet account secret file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mainnet-accounts-'));
  const file = join(dir, 'nested', 'accounts.json');

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes mode 0600 and keeps a partial file when only the public account exists', () => {
    writeAccountSecrets(file, { plain: { address: 'mm1qq', seed: 'alpha beta gamma' } });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      plain: { address: 'mm1qq', seed: 'alpha beta gamma' }
    });
    chmodSync(file, 0o644);
    writeAccountSecrets(file, {
      plain: { address: 'mm1qq', seed: 'alpha beta gamma' },
      guardian: { address: 'mm1gg', seed: 'delta epsilon zeta', keyPair: 'hot:evm' }
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('refuses to store an invitation code next to the seed', () => {
    expect(() => writeAccountSecrets(file, { plain: { address: 'mm1qq', seed: 'invitation code stays out' } })).toThrow(
      'refusing to write invite material'
    );
  });
});
