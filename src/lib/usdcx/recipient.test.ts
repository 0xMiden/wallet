import { midenAccountHexToXReserveRecipient } from './recipient';

// Vectors from the USDCx bridging guide (2026-09-22), computed with the faucet's
// `EthEmbeddedAccountId::to_bytes32`. The third one is the example shared with
// Circle in the SDK examples.
describe('midenAccountHexToXReserveRecipient', () => {
  it.each([
    ['0xb64e1827414584510723cad8e145a4', '0x00000000000000000000000000000000b64e1827414584510723cad8e145a400'],
    ['0x179f749ee2329e317d96fe3ed5aaf9', '0x00000000000000000000000000000000179f749ee2329e317d96fe3ed5aaf900'],
    ['0x8110548cc41852010140bd1325ff08', '0x000000000000000000000000000000008110548cc41852010140bd1325ff0800']
  ])('encodes %s', (hexId, expected) => {
    expect(midenAccountHexToXReserveRecipient(hexId)).toBe(expected);
  });

  it('lowercases an uppercase id', () => {
    expect(midenAccountHexToXReserveRecipient('0xB64E1827414584510723CAD8E145A4')).toBe(
      '0x00000000000000000000000000000000b64e1827414584510723cad8e145a400'
    );
  });

  it.each([
    ['a bech32 id', 'mtst1azmyuxp8g9zcg5g8y09d3c295s3n6fl4'],
    ['29 hex chars', '0xb64e1827414584510723cad8e145a'],
    ['31 hex chars', '0xb64e1827414584510723cad8e145a40'],
    ['non-hex', '0xb64e1827414584510723cad8e145zz'],
    ['no 0x prefix', 'b64e1827414584510723cad8e145a4'],
    ['empty', '']
  ])('rejects %s', (_label, input) => {
    expect(() => midenAccountHexToXReserveRecipient(input)).toThrow('Invalid Miden account id');
  });
});
