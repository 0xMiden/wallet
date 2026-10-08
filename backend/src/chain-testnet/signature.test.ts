import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

import { buyBatchTypedData, CALIBUR_SEPOLIA_ADDRESS, ONRAMP_NONCE_KEY, SEPOLIA_CHAIN_ID } from './calibur.js';
import { batchInputOf, buildPreparation, type Preparation } from './preparation.js';
import type { AccountState } from './sepolia.js';
import { SignatureCheckError, verifySignedBatch, type AuthorizationBody, type SignatureBody } from './signature.js';
import { CALIBUR_SALT, EXECUTOR, MIDEN_ACCOUNT } from '../test/support.js';

const NOW_MS = 1_800_000_000_000;
const AMOUNT = '1500000000000000000';

function orderOf(account: PrivateKeyAccount) {
  return {
    evmAddress: account.address,
    midenAccountHex: MIDEN_ACCOUNT,
    tokenAmount: AMOUNT
  };
}

function prepare(evmAddress: Address, state: Partial<AccountState> = {}): Preparation {
  const account: AccountState = {
    needsAuthorization: true,
    authorizationNonce: 4,
    sequence: 7n,
    salt: CALIBUR_SALT,
    balance: 0n,
    ...state
  };
  return buildPreparation({ evmAddress, midenAccountHex: MIDEN_ACCOUNT }, AMOUNT, account, EXECUTOR, NOW_MS);
}

async function signAuthorization(signer: PrivateKeyAccount, nonce: number): Promise<AuthorizationBody> {
  const signed = await signer.signAuthorization({ address: CALIBUR_SEPOLIA_ADDRESS, chainId: SEPOLIA_CHAIN_ID, nonce });
  const yParity = signed.yParity;
  assert.ok(yParity === 0 || yParity === 1);
  return { address: signed.address, chainId: signed.chainId, nonce: signed.nonce, r: signed.r, s: signed.s, yParity };
}

async function signBody(
  signer: PrivateKeyAccount,
  owner: PrivateKeyAccount,
  current: Preparation,
  authorization?: AuthorizationBody
): Promise<SignatureBody> {
  const signed = {
    tokenAmount: current.tokenAmount,
    batchNonce: current.batchNonce,
    salt: current.salt,
    deadline: current.deadline
  };
  const signature = await signer.signTypedData(
    buyBatchTypedData(batchInputOf(orderOf(owner), signed, current.executor))
  );
  return { ...signed, signature, authorization };
}

async function rejects(promise: Promise<void>, pattern: RegExp): Promise<void> {
  await assert.rejects(promise, error => error instanceof SignatureCheckError && pattern.test(error.message));
}

describe('buildPreparation', () => {
  it('puts the nonce key in the high bits and sets a 1-day deadline', () => {
    const current = prepare('0x1111111111111111111111111111111111111111');
    assert.equal(current.batchNonce, ((ONRAMP_NONCE_KEY << 64n) | 7n).toString());
    assert.equal(current.deadline, NOW_MS / 1000 + 86_400);
    assert.equal(current.chainId, 11155111);
    assert.equal(current.calibur, CALIBUR_SEPOLIA_ADDRESS);
  });
});

describe('verifySignedBatch', () => {
  const owner = privateKeyToAccount(generatePrivateKey());
  const other = privateKeyToAccount(generatePrivateKey());

  it('accepts the owner batch signature with an authorization at the pending nonce', async () => {
    const current = prepare(owner.address);
    const body = await signBody(owner, owner, current, await signAuthorization(owner, 4));
    await verifySignedBatch(orderOf(owner), body, current, NOW_MS);
  });

  it('accepts a delegated address without an authorization, and refuses one with it', async () => {
    const current = prepare(owner.address, { needsAuthorization: false });
    await verifySignedBatch(orderOf(owner), await signBody(owner, owner, current), current, NOW_MS);
    const withAuthorization = await signBody(owner, owner, current, await signAuthorization(owner, 4));
    await rejects(verifySignedBatch(orderOf(owner), withAuthorization, current, NOW_MS), /already delegated/);
  });

  it('refuses a batch signature from another key', async () => {
    const current = prepare(owner.address);
    const body = await signBody(other, owner, current, await signAuthorization(owner, 4));
    await rejects(verifySignedBatch(orderOf(owner), body, current, NOW_MS), /not from the order address/);
  });

  it('refuses a missing, stale or foreign authorization', async () => {
    const current = prepare(owner.address);
    await rejects(
      verifySignedBatch(orderOf(owner), await signBody(owner, owner, current), current, NOW_MS),
      /authorization is missing/
    );
    const stale = await signBody(owner, owner, current, await signAuthorization(owner, 3));
    await rejects(verifySignedBatch(orderOf(owner), stale, current, NOW_MS), /stale/);
    const foreign = await signBody(owner, owner, current, await signAuthorization(other, 4));
    await rejects(verifySignedBatch(orderOf(owner), foreign, current, NOW_MS), /not from the order address/);
  });

  it('refuses a stale batch nonce, a changed salt, a changed amount and a bad deadline', async () => {
    const signedAt = prepare(owner.address);
    const body = await signBody(owner, owner, signedAt, await signAuthorization(owner, 4));

    const nextSequence = prepare(owner.address, { sequence: 8n });
    await rejects(verifySignedBatch(orderOf(owner), body, nextSequence, NOW_MS), /batchNonce is stale/);

    const otherSalt = prepare(owner.address, { salt: `0x${'1'.repeat(24)}${CALIBUR_SALT.slice(26)}` });
    await rejects(verifySignedBatch(orderOf(owner), body, otherSalt, NOW_MS), /salt/);

    await rejects(verifySignedBatch(orderOf(owner), { ...body, tokenAmount: '1' }, signedAt, NOW_MS), /tokenAmount/);
    await rejects(verifySignedBatch(orderOf(owner), body, signedAt, NOW_MS + 86_401_000), /deadline/);
    await rejects(
      verifySignedBatch(orderOf(owner), { ...body, deadline: signedAt.deadline + 3600 }, signedAt, NOW_MS),
      /deadline/
    );
  });

  it('refuses a signature for a changed deadline', async () => {
    const current = prepare(owner.address);
    const body = await signBody(owner, owner, current, await signAuthorization(owner, 4));
    await rejects(
      verifySignedBatch(orderOf(owner), { ...body, deadline: current.deadline - 10 }, current, NOW_MS),
      /not from the order address/
    );
  });
});
