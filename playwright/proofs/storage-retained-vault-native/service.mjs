import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';

const binaryHash = 'b86128e63f0e8bbdeb6a3a29c443a48c79a94ed173d59264179c1dde62476f50';
const hash = value => createHash('sha256').update(value).digest('hex');
function frame(body, type = 0) {
  const header = Buffer.alloc(5);
  header[0] = type;
  header.writeUInt32BE(body.length, 1);
  return Buffer.concat([header, body]);
}
async function readBody(request, cap) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > cap) throw new Error('request-bound');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function executeProducer(binary, chain, account, output) {
  if (hash(await readFile(binary)) !== binaryHash) throw new Error('producer-binding');
  await new Promise((resolvePromise, reject) => {
    const child = spawn(binary, [chain, account, output], {
      stdio: ['ignore', 'ignore', 'ignore'],
      env: { ...process.env, RAYON_NUM_THREADS: '2' }
    });
    let expired = false;
    const timer = setTimeout(() => {
      expired = true;
      child.kill('SIGTERM');
    }, 60_000);
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error('producer-launch'));
    });
    child.once('exit', code => {
      clearTimeout(timer);
      code === 0 && !expired ? resolvePromise() : reject(new Error('producer-exit'));
    });
  });
}
export async function createRecoveryService(buildRoot, binary) {
  const directory = await mkdtemp(join(tmpdir(), 'wallet-retained-proof-'));
  const root = resolve(buildRoot);
  let fixture;
  let receipt;
  let state;
  let pending;
  let sealed = false;
  const images = new Map();
  const counts = { guardianReads: 0, accountReads: 0, headerReads: 0, refusedRequests: 0, signedGuardianRequests: 0, limitsReads: 0, nullifierReads: 0, mmrReads: 0, unknownRpc: 0, unknownNullifiers: 0, unknownLimits: 0, unknownOther: 0, unknownSyncChainMmr: 0, unknownSyncNotes: 0, unknownSyncTransactions: 0, unknownHeaders: 0, unknownAccount: 0, learningMethod: 0, closedRoute: 0, otherRefusal: 0 };
  const output = join(directory, 'generated');
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      const send = value => {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(value));
      };
      if (url.pathname.startsWith('/__fixture/') && request.method === 'POST') {
        const action = url.pathname.slice('/__fixture/'.length);
        const data = JSON.parse(
          (await readBody(request, action === 'produce' ? 80 * 1024 * 1024 : 4096)).toString('utf8')
        );
        if (action === 'produce') {
          if (
            fixture ||
            !Array.isArray(data.chain) ||
            data.chain.length > 16 * 1024 * 1024 ||
            !Array.isArray(data.accountBytes) ||
            data.accountBytes.length > 2 * 1024 * 1024 ||
            typeof data.accountId !== 'string' ||
            data.accountId.length > 128
          )
            throw new Error('produce-shape');
          const chainFile = join(directory, 'chain.bin'),
            accountFile = join(directory, 'account.txt');
          await writeFile(chainFile, Buffer.from(data.chain), { mode: 0o600, flag: 'wx' });
          await writeFile(accountFile, data.accountId, { mode: 0o600, flag: 'wx' });
          await executeProducer(binary, chainFile, accountFile, output);
          await rm(chainFile);
          await rm(accountFile);
          receipt = JSON.parse(await readFile(join(output, 'receipt.json'), 'utf8'));
          if (
            receipt.account_responses !== 1 ||
            receipt.header_responses < 1 ||
            receipt.header_responses > 32 ||
            receipt.account_absent !== true ||
            receipt.account_root_bound !== true ||
            receipt.headers_mmr_verified !== true ||
            receipt.generated_wire_roundtrip !== true ||
            receipt.output_bytes > 2 * 1024 * 1024
          )
            throw new Error('producer-receipt');
          fixture = {
            accountId: data.accountId,
            accountBytes: Buffer.from(data.accountBytes),
            accountCommitment: data.accountCommitment
          };
          send({ headers: receipt.header_responses, accountProof: true });
          return;
        }
        if (action === 'learn') {
          if (
            !fixture ||
            sealed ||
            pending ||
            images.size >= 66 ||
            !['header', 'account', 'nullifier'].includes(data.kind) ||
            (data.kind === 'header' &&
              (!Number.isInteger(data.height) || data.height < 0 || data.height >= receipt.header_responses))
          )
            throw new Error('learning-bound');
          pending = data;
          send({ accepted: true });
          return;
        }
        if (action === 'seal') {
          if (sealed || pending || images.size < 3) throw new Error('seal-bound');
          sealed = true;
          send({ sealed: true });
          return;
        }
        if (action === 'state') {
          if (!sealed || state || data.accountId !== fixture.accountId || typeof data.includePrivate !== 'boolean')
            throw new Error('state-bound');
          state = data;
          send({ retained: true });
          return;
        }
        if (action === 'post-recovery') {
          if (!state || typeof data.journalDigest !== 'string' || !/^[0-9a-f]{64}$/.test(data.journalDigest))
            throw new Error('post-recovery-bound');
          state.recoveredJournalDigest = data.journalDigest;
          send({ retained: true });
          return;
        }
        if (action === 'read-state') {
          if (!state) throw new Error('state-missing');
          send(state);
          return;
        }
        if (action === 'summary') {
          send({ ...counts, generatedResponses: receipt?.header_responses + 1, requestImages: images.size });
          return;
        }
        throw new Error('control-route');
      }
      if (url.pathname.startsWith('/miden.node.v1.NodeService/') && request.method === 'POST') {
        const body = await readBody(request, 64 * 1024);
        const identity = hash(Buffer.concat([Buffer.from(url.pathname), Buffer.from([0]), body]));
        let image;
        if (fixture && url.pathname.endsWith('/SyncChainMmr') && body.equals(frame(await readFile(join(output, 'mmr-request.pb'))))) {
          image = { kind: 'mmr', bytes: await readFile(join(output, 'mmr-response.pb')) };
        } else if (fixture && url.pathname.endsWith('/GetLimits')) {
          image = { kind: 'limits', bytes: await readFile(join(output, 'limits.pb')) };
        } else if (!sealed && pending) {
          const expectedMethod = pending.kind === 'header' ? '/GetBlockHeaderByNumber' : pending.kind === 'account' ? '/GetAccount' : '/SyncNullifiers';
          if (!url.pathname.endsWith(expectedMethod)) {
            image = images.get(identity);
            if (!image) throw new Error('learning-method');
          } else {
            const file = pending.kind === 'header' ? `header-${pending.height}.pb` : pending.kind === 'account' ? 'account.pb' : 'nullifiers.pb';
            image = { kind: pending.kind, bytes: await readFile(join(output, file)) };
            const previous = images.get(identity);
            if (previous && !previous.bytes.equals(image.bytes)) throw new Error('request-image-collision');
            images.set(identity, image);
            pending = undefined;
          }
        } else image = images.get(identity);
        if (!image) {
          if (url.pathname.endsWith('/SyncNullifiers')) counts.unknownNullifiers++;
          else if (url.pathname.endsWith('/GetLimits')) counts.unknownLimits++;
          else if (url.pathname.endsWith('/SyncChainMmr')) counts.unknownSyncChainMmr++;
          else if (url.pathname.endsWith('/SyncNotes')) counts.unknownSyncNotes++;
          else if (url.pathname.endsWith('/SyncTransactions')) counts.unknownSyncTransactions++;
          else if (url.pathname.endsWith('/GetBlockHeaderByNumber')) counts.unknownHeaders++;
          else if (url.pathname.endsWith('/GetAccount')) counts.unknownAccount++;
          else counts.unknownOther++;
          throw new Error('unknown-rpc-request');
        }
        if (sealed && image.kind !== 'limits' && image.kind !== 'mmr') counts[image.kind === 'account' ? 'accountReads' : image.kind === 'header' ? 'headerReads' : 'nullifierReads']++;
        if (sealed && image.kind === 'mmr') counts.mmrReads++;
        if (sealed && image.kind === 'limits') counts.limitsReads++;
        response.setHeader('Content-Type', 'application/grpc-web+proto');
        response.setHeader('grpc-status', '0');
        response.end(Buffer.concat([frame(image.bytes), frame(Buffer.from('grpc-status: 0\r\n'), 128)]));
        return;
      }
      if (
        url.pathname === '/guardian/state' &&
        request.method === 'GET' &&
        sealed &&
        url.searchParams.get('account_id') === fixture.accountId
      ) {
        const signed = ['x-pubkey', 'x-signature', 'x-timestamp'].every(
          name => typeof request.headers[name] === 'string' && request.headers[name].length > 0
        );
        if (!signed) throw new Error('guardian-signature-absent');
        counts.guardianReads++;
        counts.signedGuardianRequests++;
        send({
          account_id: fixture.accountId,
          commitment: fixture.accountCommitment,
          state_json: { data: fixture.accountBytes.toString('base64') },
          created_at: 1,
          updated_at: 1,
          auth_scheme: 'ecdsa'
        });
        return;
      }
      if (request.method !== 'GET' || !url.pathname.startsWith('/st/')) throw new Error('closed-route');
      const target = resolve(root, '.' + (url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname));
      if (!target.startsWith(root + sep) || !(await stat(target)).isFile()) throw new Error('static-route');
      const types = {
        '.js': 'text/javascript',
        '.html': 'text/html',
        '.wasm': 'application/wasm',
        '.css': 'text/css',
        '.json': 'application/json'
      };
      response.setHeader('Content-Type', types[extname(target)] || 'application/octet-stream');
      response.end(await readFile(target));
    } catch (error) {
      counts.refusedRequests++;
      if (error instanceof Error && error.message === 'unknown-rpc-request') counts.unknownRpc++;
      else if (error instanceof Error && error.message === 'learning-method') counts.learningMethod++;
      else if (error instanceof Error && error.message === 'closed-route') counts.closedRoute++;
      else counts.otherRefusal++;
      response.statusCode = 409;
      response.end('fixture-refused');
    }
  });
  await new Promise(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server-address');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      server.closeAllConnections();
      await new Promise(resolvePromise => server.close(resolvePromise));
      await rm(directory, { recursive: true, force: true });
    },
    summary() {
      return { ...counts, generatedResponses: receipt ? receipt.header_responses + 1 : 0, requestImages: images.size };
    }
  };
}
