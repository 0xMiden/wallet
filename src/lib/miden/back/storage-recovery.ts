import { Account, NoteFile, type InputNoteRecord, type MidenClient } from '@miden-sdk/miden-sdk/lazy';
import { GuardianHttpClient } from '@openzeppelin/guardian-client';

import { getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { commitmentFromPublicKeyHex, sameCommitment } from 'lib/secure-hot-key/commitment';
import { b64ToU8, u8ToB64 } from 'lib/shared/helpers';
import type { WalletAccount, WalletStorageRecoveryResult } from 'lib/shared/types';
import { WalletType } from 'screens/onboarding/types';

import { midenClientProxy } from './miden-client-proxy';
import { withUnlocked, store } from './store';
import type { Vault } from './vault';
import { inStorageTurn } from '../front/storage';
import { resolveGuardianEndpoint } from '../guardian/account';
import { ITransactionStatus, type ITransaction } from '../db/types';
import { registerGuardianOrigin } from '../guardian/native-http';
import { readAccountChainStates, type AccountChainState } from '../guardian/recovery-verification';
import { WalletSigner } from '../guardian/signer';
import { canonicalWalletAccountId } from '../sdk/helpers';
import * as Repo from '../repo';
import { MAX_WINDOW_SECONDS } from '../spending-limits/policy';
import { assertWasmHoldCurrent, getMidenClient, withWasmClientLock } from '../sdk/miden-client';
import {
  clearVerifiedStorageFailure,
  getWalletStorageFailure,
  markWalletStorageUnavailable,
  WalletStorageUnavailableError
} from '../storage-health';
import { judgeSubmitEvidence } from '../transaction/reconcile-judge';
import { createNodeReads, observedCadenceMs, RPC_READ_TIMEOUT_MS } from '../transaction/reconcile-reads';

type RecoveryNote = InputNoteRecord & { detailsCommitment(): string; recoveryNoteFile(): NoteFile | undefined };
type RecoveryNotes = MidenClient['notes'] & {
  listPage?: (query: { after?: string; limit: number }) => Promise<RecoveryNote[]>;
};

function recoveryNoteIdentity(bytes: string): string | undefined {
  const file = NoteFile.deserialize(b64ToU8(bytes)) as NoteFile & { detailsCommitment?(): string | undefined };
  try {
    return file.detailsCommitment?.() ?? file.noteId()?.toString();
  } finally {
    file.free();
  }
}

async function readExistingNoteFiles(
  client: MidenClient,
  retained: ReadonlySet<string | undefined>,
  assertCurrent: () => void
): Promise<{ files: string[]; consumed: Map<string, string> }> {
  const notes: RecoveryNotes = client.notes;
  const files: string[] = [];
  const consumed = new Map<string, string>();
  if (!notes.listPage) return { files, consumed };
  let after: string | undefined;
  for (let page = 0; page < 64; page++) {
    assertCurrent();
    const records = await notes.listPage({ after, limit: 64 });
    try {
      for (const record of records) {
        assertCurrent();
        if (record.isConsumed()) {
          const key = record.detailsCommitment();
          const nullifier = retained.has(key) ? record.nullifier() : undefined;
          if (nullifier) consumed.set(key, nullifier);
          continue;
        }
        const file = record.recoveryNoteFile();
        if (!file) continue;
        try {
          files.push(u8ToB64(file.serialize()));
        } finally {
          file.free();
        }
      }
      if (records.length < 64) return { files, consumed };
      const next = records.at(-1)!.detailsCommitment();
      if (next === after) throw new WalletStorageUnavailableError();
      after = next;
    } finally {
      records.forEach(record => record.free());
    }
  }
  throw new WalletStorageUnavailableError();
}

async function confirmConsumedNotes(candidates: ReadonlyMap<string, string>): Promise<Set<string>> {
  if (!candidates.size) return new Set();
  const node = await createNodeReads();
  const confirmed = await Promise.all(
    [...candidates].slice(0, 8).map(async ([identity, nullifier]) => {
      const spentAt = await node.nullifierHeight(nullifier, 0, RPC_READ_TIMEOUT_MS);
      return typeof spentAt === 'number' ? identity : undefined;
    })
  );
  return new Set(confirmed.filter((id): id is string => id !== undefined));
}

export async function retainWalletNotes(notes: readonly string[], rpc: string): Promise<void> {
  return withUnlocked(async ({ vault }) => {
    const assertCurrent = () => {
      if (store.getState().vault !== vault || getEffectiveRpcUrl() !== rpc) throw new WalletStorageUnavailableError();
    };
    assertCurrent();
    await vault.storageJournal.retain(
      data => ({ ...data, notes: [...new Set([...data.notes, ...notes])] }),
      assertCurrent
    );
  });
}

export async function retainWalletTransfer(id: string): Promise<void> {
  return withUnlocked(async ({ vault }) => {
    const rpc = getEffectiveRpcUrl();
    const assertCurrent = () => {
      if (store.getState().vault !== vault || getEffectiveRpcUrl() !== rpc) throw new WalletStorageUnavailableError();
    };
    await vault.storageJournal.retain(async data => {
      const [row, limits] = await Promise.all([Repo.transactions.get(id), Repo.spendingLimits.toArray()]);
      if (!row || row.mayHaveSubmitted !== true) throw new WalletStorageUnavailableError();
      return { ...data, limits, transfers: { ...data.transfers, [id]: Repo.serializeRecoveryTransfer(row) } };
    }, assertCurrent);
  });
}

export async function retainSpendingLimits(): Promise<void> {
  await withUnlocked(async ({ vault }) => {
    const rpc = getEffectiveRpcUrl();
    await vault.storageJournal.retain(
      async data => ({ ...data, limits: await Repo.spendingLimits.toArray() }),
      () => {
        if (store.getState().vault !== vault || getEffectiveRpcUrl() !== rpc) throw new WalletStorageUnavailableError();
      }
    );
  });
}

export async function captureWalletAccounts(
  vault: Vault,
  accounts: readonly WalletAccount[],
  assertCurrent: () => void
): Promise<void> {
  const retained = await vault.storageJournal.read();
  const storedGeneration = await Repo.readWalletStoreGeneration();
  if (retained?.walletStoreGeneration && retained.walletStoreGeneration !== storedGeneration) {
    await markWalletStorageUnavailable();
    return;
  }
  const states = await withWasmClientLock(async hold => {
    const entries = [];
    for (const account of accounts) {
      assertCurrent();
      const state = await midenClientProxy.getAccount(account.publicKey);
      assertWasmHoldCurrent(hold, 'reading account recovery data');
      if (!state) return undefined;
      try {
        entries.push({ id: canonicalWalletAccountId(account.publicKey), state: u8ToB64(state.serialize()) });
      } finally {
        state.free();
      }
    }
    const { client } = await getMidenClient();
    const retainedNotes = new Set(retained?.notes.map(recoveryNoteIdentity));
    const notes = await readExistingNoteFiles(client, retainedNotes, () => {
      assertCurrent();
      assertWasmHoldCurrent(hold, 'reading note recovery data');
    });
    return { accounts: entries, notes };
  });
  if (!states) {
    await markWalletStorageUnavailable();
    return;
  }
  const confirmedConsumed = await confirmConsumedNotes(states.notes.consumed);
  assertCurrent();
  const walletStoreGeneration = storedGeneration ?? crypto.randomUUID();
  await Repo.writeWalletStoreGeneration(walletStoreGeneration);
  const accountIds = new Set(states.accounts.map(entry => entry.id));
  const spentSince = Math.floor(Date.now() / 1000) - MAX_WINDOW_SECONDS;
  await vault.storageJournal.retain(async previous => {
    const [recent, spending, limits] = await Promise.all([
      Repo.transactions.orderBy('initiatedAt').reverse().limit(64).toArray(),
      Repo.transactions
        .where('initiatedAt')
        .aboveOrEqual(spentSince)
        .filter(row => row.spentUsd !== undefined && accountIds.has(canonicalWalletAccountId(row.accountId)))
        .limit(257)
        .toArray(),
      Repo.spendingLimits.toArray()
    ]);
    if (spending.length > 256) throw new WalletStorageUnavailableError();
    const recentById = Object.fromEntries(
      [...recent, ...spending]
        .filter(row => accountIds.has(canonicalWalletAccountId(row.accountId)))
        .map(row => [row.id, Repo.serializeRecoveryTransfer(row)])
    );
    const unresolved = Object.entries(previous.transfers).filter(([, value]) => {
      const transaction = JSON.parse(value);
      return (
        accountIds.has(canonicalWalletAccountId(transaction.accountId)) &&
        transaction.mayHaveSubmitted === true &&
        transaction.status !== ITransactionStatus.Completed
      );
    });
    const notes = new Map<string, string>();
    for (const bytes of [...previous.notes, ...states.notes.files]) {
      const id = recoveryNoteIdentity(bytes);
      if (!id || !confirmedConsumed.has(id)) notes.set(id ?? bytes, bytes);
    }
    return {
      ...previous,
      walletStoreGeneration,
      limits,
      accounts: states.accounts,
      notes: [...notes.values()],
      transfers: { ...Object.fromEntries(unresolved), ...recentById }
    };
  }, assertCurrent);
}

function matchesChain(state: Account, accountId: string, chain: AccountChainState | undefined, locallySaved: boolean) {
  if (state.id().toString() !== accountId) return false;
  if (chain?.kind === 'deployed') return sameCommitment(chain.commitment, state.to_commitment().toHex());
  return locallySaved && chain?.kind === 'absent' && state.isNew();
}

async function fetchCurrentAccountState(account: WalletAccount, vault: Vault, assertCurrent: () => void) {
  if (account.type === WalletType.OnChain && account.isPublic) {
    return withWasmClientLock(async hold => {
      const { client } = await getMidenClient();
      assertCurrent();
      assertWasmHoldCurrent(hold, 'reading public account recovery data');
      const state = await client.accounts.import(canonicalWalletAccountId(account.publicKey));
      try {
        assertCurrent();
        assertWasmHoldCurrent(hold, 'reading public account recovery data');
        return u8ToB64(state.serialize());
      } finally {
        state.free();
      }
    });
  }
  const key = account.coldPublicKey ?? account.hotPublicKey;
  if (!key) throw new WalletStorageUnavailableError();
  const endpoint = resolveGuardianEndpoint(account);
  registerGuardianOrigin(endpoint);
  const guardian = new GuardianHttpClient(endpoint);
  const commitment = await commitmentFromPublicKeyHex(key);
  guardian.setSigner(
    new WalletSigner(key, commitment, (pubkey, word) => {
      assertCurrent();
      return vault.signWord(pubkey, word);
    })
  );
  const response = await guardian.getState(canonicalWalletAccountId(account.publicKey));
  assertCurrent();
  return response.stateJson.data;
}

async function verifyRetainedTransfers(rows: ITransaction[], assertCurrent: () => void): Promise<void> {
  const pending = rows.filter(
    row =>
      row.restoredFromBackup !== true &&
      row.mayHaveSubmitted === true &&
      row.status !== ITransactionStatus.Completed &&
      row.neverCommittedAt === undefined
  );
  if (!pending.length) return;
  const node = await createNodeReads();
  const nowSec = Math.floor(Date.now() / 1000);
  for (const row of pending) {
    assertCurrent();
    const verdict = await judgeSubmitEvidence(row, { node, accountRows: rows, nowSec, cadenceMs: observedCadenceMs() });
    if (!verdict.landed && !verdict.allDead) throw new WalletStorageUnavailableError();
    for (const entry of verdict.judgedEntries) {
      if (entry.preSubmitEnd === true || entry.refBlock === undefined) continue;
      if ((await node.blockCommitment(entry.refBlock)) !== entry.refBlockCommitment) {
        throw new WalletStorageUnavailableError();
      }
    }
    if (verdict.landed) {
      row.status = ITransactionStatus.Completed;
      row.completedAt ??= nowSec;
      row.transactionId = verdict.landed.boundTransactionId ?? row.transactionId;
    } else {
      row.status = ITransactionStatus.Failed;
      row.completedAt ??= nowSec;
      row.neverCommittedAt = nowSec;
    }
  }
}

export async function rebuildWalletStorage(): Promise<WalletStorageRecoveryResult> {
  return inStorageTurn('miden-wallet-storage-rebuild', () =>
    withUnlocked(async ({ vault, accounts }) => {
      const failure = await getWalletStorageFailure();
      if (!failure) throw new WalletStorageUnavailableError();
      const rpc = getEffectiveRpcUrl();
      const assertCurrent = () => {
        if (store.getState().vault !== vault || getEffectiveRpcUrl() !== rpc) throw new WalletStorageUnavailableError();
      };
      const retained = await vault.storageJournal.read();
      if (!retained) throw new WalletStorageUnavailableError();
      const expected = accounts.map(account => canonicalWalletAccountId(account.publicKey));
      const chain = await readAccountChainStates(expected);
      const states: string[] = [];
      for (const [index, account] of accounts.entries()) {
        assertCurrent();
        const id = expected[index]!;
        const saved = retained.accounts.find(entry => entry.id === id);
        const floor = chain.get(id);
        if (floor === undefined || floor.kind === 'unknown') throw new WalletStorageUnavailableError();
        let data = saved?.state;
        if (data) {
          const decoded = Account.deserialize(b64ToU8(data));
          try {
            if (!matchesChain(decoded, id, floor, true)) data = undefined;
          } finally {
            decoded.free();
          }
        }
        states.push(data ?? (await fetchCurrentAccountState(account, vault, assertCurrent)));
        const decoded = Account.deserialize(b64ToU8(states[index]!));
        try {
          if (!matchesChain(decoded, id, floor, data !== undefined)) throw new WalletStorageUnavailableError();
        } finally {
          decoded.free();
        }
      }

      const transfers = Repo.deserializeRecoveryTransfers(retained.transfers, id =>
        expected.includes(canonicalWalletAccountId(id))
      );
      await verifyRetainedTransfers(transfers, assertCurrent);
      const notes = retained.notes;
      await withWasmClientLock(async hold => {
        const { client } = await getMidenClient();
        for (const bytes of states) {
          assertCurrent();
          assertWasmHoldCurrent(hold, 'restoring verified account data');
          const state = Account.deserialize(b64ToU8(bytes));
          await client.accounts.insert({ account: state, overwrite: true });
        }
        for (const bytes of notes) {
          assertCurrent();
          assertWasmHoldCurrent(hold, 'restoring retained note data');
          const file = NoteFile.deserialize(b64ToU8(bytes));
          const noteId = file.noteId()?.toString();
          const imported = await client.notes.import(file);
          const query = noteId ? { ids: [noteId] } : { detailsCommitments: [imported] };
          const records = await client.notes.list(query as Parameters<MidenClient['notes']['list']>[0]);
          records.forEach(record => record.free());
          if (!records.length) throw new WalletStorageUnavailableError();
        }
        assertCurrent();
        for (const bytes of states) {
          assertWasmHoldCurrent(hold, 'verifying restored account data');
          const desired = Account.deserialize(b64ToU8(bytes));
          const actual = await client.accounts.get(desired.id());
          try {
            if (!actual || !sameCommitment(actual.to_commitment().toHex(), desired.to_commitment().toHex())) {
              throw new WalletStorageUnavailableError();
            }
          } finally {
            desired.free();
            actual?.free();
          }
        }
      });
      assertCurrent();
      await Repo.restoreRecoveryTransfers(
        transfers,
        retained.limits,
        id => expected.includes(canonicalWalletAccountId(id)),
        assertCurrent
      );
      const generation = retained.walletStoreGeneration ?? crypto.randomUUID();
      await Repo.writeWalletStoreGeneration(generation);
      await vault.storageJournal.retain(
        data => ({
          ...data,
          walletStoreGeneration: generation,
          transfers: Object.fromEntries(transfers.map(row => [row.id, Repo.serializeRecoveryTransfer(row)]))
        }),
        assertCurrent
      );
      assertCurrent();
      await clearVerifiedStorageFailure(failure);
      return {
        verifiedAccounts: states.length,
        expectedAccounts: accounts.length,
        verifiedNotes: notes.length,
        expectedNotes: notes.length
      };
    })
  );
}
