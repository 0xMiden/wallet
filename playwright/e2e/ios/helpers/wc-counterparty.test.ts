/**
 * @jest-environment node
 */
import type { Hash } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { WcCounterparty } from './wc-counterparty';

type Listener = (event: unknown) => Promise<void> | void;

interface FakeClient {
  options: Record<string, unknown>;
  listeners: Map<string, Set<Listener>>;
  approvals: unknown[];
  responses: unknown[];
}

const mockClients: FakeClient[] = [];

// The real SignClient opens a relay socket; this one records what the counterparty asks of it.
jest.mock('@walletconnect/sign-client', () => ({
  __esModule: true,
  default: {
    init: async (options: Record<string, unknown>) => {
      const fake: FakeClient = { options, listeners: new Map(), approvals: [], responses: [] };
      mockClients.push(fake);
      return {
        on: (event: string, listener: Listener) => {
          const set = fake.listeners.get(event) ?? new Set<Listener>();
          set.add(listener);
          fake.listeners.set(event, set);
        },
        off: (event: string, listener: Listener) => {
          fake.listeners.get(event)?.delete(listener);
        },
        approve: async (args: unknown) => {
          fake.approvals.push(args);
          return { topic: 'topic-1', acknowledged: async () => undefined };
        },
        respond: async (args: unknown) => {
          fake.responses.push(args);
        },
        pair: async () => undefined,
        disconnect: async () => undefined,
        core: { relayer: { transportClose: async () => undefined } }
      };
    }
  }
}));

// The real builder intersects the app's proposal with what the counterparty supports; what it supports is under test.
jest.mock('@walletconnect/utils', () => ({
  buildApprovedNamespaces: ({ supportedNamespaces }: { supportedNamespaces: unknown }) => supportedNamespaces
}));

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const { address: KEY_ADDRESS } = privateKeyToAccount(KEY);
const BASE_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const HASH: Hash = `0x${'ab'.repeat(32)}`;

const request = (chainId: string, method: string, params: unknown, id = 1) => ({
  topic: 'topic-1',
  id,
  params: { chainId, request: { method, params } }
});

async function emit(client: FakeClient | undefined, event: string, payload: unknown): Promise<void> {
  for (const listener of [...(client?.listeners.get(event) ?? [])]) await listener(payload);
}

beforeEach(() => {
  mockClients.length = 0;
});

it('gives each counterparty a Reown Core of its own', async () => {
  await new WcCounterparty().start();
  await new WcCounterparty().start();

  const prefixes = mockClients.map(client => String(client.options.customStoragePrefix));
  expect(new Set(prefixes).size).toBe(2);
  for (const prefix of prefixes) expect(prefix).toMatch(/^wc-counterparty-[0-9a-f-]{36}$/);
});

it("answers nothing once stopped, so a finished test's counterparty never answers the next test's app", async () => {
  const cp = new WcCounterparty();
  await cp.start();
  const [client] = mockClients;
  const handlers = [...(client?.listeners.get('session_request') ?? [])];

  await cp.stop();
  for (const handler of handlers)
    await handler(request('eip155:11155111', 'personal_sign', ['0x68656c6c6f', KEY_ADDRESS]));

  expect(client?.listeners.get('session_request')?.size ?? 0).toBe(0);
  expect(client?.listeners.get('session_proposal')?.size ?? 0).toBe(0);
  expect(client?.responses).toEqual([]);
  expect(cp.requests).toEqual([]);
});

it('approves only the session chains it was given', async () => {
  const cp = new WcCounterparty({
    privateKey: KEY,
    chainId: 84532,
    rpcUrl: 'https://l2.example',
    sessionChainIds: [84532]
  });
  await cp.start();

  await emit(mockClients[0], 'session_proposal', { id: 7, params: {} });

  expect(mockClients[0]?.approvals).toEqual([
    {
      id: 7,
      namespaces: {
        eip155: expect.objectContaining({ chains: ['eip155:84532'], accounts: [`eip155:84532:${KEY_ADDRESS}`] })
      }
    }
  ]);
});

describe('with a send hook', () => {
  const setUp = async () => {
    const send = jest.fn(async () => HASH);
    const cp = new WcCounterparty({
      privateKey: KEY,
      chainId: 84532,
      rpcUrl: 'https://l2.example',
      sessionChainIds: [84532],
      send
    });
    await cp.start();
    return { cp, send, client: mockClients[0] };
  };

  it('sends a transaction for its own chain and key and answers with the hash', async () => {
    const { cp, send, client } = await setUp();

    await emit(
      client,
      'session_request',
      request('eip155:84532', 'eth_sendTransaction', [
        { from: KEY_ADDRESS.toLowerCase(), to: BASE_USDC, data: '0x095ea7b3', value: '0x0' }
      ])
    );

    expect(send).toHaveBeenCalledWith({ to: BASE_USDC, data: '0x095ea7b3', value: 0n }, expect.any(AbortSignal));
    expect(client?.responses).toEqual([{ topic: 'topic-1', response: { id: 1, jsonrpc: '2.0', result: HASH } }]);
    expect(cp.requests).toEqual([
      expect.objectContaining({ method: 'eth_sendTransaction', chainId: 'eip155:84532', result: HASH })
    ]);
  });

  it.each([
    [
      'a transaction for another chain',
      request('eip155:5042002', 'eth_sendTransaction', [{ from: KEY_ADDRESS, to: BASE_USDC, data: '0x01' }]),
      'not eip155:84532'
    ],
    ['a message to sign', request('eip155:84532', 'personal_sign', ['0x68656c6c6f', KEY_ADDRESS]), 'signs no message']
  ])('refuses %s without sending, and says why', async (_case, event, why) => {
    const { cp, send, client } = await setUp();

    await emit(client, 'session_request', event);

    expect(send).not.toHaveBeenCalled();
    expect(client?.responses).toEqual([
      {
        topic: 'topic-1',
        response: { id: 1, jsonrpc: '2.0', error: { code: 5000, message: expect.stringContaining(why) } }
      }
    ]);
    expect(cp.requests[0]?.error).toContain(why);
  });
});
