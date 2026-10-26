import { restoreSdkRecovery, decodeSdkRecoveryCommand, type RecoverySdkWriter } from './sdk-restore';
import type { RecoveryNoteEntry } from './types';

jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  NoteFile: { deserialize: () => ({ noteDetails: () => ({ commitment: 'details-a' }), noteId: () => ({ toString: () => 'note-a' }), free: () => {} }) }
}));
jest.mock('../sdk/note-details-commitment', () => ({ noteDetailsCommitment: (value: object) => Reflect.get(value, 'commitment') }));

const note: RecoveryNoteEntry = { kind: 'note', id: 'note-a', provenance: 'input', noteFile: new Uint8Array([1]), format: 'full' };
let marker: string | null;
let records: unknown[];
let afterImport: () => void;
const client: RecoverySdkWriter = {
  settings: {
    get: jest.fn().mockImplementation(async () => marker),
    set: jest.fn().mockImplementation(async (_key: string, value: string) => { marker = value; })
  },
  accounts: { get: jest.fn().mockResolvedValue({ nonce: () => ({ asInt: () => 1n }), to_commitment: () => ({ toHex: () => 'state', free: () => {} }) }), insert: jest.fn() },
  notes: {
    list: jest.fn().mockImplementation(async () => records),
    import: jest.fn().mockImplementation(async () => {
      records = [{ details: () => ({ commitment: 'details-a' }), isConsumed: () => false }];
      afterImport();
    })
  },
  storeIdentifier: jest.fn().mockResolvedValue('disposable')
};

beforeEach(() => {
  jest.clearAllMocks();
  marker = null;
  records = [];
  afterImport = () => {};
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: (_name: string, operation: () => Promise<unknown>) => operation() } });
});

it('imports a retained input file and verifies its body before acknowledging the recovery step', async () => {
  await expect(restoreSdkRecovery(client, { kind: 'note', note, accountId: 'retained' }, () => {})).resolves.toBeUndefined();
  expect(records).toHaveLength(1);
  expect(client.notes.import).toHaveBeenCalledTimes(1);
});

it('preserves a matching already consumed record without importing it again', async () => {
  records = [{ details: () => ({ commitment: 'details-a' }), isConsumed: () => true }];
  await expect(restoreSdkRecovery(client, { kind: 'note', note, accountId: 'retained' }, () => {})).resolves.toBeUndefined();
  expect(client.notes.import).not.toHaveBeenCalled();
});

it('refuses a same-id note whose retained body differs', async () => {
  records = [{ details: () => ({ commitment: 'different' }) }];
  await expect(restoreSdkRecovery(client, { kind: 'note', note, accountId: 'retained' }, () => {})).rejects.toThrow();
  expect(client.notes.import).not.toHaveBeenCalled();
});

it('does not acknowledge a note after the active holder is abandoned during import', async () => {
  let current = true;
  afterImport = () => { current = false; };
  await expect(restoreSdkRecovery(client, { kind: 'note', note, accountId: 'retained' }, () => {
    if (!current) throw new Error('abandoned');
  })).rejects.toThrow('abandoned');
});

it('adopts only the retained logical SDK generation and verifies it', async () => {
  await expect(restoreSdkRecovery(client, { kind: 'generation', generation: 'retained-generation' }, () => {})).resolves.toBeUndefined();
  expect(marker).toBe('retained-generation');
});

it('preserves a different surviving SDK generation', async () => {
  marker = 'other-wallet';
  await expect(restoreSdkRecovery(client, { kind: 'generation', generation: 'retained-generation' }, () => {})).rejects.toThrow();
  expect(marker).toBe('other-wallet');
  expect(client.settings.set).not.toHaveBeenCalled();
});

it('rejects an unbounded recovery command before SDK materialization', () => {
  expect(() => decodeSdkRecoveryCommand({ kind: 'generation', generation: 'x'.repeat(129) })).toThrow();
  expect(() => decodeSdkRecoveryCommand({ kind: 'account', material: { accountBytes: [] } })).toThrow();
});
