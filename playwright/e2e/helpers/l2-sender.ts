/**
 * The source-chain sender behind a headless Reown counterparty on an executor-route source chain, for a deposit the
 * wallet's own deposit screen drives (usdcx-live-executor-deposit.ios.spec.ts). It sends as submitL2Deposit sends the
 * harness key's deposit: one write endpoint that takes raw transactions, a nonce read once and counted locally, the tip
 * held to the chain's cap (sendSigned), and every send after the first simulated and estimated at the later of the
 * previous send's block and the write endpoint's head, since load-balanced public RPCs served a burn the state from
 * before its approve (#1504). A send that would revert there, a target it was not given, a value and anything after its
 * signal aborted are refused unsent.
 */
import { isAddressEqual, type Address, type Hash, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import {
  chainRead,
  pickWriteEndpoint,
  pinAfterApprove,
  sendSigned,
  simulate,
  startingAt,
  waitForReceipt,
  type ArcReadDeps
} from './arc-usdcx';
import type { L2BridgeInSource } from './usdcx-constants';
import { l2Reads } from './usdcx-l2-deposit';

export interface L2Transaction {
  to: Address;
  data: Hex;
  value: bigint;
}

export interface L2Sender {
  /** The endpoint that takes the writes; a proof of what was sent reads there first. */
  readonly endpoint: string;
  /** Every hash sent, in order. */
  readonly sent: readonly Hash[];
  send(tx: L2Transaction, signal?: AbortSignal): Promise<Hash>;
}

export async function createL2Sender(
  args: { privateKey: Hex; l2: L2BridgeInSource; allowedTargets: readonly Address[] },
  deps: Pick<ArcReadDeps, 'publicClient' | 'clock'> = {}
): Promise<L2Sender> {
  const { l2 } = args;
  const reads = l2Reads(l2, deps);
  const account = privateKeyToAccount(args.privateKey);
  const endpoint = await pickWriteEndpoint(reads);
  const endpoints = { write: endpoint, reads: startingAt(reads.endpoints, endpoint) };
  const sent: Hash[] = [];
  let nonce: number | undefined;
  const sendOne = async (tx: L2Transaction, signal: AbortSignal | undefined): Promise<Hash> => {
    const what = `transaction ${sent.length + 1} to ${tx.to} on ${l2.payout.label}`;
    if (!args.allowedTargets.some(target => isAddressEqual(target, tx.to))) {
      throw new Error(`${what} refused: the key sends only to ${args.allowedTargets.join(', ')}`);
    }
    if (tx.value !== 0n) throw new Error(`${what} refused: it carries ${tx.value} wei`);
    nonce ??= await chainRead(`${l2.payout.label} nonce`, endpoints.reads, reads, client =>
      client.getTransactionCount({ address: account.address, blockTag: 'pending' })
    );
    const previous = sent.at(-1);
    const previousBlock =
      previous === undefined ? undefined : (await waitForReceipt(endpoints.reads, reads, previous)).blockNumber;
    const atBlock = await pinAfterApprove(endpoint, reads, previousBlock);
    await simulate(
      what,
      endpoint,
      reads,
      (client, blockNumber) => client.call({ account: account.address, to: tx.to, data: tx.data, blockNumber }),
      atBlock
    );
    const hash = await sendSigned(
      reads,
      endpoints,
      account,
      { what, to: tx.to, data: tx.data, nonce, atBlock },
      signal
    );
    nonce += 1;
    sent.push(hash);
    return hash;
  };
  // The app waits for each receipt before its next prompt; the queue keeps two requests from sharing a nonce anyway.
  let queue: Promise<unknown> = Promise.resolve();
  return {
    endpoint,
    sent,
    send(tx, signal) {
      const next = queue.then(() => sendOne(tx, signal));
      queue = next.catch(() => undefined);
      return next;
    }
  };
}
