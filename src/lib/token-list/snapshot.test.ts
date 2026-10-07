import { parseTokenList, parseTokenLogos } from './parse';
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

it('bundles the testnet logos for MIDEN, IMIDEN, IETH and IBTC', () => {
  const logo = (id: string) => `https://raw.githubusercontent.com/0xMiden/token-list/main/logos/${id}/logo.svg`;
  expect(parseTokenLogos(bundledTokenList('testnet'), 'testnet')).toEqual(
    new Map(
      [
        'mtst1aqvpq8a9ytqhfvt9al20wzsrs56g83ec',
        'mtst1arqxg9er3xclayt95nud82jnpggl9azj',
        'mtst1arcf9xpxfrc7wygpv744ytgr6cw2df6h',
        'mtst1apqk2y2uky2mkyfcjv95fjm5zgnrwk6x'
      ].map(id => [id, logo(id)])
    )
  );
});
