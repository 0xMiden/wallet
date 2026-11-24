import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';

const scriptFile = fileURLToPath(new URL('./proposal-id-dry-run.mjs', import.meta.url));
const helperFile = fileURLToPath(new URL('./proposal-id-dry-run-lib.mjs', import.meta.url));
const helperAvailable = existsSync(helperFile);
let installWordFreeShim;
let solveFaucetPow;
let isPostPushProposalVerificationFailure;
let proposeKnownNonce;

if (helperAvailable) {
  ({ installWordFreeShim, solveFaucetPow, isPostPushProposalVerificationFailure, proposeKnownNonce } = await import(
    pathToFileURL(helperFile).href
  ));
} else {
  const source = readFileSync(scriptFile, 'utf8');
  const shim = source.match(/for \(const value of Object\.values\(sdkModule\)\) \{[\s\S]*?^\}/m)?.[0];
  assert.ok(shim, 'the current Word free shim is present in the dry-run script');
  installWordFreeShim = sdkModule => runInNewContext(shim, { sdkModule });
}

test('installs the Node free shim on Word only', () => {
  class Word {}
  class Account {}
  class WordWithFree {}
  class NonExtensibleWord {}
  const existingFree = () => 'existing';
  WordWithFree.prototype.free = existingFree;
  Object.preventExtensions(NonExtensibleWord.prototype);

  installWordFreeShim({ Word, Account, WordWithFree, NonExtensibleWord, value: {} });
  installWordFreeShim({ Word: WordWithFree });
  installWordFreeShim({ Word: NonExtensibleWord });

  assert.equal(typeof Word.prototype.free, 'function');
  assert.equal(Word.prototype.free.call(new Word()), undefined);
  assert.equal(Account.prototype.free, undefined);
  assert.equal(WordWithFree.prototype.free, existingFree);
  assert.equal(NonExtensibleWord.prototype.free, undefined);
});

const zeroTargetChild = String.raw`
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const [scriptFile, helperFile] = process.argv.slice(1);
if (existsSync(helperFile)) {
  const { solveFaucetPow } = await import(pathToFileURL(helperFile).href);
  try {
    await solveFaucetPow('00', 0n, { deadlineMs: 50, hashesPerBatch: 1 });
    console.error('the unsatisfiable target unexpectedly resolved');
    process.exitCode = 1;
  } catch (error) {
    const message = String(error?.message ?? error);
    if (message.includes('unsolved within 50ms') && message.includes('target=0')) console.log(message);
    else {
      console.error('the solver rejected with an unexpected error');
      process.exitCode = 1;
    }
  }
} else {
  const source = await readFile(scriptFile, 'utf8');
  const match = source.match(/const solvePow = \(([^)]*)\) => \{([\s\S]*?)^\};/m);
  if (!match) {
    console.error('the current PoW solver is absent from the dry-run script');
    process.exitCode = 2;
  } else {
    const solvePow = new Function('createHash', 'return (' + match[1] + ') => {' + match[2] + '\n};')(
      createHash
    );
    solvePow('00', 0n);
  }
}
`;

test('target 0 settles before the child deadline', async () => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', zeroTargetChild, scriptFile, helperFile], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', chunk => stdout.push(chunk));
  child.stderr.on('data', chunk => stderr.push(chunk));
  let killed = false;
  const deadline = setTimeout(() => {
    killed = true;
    child.kill('SIGKILL');
  }, 1_000);

  try {
    const [code, signal] = await once(child, 'exit');
    assert.equal(killed, false, 'the child was killed instead of reporting the unsolved target');
    assert.equal(code, 0, `child exited with ${code ?? signal}: ${Buffer.concat(stderr).toString()}`);
    assert.match(Buffer.concat(stdout).toString(), /unsolved within 50ms.*target=0/);
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});

if (helperAvailable) {
  test('a nonpositive PoW deadline hashes nothing', async () => {
    let hashes = 0;
    await assert.rejects(
      solveFaucetPow('00', 1n, {
        deadlineMs: 0,
        hashesPerBatch: 1,
        hash: () => {
          hashes++;
          return 0n;
        }
      }),
      /unsolved within 0ms.*target=1/
    );
    assert.equal(hashes, 0);
  });

  test('the first nonce resolves when its digest is below the maximum target', async () => {
    let hashes = 0;
    const nonce = await solveFaucetPow('00', 2n ** 64n, {
      deadlineMs: 1_000,
      hashesPerBatch: 1,
      hash: () => {
        hashes++;
        return 0n;
      }
    });
    assert.equal(nonce, 0);
    assert.equal(hashes, 1);
  });

  test('classifies only post-push proposal verification failures for cleanup', () => {
    const named = (name, message = 'unclassified') => Object.assign(new Error(message), { name });
    assert.equal(isPostPushProposalVerificationFailure(new Error('Invalid proposal: bad binding')), true);
    assert.equal(isPostPushProposalVerificationFailure(named('BoundBlockMismatchError')), true);
    assert.equal(isPostPushProposalVerificationFailure(named('ProposalSaltMalformedError')), true);
    assert.equal(isPostPushProposalVerificationFailure(named('ChainBehindBoundBlockError')), true);
    assert.equal(
      isPostPushProposalVerificationFailure(new Error('malformed boundBlockNum in proposal metadata')),
      true
    );
    assert.equal(isPostPushProposalVerificationFailure(named('ProposalIdMismatchError')), false);
    assert.equal(isPostPushProposalVerificationFailure(named('TransactionSummaryLayoutError')), false);
    assert.equal(
      isPostPushProposalVerificationFailure(Object.assign(new Error('Invalid proposal'), { status: 409 })),
      false
    );
    assert.equal(isPostPushProposalVerificationFailure(new Error('conflict_pending_delta')), false);
    assert.equal(isPostPushProposalVerificationFailure(new Error('failed to decode transaction request')), false);
    assert.equal(isPostPushProposalVerificationFailure(new Error('proposal refused')), false);
  });

  test('abandons the known nonce when SDK verification fails after proposal creation', async () => {
    const error = new Error('Invalid proposal: bound block mismatch');
    let readAccountId;
    let createdNonce;
    let abandonArgs;
    const client = {
      accounts: {
        get: async accountId => {
          readAccountId = accountId;
          return { nonce: () => ({ asInt: () => 40n }) };
        }
      }
    };
    const multisig = {
      account: { nonce: () => ({ asInt: () => 5n }) },
      abandonCandidate: async (...args) => {
        abandonArgs = args;
      }
    };

    await assert.rejects(
      proposeKnownNonce({
        client,
        multisig,
        accountId: 'account-id',
        create: async nonce => {
          createdNonce = nonce;
          throw error;
        }
      }),
      actual => actual === error
    );

    assert.equal(readAccountId, 'account-id');
    assert.equal(createdNonce, 41);
    // No proposal id: the nonce-only request, which Guardians 0.18 and 0.19 both accept.
    assert.deepEqual(abandonArgs, [41, undefined]);
  });

  test('logs a failed abandon and rethrows the verification error', async () => {
    const error = new Error('Invalid proposal: salt');
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => {
      warnings.push(args);
    };
    try {
      await assert.rejects(
        proposeKnownNonce({
          client: { accounts: { get: async () => ({ nonce: () => ({ asInt: () => 40n }) }) } },
          multisig: {
            account: { nonce: () => ({ asInt: () => 5n }) },
            abandonCandidate: async () => {
              throw new Error('abandon refused');
            }
          },
          accountId: 'account-id',
          create: async () => {
            throw error;
          }
        }),
        actual => actual === error
      );
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(warnings.length, 1);
    assert.match(String(warnings[0][0]), /nonce 41/);
  });

  test('does not abandon pre-push, conflict, decode, or nonce-read failures', async () => {
    const rejected = [
      new Error('proposal refused'),
      Object.assign(new Error('Invalid proposal: pending'), { status: 409 }),
      new Error('failed to decode transaction request')
    ];
    for (const error of rejected) {
      let abandons = 0;
      const multisig = {
        account: { nonce: () => ({ asInt: () => 5n }) },
        abandonCandidate: async () => {
          abandons++;
        }
      };
      await assert.rejects(
        proposeKnownNonce({
          client: { accounts: { get: async () => ({ nonce: () => ({ asInt: () => 40n }) }) } },
          multisig,
          accountId: 'account-id',
          create: async () => {
            throw error;
          }
        }),
        actual => actual === error
      );
      assert.equal(abandons, 0);
    }

    let creates = 0;
    let abandons = 0;
    const error = new Error('account lookup failed');
    await assert.rejects(
      proposeKnownNonce({
        client: { accounts: { get: async () => Promise.reject(error) } },
        multisig: {
          account: { nonce: () => ({ asInt: () => 5n }) },
          abandonCandidate: async () => {
            abandons++;
          }
        },
        accountId: 'account-id',
        create: async () => {
          creates++;
        }
      }),
      actual => actual === error
    );
    assert.equal(creates, 0);
    assert.equal(abandons, 0);
  });

  test('uses the account snapshot fallback and refuses unsafe nonces', async () => {
    let fallbackNonce;
    await proposeKnownNonce({
      client: { accounts: { get: async () => null } },
      multisig: {
        account: { nonce: () => ({ asInt: () => 5n }) },
        abandonCandidate: async () => {}
      },
      accountId: 'account-id',
      create: async nonce => {
        fallbackNonce = nonce;
      }
    });
    assert.equal(fallbackNonce, 6);

    let creates = 0;
    let abandons = 0;
    await assert.rejects(
      proposeKnownNonce({
        client: {
          accounts: {
            get: async () => ({ nonce: () => ({ asInt: () => BigInt(Number.MAX_SAFE_INTEGER) }) })
          }
        },
        multisig: {
          account: { nonce: () => ({ asInt: () => 5n }) },
          abandonCandidate: async () => {
            abandons++;
          }
        },
        accountId: 'account-id',
        create: async () => {
          creates++;
        }
      }),
      /nonce is too large/
    );
    assert.equal(creates, 0);
    assert.equal(abandons, 0);
  });
}
