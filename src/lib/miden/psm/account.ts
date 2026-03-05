import {
  AccountBuilder,
  AccountComponent,
  AccountStorageMode,
  AccountType,
  AuthSecretKey,
  StorageMap,
  StorageSlot,
  WebClient,
  Word
} from '@miden-sdk/miden-sdk';
import { PsmHttpClient } from '@openzeppelin/psm-client';

import { DEFAULT_PSM_ENDPOINT } from 'lib/miden-chain/constants';
import { PSM_URL_STORAGE_KEY } from 'lib/settings/constants';

import { fetchFromStorage } from '../front';
import { MULTISIG_MASM, PSM_MASM } from './codes';

const PSM_SLOT_NAMES = {
  SELECTOR: 'openzeppelin::psm::selector',
  PUBLIC_KEY: 'openzeppelin::psm::public_key'
} as const;

export const MULTISIG_SLOT_NAMES = {
  THRESHOLD_CONFIG: 'openzeppelin::multisig::threshold_config',
  SIGNER_PUBLIC_KEYS: 'openzeppelin::multisig::signer_public_keys',
  EXECUTED_TRANSACTIONS: 'openzeppelin::multisig::executed_transactions',
  PROCEDURE_THRESHOLDS: 'openzeppelin::multisig::procedure_thresholds'
} as const;

export function buildPsmSlots(psmCommitment: string): StorageSlot[] {
  console.log('Building PSM storage slots with commitment:', psmCommitment);
  const selectorWord = new Word(new BigUint64Array([1n, 0n, 0n, 0n]));
  const slot0 = StorageSlot.fromValue(PSM_SLOT_NAMES.SELECTOR, selectorWord);

  const psmKeyMap = new StorageMap();
  const zeroKey = new Word(new BigUint64Array([0n, 0n, 0n, 0n]));
  psmCommitment = psmCommitment.startsWith('0x') ? psmCommitment : `0x${psmCommitment}`;
  const psmKey = Word.fromHex(psmCommitment);
  psmKeyMap.insert(zeroKey, psmKey);
  const slot1 = StorageSlot.map(PSM_SLOT_NAMES.PUBLIC_KEY, psmKeyMap);

  return [slot0, slot1];
}

function buildMultisigSlots(commitment: Word): StorageSlot[] {
  const slot0Word = new Word(new BigUint64Array([BigInt(1), BigInt(1), 0n, 0n]));
  const slot0 = StorageSlot.fromValue(MULTISIG_SLOT_NAMES.THRESHOLD_CONFIG, slot0Word);
  const signersMap = new StorageMap();
  const key = new Word(new BigUint64Array([0n, 0n, 0n, 0n]));
  signersMap.insert(key, commitment);
  const slot1 = StorageSlot.map(MULTISIG_SLOT_NAMES.SIGNER_PUBLIC_KEYS, signersMap);
  const slot2 = StorageSlot.map(MULTISIG_SLOT_NAMES.EXECUTED_TRANSACTIONS, new StorageMap());
  const procThresholdMap = new StorageMap();
  const slot3 = StorageSlot.map(MULTISIG_SLOT_NAMES.PROCEDURE_THRESHOLDS, procThresholdMap);
  return [slot0, slot1, slot2, slot3];
}

export async function createPsmAccount(webClient: WebClient, seed?: Uint8Array) {
  if (!seed) {
    seed = crypto.getRandomValues(new Uint8Array(32));
  }
  try {
    const sk = AuthSecretKey.rpoFalconWithRNG(seed);
    const signerCommitment = sk.publicKey().toCommitment();

    const psmEndpoint = (await fetchFromStorage<string>(PSM_URL_STORAGE_KEY)) || DEFAULT_PSM_ENDPOINT;
    const psm = new PsmHttpClient(psmEndpoint);
    const { commitment, pubkey } = await psm.getPubkey();
    console.log('Fetched PSM public key commitment:', commitment, pubkey);

    const psmSlots = buildPsmSlots(commitment);
    const mutlisigSlots = buildMultisigSlots(signerCommitment);

    const psmBuilder = webClient.createCodeBuilder();
    const psmCode = psmBuilder.compileAccountComponentCode(PSM_MASM);
    const psmComponent = AccountComponent.compile(psmCode, psmSlots).withSupportsAllTypes();

    const multisigBuilder = webClient.createCodeBuilder();
    const psmLib = multisigBuilder.buildLibrary('openzeppelin::psm', PSM_MASM);
    multisigBuilder.linkStaticLibrary(psmLib);
    const multisigCode = multisigBuilder.compileAccountComponentCode(MULTISIG_MASM);
    const multisigComponent = AccountComponent.compile(multisigCode, mutlisigSlots).withSupportsAllTypes();

    console.log('Creating PSM account with commitment:', commitment);

    const accountBuilder = new AccountBuilder(seed)
      .accountType(AccountType.RegularAccountUpdatableCode)
      .storageMode(AccountStorageMode.public())
      .withComponent(psmComponent)
      .withAuthComponent(multisigComponent)
      .withBasicWalletComponent();

    const result = accountBuilder.build();
    await webClient.newAccount(result.account, false);
    await webClient.syncState();
    console.log(result.account.storage().getItem(PSM_SLOT_NAMES.PUBLIC_KEY)?.toHex());
    await webClient.addAccountSecretKeyToWebStore(result.account.id(), sk);
    return result.account;
  } catch (e) {
    console.error('Error creating PSM account:', e);
    throw new Error('Failed to create PSM account');
  }
}
