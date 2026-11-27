import { redactPrompt, verifyProvenance } from './redactor';

const contacts = [
  { id: 'c-alice', name: 'Alice', address: 'mtst1ap2t7nsjausqsgr57c58s2nqqg9f8m62' },
  { id: 'c-alice-work', name: 'Alice Work', address: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e' }
];

describe('command-ai privacy redactor', () => {
  it('redacts exact amounts and partial hex addresses like 0x02323', () => {
    const res = redactPrompt('send 1 eth to 0x02323', { contacts });
    expect(res.redactedText).toBe('send <AMT_1> eth to <ADDR_1>');
    expect(res.redactedText).not.toContain('0x02323');
    expect(res.redactedText).not.toContain(' 1 ');
    expect(res.map.amounts.AMT_1).toBe('1');
    expect(res.map.addrs.ADDR_1).toBe('0x02323');
    expect(res.redactedTokensSummary).toEqual(['AMT', 'ADDR']);
  });

  it('redacts an exact-length hex token without a prefix', () => {
    const token = 'ab'.repeat(32);
    const note = redactPrompt('What is note ' + token + '?', { contacts });
    expect(note.redactedText).toBe('What is note <ADDR_1>?');
    expect(note.map.addrs.ADDR_1).toBe(token);
    expect(redactPrompt('What is note abcdef12?', { contacts }).redactedText).toBe('What is note abcdef12?');
    expect(redactPrompt('send 1 to 0x' + token, { contacts }).redactedText).toBe('send <AMT_1> to <ADDR_1>');
  });

  it('redacts high-precision amounts and full addresses to block mempool linkage', () => {
    const res = redactPrompt('send 1.374291 ETH to 0x742d35Cc6634C0532925a3b844Bc454e4438f44e', { contacts });
    expect(res.redactedText).toBe('send <AMT_1> ETH to <ADDR_1>');
    expect(res.redactedText).not.toContain('1.374291');
    expect(res.redactedText).not.toContain('0x742d35');
  });

  it('redacts contacts using longest-match without touching symbolic fractions', () => {
    const res = redactPrompt('send half my ETH to Alice Work', { contacts });
    expect(res.redactedText).toBe('send half my ETH to <CONTACT_1>');
    expect(res.map.contacts.CONTACT_1?.address).toBe('0x742d35Cc6634C0532925a3b844Bc454e4438f44e');

    const pct = redactPrompt('send 50% of my ETH to Alice', { contacts });
    expect(pct.redactedText).toBe('send 50% of my ETH to <CONTACT_1>');
  });

  it('preserves ledger query structure while stripping contact names and niche tokens', () => {
    const res = redactPrompt('how much ZORK did I send Alice last 7 days?', {
      contacts,
      heldNicheTickers: [{ symbol: 'ZORK', tokenId: 'faucet-zork' }]
    });
    expect(res.redactedText).toBe('how much <TOKEN_1> did I send <CONTACT_1> last 7 days?');
    expect(res.map.tokens.TOKEN_1?.tokenId).toBe('faucet-zork');
  });

  it('redacts fiat amounts and ENS names cleanly without double-matching placeholder digits', () => {
    const res = redactPrompt('swap $125.50 of usdc to vitalik.eth', { contacts });
    expect(res.redactedText).toBe('swap <FIAT_AMT_1> of usdc to <ADDR_1>');
    expect(res.map.fiatAmounts.FIAT_AMT_1).toBe('125.50');
    expect(res.map.addrs.ADDR_1).toBe('vitalik.eth');
  });

  it('rejects ungrounded placeholder refs in verifyProvenance', () => {
    const { map } = redactPrompt('send 1 eth to Alice', { contacts });
    expect(
      verifyProvenance(
        {
          op: 'set_intent',
          action: 'send',
          amount: { kind: 'exact_ref', ref: 'AMT_1' },
          asset: 'ETH',
          to_asset: null,
          from_chain: null,
          to_chain: null,
          recipient_ref: 'ADDR_99',
          provider: null,
          note_type: null,
          earn_op: null
        },
        map
      )
    ).toBe(false);
  });

  it('redacts leading-dot decimals like .5 and uppercase 0X hex prefixes', () => {
    const res = redactPrompt('send .5 eth to 0X02323', { contacts });
    expect(res.redactedText).toBe('send <AMT_1> eth to <ADDR_1>');
    expect(res.map.amounts.AMT_1).toBe('0.5');
    expect(res.map.addrs.ADDR_1).toBe('0X02323');
    expect(res.redactedText).not.toContain('.5');
    expect(res.redactedText).not.toContain('0X02323');
  });

  it('redacts numeric amounts glued to known tickers like 1eth or 10ZORK', () => {
    const res = redactPrompt('send 1eth to 0x00032', { contacts });
    expect(res.redactedText).toBe('send <AMT_1>eth to <ADDR_1>');
    expect(res.map.amounts.AMT_1).toBe('1');
    expect(res.map.addrs.ADDR_1).toBe('0x00032');

    const niche = redactPrompt('send 10ZORK to Alice', {
      contacts,
      heldNicheTickers: [{ symbol: 'ZORK', tokenId: 'faucet-zork' }]
    });
    expect(niche.redactedText).toBe('send <AMT_1><TOKEN_1> to <CONTACT_1>');
    expect(niche.map.amounts.AMT_1).toBe('10');
    expect(niche.map.tokens.TOKEN_1?.tokenId).toBe('faucet-zork');
  });

  it.each([
    ['a NEAR account name', 'friend.near', 'friend.near'],
    ['an upper-case Miden address', 'mtst1ap2t7nsjausqsgr57c58s2nqqg9f8m62', 'MTST1AP2T7NSJAUSQSGR57C58S2NQQG9F8M62'],
    ['an upper-case address no pattern covers', 'tb1qexampleaddress0000000000', 'TB1QEXAMPLEADDRESS0000000000']
  ])('redacts a saved address typed as %s', (_label, saved, typed) => {
    const res = redactPrompt(`send 1 usdc to ${typed}.`, {
      contacts: [{ id: 'c-saved', name: 'Zed', address: saved }]
    });
    expect(res.redactedText).toBe('send <AMT_1> usdc to <ADDR_1>.');
    expect(res.map.addrs.ADDR_1).toBe(typed);
  });

  it('redacts an upper-case Miden address that is not saved', () => {
    const res = redactPrompt('send to MTST1AP2T7NSJAUSQSGR57C58S2NQQG9F8M62', { contacts: [] });
    expect(res.redactedText).toBe('send to <ADDR_1>');
  });

  it('redacts a held symbol that ends in punctuation', () => {
    const res = redactPrompt('send 5 WIF$ now', {
      contacts,
      heldNicheTickers: [{ symbol: 'WIF$', tokenId: 'faucet-wif' }]
    });
    expect(res.redactedText).toBe('send <AMT_1> <TOKEN_1> now');
  });
});
