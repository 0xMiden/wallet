import { getAddress, type Address, type Hex } from 'viem';

import { CALIBUR_SEPOLIA_ADDRESS } from '../chain-testnet/calibur.js';
import type { AccountState, Chain, ReceiptStatus, RelayTransaction, SentRelay } from '../chain-testnet/sepolia.js';
import { setLogWriter } from '../log.js';
import { openDatabase, OrderStore } from '../orders/store.js';
import type { TransakOrder } from '../transak/client.js';

/** Test helpers. The test runner does not run this file, because its name does not end in `.test.ts`. */

export const TOKEN: Address = getAddress('0x0c86a754a29714c4fe9c6f1359fa7099ed174c0b');
export const EXECUTOR: Address = '0x2222222222222222222222222222222222222222';
export const MIDEN_ACCOUNT = `0x${'0a'.repeat(15)}`;
export const CALIBUR_SALT: Hex = `0x${'0'.repeat(24)}${CALIBUR_SEPOLIA_ADDRESS.slice(2).toLowerCase()}`;

/** Keep the log lines in a list, so that a test can read them and the output stays clean. */
export function captureLogs(): string[] {
  const lines: string[] = [];
  setLogWriter(line => {
    lines.push(line);
  });
  return lines;
}

export function memoryStore(now: () => number): OrderStore {
  return new OrderStore(openDatabase(':memory:'), now);
}

export class FakeChain implements Chain {
  executor: Address = EXECUTOR;
  account: AccountState = {
    needsAuthorization: true,
    authorizationNonce: 0,
    sequence: 0n,
    salt: CALIBUR_SALT,
    balance: 0n
  };
  sent: RelayTransaction[] = [];
  receipts = new Map<Hex, ReceiptStatus>();
  failSend = false;
  private count = 0;

  async readAccount(): Promise<AccountState> {
    return { ...this.account };
  }

  async readBalance(): Promise<bigint> {
    return this.account.balance;
  }

  async sendRelay(transaction: RelayTransaction): Promise<SentRelay> {
    if (this.failSend) {
      throw new Error('estimateGas reverted');
    }
    this.sent.push(transaction);
    this.count += 1;
    const hash: Hex = `0x${this.count.toString(16).padStart(64, '0')}`;
    return { hash, nonce: this.count, type4: transaction.authorization !== null };
  }

  async getReceiptStatus(hash: Hex): Promise<ReceiptStatus> {
    return this.receipts.get(hash) ?? null;
  }
}

export class FakeTransakOrders {
  orders = new Map<string, TransakOrder>();
  fail = false;
  /** The `partnerOrderId` of each call, in order. */
  calls: string[] = [];
  /** When set, each call waits for this promise. A test uses it to hold a tick open. */
  gate: Promise<void> | null = null;

  set(partnerOrderId: string, status: string, cryptoAmount: number | null): void {
    this.orders.set(partnerOrderId, {
      id: `transak-${partnerOrderId}`,
      status,
      partnerOrderId,
      cryptoAmount,
      walletAddress: null,
      transactionHash: null
    });
  }

  async getOrderByPartnerId(partnerOrderId: string): Promise<TransakOrder | null> {
    this.calls.push(partnerOrderId);
    if (this.gate !== null) {
      await this.gate;
    }
    if (this.fail) {
      throw new Error('Transak is down');
    }
    return this.orders.get(partnerOrderId) ?? null;
  }
}

