/**
 * Test-only: e2e-real.test.ts preloads this with `node --import`, so a preflight runs against canned answers and
 * never the network. E2E_REAL_FETCH_STUB carries `{ document, log }`: the config document to serve as
 * `<network>.json`, and a file each request is appended to (`<url>`, or `<url> <method> <params>` for JSON-RPC).
 */
import { appendFileSync } from 'node:fs';

const { document, log } = JSON.parse(process.env.E2E_REAL_FETCH_STUB ?? '{}');

const json = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
const RPC_RESULTS = { eth_chainId: '0xaa36a7', eth_blockNumber: '0x1', eth_getCode: '0x6080' };

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const call = typeof init.body === 'string' && init.body.includes('"jsonrpc"') ? JSON.parse(init.body) : null;
  appendFileSync(log, call ? `${url} ${call.method} ${JSON.stringify(call.params)}\n` : `${url}\n`);
  if (call) return json({ jsonrpc: '2.0', id: call.id, result: RPC_RESULTS[call.method] });
  if (url.endsWith('.json')) return json(document);
  if (url.endsWith('/health')) return json({ status: 'healthy', allocatorAddresses: { 999999999: '0xa110c' } });
  if (url.endsWith('/checkIfDepositNeeded')) {
    return json({ success: true, path: [[[{}, [{ name: 'stub solver' }], [{}, { token: { amount: '1' } }]]]] });
  }
  if (url.endsWith('/gasless-status')) return json({ enabled: false });
  if (url.endsWith('/get_metadata')) return json({ version: 'stub', base_amount: 1 });
  return new Response('ok');
};
