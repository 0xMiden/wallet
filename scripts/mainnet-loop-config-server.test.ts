/** @jest-environment node */
import type { Server } from 'node:http';
import { startMainnetLoopConfigServer } from '../playwright/e2e/helpers/mainnet-loop-config';

let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  server = undefined;
});
async function start(snapshot: unknown = { network: 'mainnet', version: 18, features: { nearIntents: true } }) {
  server = await startMainnetLoopConfigServer(snapshot);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No owned loopback listener');
  expect(address.address).toBe('127.0.0.1');
  return `http://127.0.0.1:${address.port}`;
}
it('serves the exact snapshot to the build and Node consumer from loopback only', async () => {
  const document = { network: 'mainnet', version: 18, features: { nearIntents: true }, unchanged: { fee: 7 } };
  const url = await start(document);
  const response = await fetch(`${url}/mainnet.json`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(document);
  expect(response.headers.get('access-control-allow-origin')).toBe('*');
  expect(response.headers.get('cache-control')).toBe('no-store');
});
it('does not retarget a build when the caller later mutates its input', async () => {
  const document = { network: 'mainnet', version: 18, features: { nearIntents: true } };
  const url = await start(document);
  document.features.nearIntents = false;
  expect(await (await fetch(`${url}/mainnet.json`)).json()).toEqual({
    network: 'mainnet', version: 18, features: { nearIntents: true }
  });
});
it.each(['/other.json', '/mainnet.json?source=other'])('does not expose another config path: %s', async path => {
  const url = await start();
  expect((await fetch(`${url}${path}`)).status).toBe(404);
});
it('does not accept configuration writes', async () => {
  const url = await start();
  expect((await fetch(`${url}/mainnet.json`, { method: 'POST', body: '{}' })).status).toBe(405);
});
it('rejects another Host header instead of exposing the owned listener to DNS rebinding', async () => {
  const url = await start();
  expect((await fetch(`${url}/mainnet.json`, { headers: { Host: 'other.example' } })).status).toBe(400);
});
it.each([{}, { network: 'testnet', version: 18 }, { network: 'mainnet', version: 0 }])(
  'refuses a non-mainnet or unversioned snapshot before listening: %j', async document => {
    await expect(startMainnetLoopConfigServer(document)).rejects.toThrow();
  }
);
