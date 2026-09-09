import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  encodeGetAccountWithDetails,
  nodeVersionFromPackageJson,
  probePublicAccountState,
  type ProbeFetch
} from './node-account-probe';

const BRIDGE = '0xa22ec154f9a36d911953fd5c9260a7';

function fakeFetch(headers: Record<string, string>, httpStatus = 200): ProbeFetch {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return async () => ({ status: httpStatus, headers: { get: (name: string) => lower[name.toLowerCase()] ?? null } });
}

describe('encodeGetAccountWithDetails', () => {
  it('frames AccountRequest{account_id, details{storage_maps:{}}} the way the node decodes it', () => {
    const frame = encodeGetAccountWithDetails(BRIDGE);
    // 5-byte gRPC prefix: uncompressed flag + big-endian length of the 23-byte message.
    expect(Array.from(frame.slice(0, 5))).toEqual([0, 0, 0, 0, 23]);
    // account_id (0a11 → 0a0f + 15 bytes), then details (1a02 → storage_maps 2200).
    expect(Buffer.from(frame.slice(5)).toString('hex')).toBe('0a110a0fa22ec154f9a36d911953fd5c9260a71a022200');
  });

  it('rejects anything but a 15-byte hex id', () => {
    expect(() => encodeGetAccountWithDetails('0x1234')).toThrow(/15-byte/);
  });
});

describe('probePublicAccountState', () => {
  it('is present when the node answers without a gRPC error header', async () => {
    const result = await probePublicAccountState('https://node.example', BRIDGE, '0.16.0', fakeFetch({}));
    expect(result.state).toBe('present');
  });

  it('is absent on INVALID_ARGUMENT "not found at block", which is what a missing account says', async () => {
    const result = await probePublicAccountState(
      'https://node.example/',
      BRIDGE,
      '0.16.0',
      fakeFetch({
        'grpc-status': '3',
        'grpc-message': encodeURIComponent(`account ${BRIDGE} not found at block 13177`)
      })
    );
    expect(result).toEqual({ state: 'absent', detail: `account ${BRIDGE} not found at block 13177` });
  });

  it('is unknown for any other error, so a broken probe never hides a real failure', async () => {
    const versionGate = await probePublicAccountState(
      'https://node.example',
      BRIDGE,
      '0.16.0',
      fakeFetch({ 'grpc-status': '3', 'grpc-message': 'server does not support any of the specified content types' })
    );
    expect(versionGate.state).toBe('unknown');
    const unreachable = await probePublicAccountState('https://node.example', BRIDGE, '0.16.0', async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(unreachable.state).toBe('unknown');
    expect(unreachable.detail).toContain('ECONNREFUSED');
  });

  it('sends the node the client line from package.json in the accept header', async () => {
    const seen: Record<string, string>[] = [];
    const spy: ProbeFetch = async (_url, init) => {
      seen.push(init.headers);
      return { status: 200, headers: { get: () => null } };
    };
    await probePublicAccountState('https://node.example', BRIDGE, '0.16.0', spy);
    expect(seen[0]?.accept).toBe('application/vnd.miden; version=0.16.0');
  });
});

describe('nodeVersionFromPackageJson', () => {
  it('reads midenClientCliVersion and refuses a manifest without it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-'));
    const good = path.join(dir, 'good.json');
    fs.writeFileSync(good, JSON.stringify({ midenClientCliVersion: '0.16.0' }));
    expect(nodeVersionFromPackageJson(good)).toBe('0.16.0');
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{}');
    expect(() => nodeVersionFromPackageJson(bad)).toThrow(/midenClientCliVersion/);
  });
});
