import * as Passworder from '../passworder';
import {
  decryptRecoveryDataFile,
  encryptRecoveryDataFile,
  RECOVERY_DATA_FILE_MAX_BYTES,
  type EncryptedRecoveryDataFile
} from './external-file';
import { toSerializable } from './serialization';
import type { RecoveryJournalSnapshot } from './types';

jest.mock('../passworder', () => {
  const actual = jest.requireActual<typeof import('../passworder')>('../passworder');
  return { ...actual, deriveKey: jest.fn(actual.deriveKey) };
});

jest.setTimeout(60_000);

const snapshot: RecoveryJournalSnapshot = {
  version: 1,
  sequence: 7,
  scope: { network: 'testnet:https://node.invalid', walletGeneration: 'wallet-a', sdkGeneration: 'sdk-a' },
  accounts: [{ accountId: 'account-a', nonce: '4', commitment: 'commitment-a' }],
  entries: [
    {
      kind: 'note',
      id: 'private-input',
      accountId: 'account-a',
      noteFile: new Uint8Array([1, 2, 255]),
      provenance: 'input'
    },
    { kind: 'debit', id: 'spend-a', accountId: 'account-a', initiatedAt: 1000, spentUsd: 1_000_000n }
  ]
};

const filePassword = 'disposable-recovery-file-password';
let independentFile: Promise<EncryptedRecoveryDataFile> | undefined;
const encryptedFixture = () => {
  independentFile ??= (async (): Promise<EncryptedRecoveryDataFile> => {
    const salt = Passworder.generateSalt();
    const key = await Passworder.deriveKey(await Passworder.generateKey(filePassword), salt);
    return {
      format: 'miden-recovery-data',
      formatVersion: 1,
      salt: Array.from(salt),
      payload: await Passworder.encryptJson(
        { format: 'miden-recovery-data', formatVersion: 1, snapshot: toSerializable(snapshot) },
        key
      ),
      passwordCheck: await Passworder.encryptJson('miden-recovery-data-password-check-v1', key)
    };
  })();
  return independentFile;
};

describe('Task5 recovery file crypto', () => {
  it('round-trips bounded private bytes and financial evidence through the existing real cipher', async () => {
    await expect(
      encryptRecoveryDataFile(snapshot, filePassword).then(async content => ({
        restored: await decryptRecoveryDataFile(content, filePassword),
        leaksPlaintext: content.includes('private-input') || content.includes('commitment-a'),
        bounded: new TextEncoder().encode(content).byteLength <= RECOVERY_DATA_FILE_MAX_BYTES
      }))
    ).resolves.toEqual({
      restored: snapshot,
      leaksPlaintext: false,
      bounded: true
    });
  });

  it('opens an independently encrypted file with the existing KDF and AES-GCM format', async () => {
    const content = JSON.stringify(await encryptedFixture());
    await expect(decryptRecoveryDataFile(content, filePassword)).resolves.toEqual(snapshot);
  });

  it('distinguishes a wrong file password from malformed recovery data', async () => {
    const content = JSON.stringify(await encryptedFixture());
    await expect(decryptRecoveryDataFile(content, 'another-disposable-password')).rejects.toMatchObject({
      code: 'password'
    });
  });

  it('refuses changed ciphertext after a valid password check', async () => {
    const file = await encryptedFixture();
    const payload = { ...file.payload, dt: `${file.payload.dt[0] === 'A' ? 'B' : 'A'}${file.payload.dt.slice(1)}` };
    await expect(decryptRecoveryDataFile(JSON.stringify({ ...file, payload }), filePassword)).rejects.toMatchObject({
      code: 'malformed'
    });
  });

  it.each([
    ['malformed', '{}'],
    ['version', JSON.stringify({ format: 'miden-recovery-data', formatVersion: 2 })],
    ['size', 'x'.repeat(RECOVERY_DATA_FILE_MAX_BYTES + 1)]
  ])('refuses %s before deriving a password key', async (code, content) => {
    const derive = jest.mocked(Passworder.deriveKey);
    derive.mockClear();
    try {
      await expect(decryptRecoveryDataFile(content, filePassword)).rejects.toMatchObject({ code });
      expect(derive).not.toHaveBeenCalled();
    } finally {
      derive.mockClear();
    }
  });
});
