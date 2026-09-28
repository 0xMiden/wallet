import { parseTokenList } from './parse';
import { bundledTokenList } from './snapshot';

it('bundles the testnet list with exactly the seeded tokens', () => {
  expect(parseTokenList(bundledTokenList('testnet'), 'testnet')).toEqual(
    new Set([
      'mtst1aqvpq8a9ytqhfvt9al20wzsrs56g83ec',
      'mtst1arqxg9er3xclayt95nud82jnpggl9azj',
      'mtst1arcf9xpxfrc7wygpv744ytgr6cw2df6h',
      'mtst1apqk2y2uky2mkyfcjv95fjm5zgnrwk6x',
      'mtst1arvdwvzllvg3s5fzjle7nkljeuhkcufr'
    ])
  );
});

it.each(['devnet', 'mainnet', 'localnet'])('bundles nothing for %s', network => {
  expect(bundledTokenList(network)).toBeNull();
});
