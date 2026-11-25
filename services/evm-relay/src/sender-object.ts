// The Durable Object of the Sender: one instance per chain, with SQLite storage. It only connects RelaySender to the
// storage, the alarm, the relayer key and the chain RPC. The Jest tests do not load this file, because
// `cloudflare:workers` exists only in the Workers runtime.
// eslint-disable-next-line import/no-unresolved -- The Workers runtime provides this module; no package holds it.
import { DurableObject } from 'cloudflare:workers';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

import { broadcastTransaction, readFees, readReceipts } from './chain';
import type { Hex } from './parse';
import { relayerAddress } from './secrets';
import { RelaySender, type RelayJob, type RelayTransaction, type SubmitJob, type SubmitOutcome } from './sender';
import type { Env } from './types';

const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

export class RelaySenderObject extends DurableObject<Env> {
  private readonly sender: RelaySender;
  /** The signer of the last key read. A new key value builds a new signer. */
  private signer: { key: string; account: PrivateKeyAccount } | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const { storage } = ctx;
    this.sender = new RelaySender({
      sql: {
        run: (query, ...bindings) => storage.sql.exec(query, ...bindings).toArray(),
        transaction: closure => storage.transactionSync(closure)
      },
      relayer: () => {
        const address = relayerAddress(env);
        if (address === null) throw new Error('RELAYER_PRIVATE_KEY is not valid.');
        return address;
      },
      sign: transaction => this.sign(transaction),
      broadcast: (chainId, raw) => broadcastTransaction(env, chainId, raw),
      receipts: (chainId, hashes) => readReceipts(env, chainId, hashes),
      fees: chainId => readFees(env, chainId),
      alarmAt: () => storage.getAlarm(),
      schedule: atMs => storage.setAlarm(atMs),
      now: () => Date.now()
    });
  }

  get(id: Hex): RelayJob | null {
    return this.sender.get(id);
  }

  submit(job: SubmitJob): Promise<SubmitOutcome> {
    return this.sender.submit(job);
  }

  /** The timer: one tick per alarm. The tick arms the next alarm while a relay is pending. */
  alarm(): Promise<void> {
    return this.sender.tick();
  }

  private sign(transaction: RelayTransaction): Promise<Hex> {
    const key = this.env.RELAYER_PRIVATE_KEY;
    if (typeof key !== 'string' || !PRIVATE_KEY.test(key)) throw new Error('RELAYER_PRIVATE_KEY is not valid.');
    if (this.signer?.key !== key) this.signer = { key, account: privateKeyToAccount(`0x${key.slice(2)}`) };
    return this.signer.account.signTransaction(transaction);
  }
}
