import { NoteFilterTypes } from '@miden-sdk/miden-sdk/lazy';
import {
  AllowedPrivateData,
  WalletError,
  EventEmitter,
  InputNoteDetails,
  MidenConsumeTransaction,
  MidenSendTransaction,
  MidenTransaction,
  PrivateDataPermission,
  SignKind,
  WalletAdapterNetwork
} from '@miden-sdk/miden-wallet-adapter-base';
import { MidenWallet, MidenWalletEvents } from '@miden-sdk/miden-wallet-adapter-miden';

import {
  importPrivateNote,
  isAvailable,
  onPermissionChange,
  requestAssets,
  requestConsumableNotes,
  requestConsume,
  requestDisconnect,
  requestGuardianInfo,
  requestPermission,
  requestPrivateNotes,
  requestSend,
  requestTransaction,
  signBytes,
  waitForTransaction
} from 'lib/adapter/client';
import { MidenDAppCurrentPermission, MidenDAppPermission } from 'lib/adapter/types';
import { TransactionOutput } from 'lib/miden/db/types';
import { b64ToU8, bytesToHex, u8ToB64 } from 'lib/shared/helpers';
import { GuardianInfo } from 'lib/shared/types';

export class MidenWindowObject extends EventEmitter<MidenWalletEvents> implements MidenWallet {
  address?: string | undefined;
  publicKey?: Uint8Array | undefined;
  permission?: (NonNullable<MidenDAppPermission> & { publicKey?: Uint8Array }) | undefined;
  appName?: string | undefined;
  network?: WalletAdapterNetwork | undefined;
  private clearAccountChangeInterval?: () => void | undefined;

  async isAvailable(): Promise<boolean> {
    return await isAvailable();
  }

  async requestSend(transaction: MidenSendTransaction): Promise<{ transactionId?: string | undefined }> {
    const res = await requestSend(this.address!, transaction);
    return { transactionId: res };
  }

  async requestConsume(transaction: MidenConsumeTransaction): Promise<{ transactionId?: string }> {
    const res = await requestConsume(this.address!, transaction);
    return { transactionId: res };
  }

  async requestTransaction(transaction: MidenTransaction): Promise<{ transactionId?: string | undefined }> {
    const res = await requestTransaction(this.address!, transaction);
    return { transactionId: res };
  }

  async requestPrivateNotes(
    notefilterType: NoteFilterTypes,
    noteIds?: string[]
  ): Promise<{ privateNotes: InputNoteDetails[] }> {
    const res = await requestPrivateNotes(this.address!, notefilterType, noteIds);
    return { privateNotes: res };
  }

  async waitForTransaction(txId: string): Promise<TransactionOutput> {
    const res = await waitForTransaction(txId);
    return res;
  }

  async signBytes(data: Uint8Array, kind: SignKind): Promise<{ signature: Uint8Array }> {
    const publicKeyAsHex = bytesToHex(this.publicKey!);
    const messageAsB64 = u8ToB64(data);

    const signatureAsB64 = await signBytes(this.address!, publicKeyAsHex, messageAsB64, kind);
    const signatureAsU8Array = b64ToU8(signatureAsB64);
    return { signature: signatureAsU8Array };
  }

  async importPrivateNote(note: Uint8Array): Promise<{ noteId: string }> {
    const noteAsB64 = u8ToB64(note);

    const noteId = await importPrivateNote(this.address!, noteAsB64);
    return { noteId };
  }

  async requestAssets(): Promise<{ assets: any[] }> {
    const res = await requestAssets(this.address!);
    return { assets: res };
  }

  async requestGuardianInfo(): Promise<{ guardianInfo: GuardianInfo }> {
    const res = await requestGuardianInfo(this.address!);
    return { guardianInfo: res };
  }

  async requestConsumableNotes(): Promise<{ consumableNotes: InputNoteDetails[] }> {
    const res = await requestConsumableNotes(this.address!);
    return { consumableNotes: res };
  }

  async connect(
    privateDataPermission: PrivateDataPermission,
    network: WalletAdapterNetwork,
    allowedPrivateData?: AllowedPrivateData
  ): Promise<void> {
    const perm = await requestPermission(
      { name: window.location.hostname },
      false,
      privateDataPermission,
      network,
      allowedPrivateData
    );
    this.permission = perm;
    this.address = perm.address;
    this.network = network;
    this.publicKey = perm.publicKey;
    // The adapter can call connect() again without a disconnect(), which stops only the latest poll. The poll
    // starts from this permission, so a first check that finds no grant clears the account (#1227).
    this.clearAccountChangeInterval?.();
    this.clearAccountChangeInterval = onPermissionChange(current => this.applyPermission(current), perm);
  }

  // The poll stops before the request: after accountChange(null) that account holds no session for
  // this origin and the request is refused, and a poll still running would repopulate the fields.
  async disconnect(): Promise<void> {
    this.clearAccountChangeInterval?.();
    try {
      await requestDisconnect();
    } finally {
      this.address = undefined;
      this.publicKey = undefined;
      this.permission = undefined;
    }
  }

  // An account switch arrives here (#174). A permission for the account already held changes
  // nothing: the poll records a key that cannot be decoded and the fields do not, so a switch back
  // to the held account reaches here. The fields follow a new account before listeners hear of it,
  // and null (no grant from that account) clears them. The permission carries the decoded key, the
  // shape connect gives. A malformed key throws before anything changes; onPermissionChange has
  // recorded it and does not retry it, as the same key would fail again.
  private applyPermission(perm: MidenDAppCurrentPermission) {
    if (perm?.address === this.address) return;
    if (perm === null) {
      this.address = undefined;
      this.publicKey = undefined;
      this.permission = undefined;
      this.emitAccountChange(null);
      return;
    }
    const publicKey = perm.publicKey ? b64ToU8(perm.publicKey) : undefined;
    const permission = { ...perm, publicKey };
    this.permission = permission;
    this.address = perm.address;
    this.publicKey = publicKey;
    this.emitAccountChange(permission);
  }

  // eventemitter3's emit stops at a listener that throws and rethrows into the poll, so each listener
  // runs on its own, as in the injected providers. A once-listener is removed before its call, as
  // eventemitter3 does, so one that throws is removed too. listeners() drops a registered context, so
  // each runs with this object as `this`, eventemitter3's default.
  private emitAccountChange(permission: NonNullable<MidenWindowObject['permission']> | null) {
    for (const listener of this.listeners('accountChange')) {
      this.removeListener('accountChange', listener, undefined, true);
      try {
        listener.call(this, permission);
      } catch (e) {
        console.error('[MidenWallet] Error in accountChange listener:', e);
      }
    }
  }

  /**
   * Not supported by this wallet.
   *
   * `createAccount` has been on the published `MidenWallet` interface since
   * adapter 0.13.2, but no Miden wallet provider implements it: the extension,
   * the mobile injection script and the Tauri provider all lack it, and there
   * is no `CREATE_ACCOUNT_REQUEST` in `MidenDAppMessageType`. Before this the
   * method was simply absent, so a dApp calling it got
   * `TypeError: wallet.createAccount is not a function`.
   *
   * Rejecting with a named error is not a fix — it is a clearer failure. The
   * fix is either to add the wire round-trip across all three providers, or to
   * drop the method from the adapter interface.
   */
  async createAccount(): Promise<{ accountId: string }> {
    throw new WalletError(
      'createAccount is not supported by the Miden wallet. No provider implements it and there is no wire message for it.'
    );
  }
}
