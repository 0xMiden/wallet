import type {
  IEncryptedRecord,
  IPublicNFTData,
  IRecordMetadata,
  ISerialNumberMetadata
} from './rpc-types';

// rpc-types.ts is a type-only module (interface declarations). Import it for
// coverage bookkeeping and exercise the shapes structurally.
import * as rpcTypes from './rpc-types';

describe('rpc-types module', () => {
  it('module import resolves (type-only barrel has no runtime exports)', () => {
    expect(rpcTypes).toBeDefined();
    expect(Object.keys(rpcTypes)).toHaveLength(0);
  });

  it('IEncryptedRecord shape is assignable', () => {
    const rec: IEncryptedRecord = {
      id: 1n,
      record_ciphertext: 'ct',
      program_id: 'prog',
      block_id: 2n,
      height: '10',
      timestamp: 3n,
      block_hash: 'hash',
      transaction_id: 'tx',
      transition_id: 'ts',
      output_index: '0',
      function_name: 'fn'
    };
    expect(rec.id).toBe(1n);
  });

  it('IRecordMetadata shape is assignable', () => {
    const meta: IRecordMetadata = {
      id: 1,
      transition_id: 'ts',
      nonce_x: 'nx',
      nonce_y: 'ny',
      owner_x: 'ox',
      output_index: 0
    };
    expect(meta.id).toBe(1);
  });

  it('ISerialNumberMetadata shape is assignable', () => {
    const sn: ISerialNumberMetadata = {
      serial_number: 'sn',
      program_id: 'prog',
      block_id: 5n,
      height: 7,
      transaction_id: 'tx',
      transition_id: 'ts',
      timestamp: 9n
    };
    expect(sn.height).toBe(7);
  });

  it('IPublicNFTData shape is assignable', () => {
    const nft: IPublicNFTData = {
      transactionId: 'tx',
      timestamp: 11n,
      programId: 'prog',
      tokenId: 'tid',
      baseUri: 'uri',
      symbol: 'SYM',
      tokenIdString: 'tids',
      edition: '1'
    };
    expect(nft.symbol).toBe('SYM');
  });
});
