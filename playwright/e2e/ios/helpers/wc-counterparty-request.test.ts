/**
 * @jest-environment node
 */
import { privateKeyToAccount } from 'viem/accounts';

import { parseSendRequest, sessionNamespaces } from './wc-counterparty-request';

const { address: KEY_ADDRESS } = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
);
const BASE_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const EXPECTED = { chainId: 84532, from: KEY_ADDRESS };
const send = (chainId: string | undefined, tx: Record<string, unknown>) => ({ chainId, params: [tx] });

describe('parseSendRequest', () => {
  it('takes a transaction for its chain from its key, in any address case, with the value as a bigint', () => {
    expect(
      parseSendRequest(
        send('eip155:84532', { from: KEY_ADDRESS.toLowerCase(), to: BASE_USDC, data: '0x095ea7b3', value: '0x0' }),
        EXPECTED
      )
    ).toEqual({ to: BASE_USDC, data: '0x095ea7b3', value: 0n });
  });

  it('reads a missing value as zero', () => {
    expect(
      parseSendRequest(send('eip155:84532', { from: KEY_ADDRESS, to: BASE_USDC, data: '0x01' }), EXPECTED)
    ).toEqual({ to: BASE_USDC, data: '0x01', value: 0n });
  });

  it.each([
    ['another chain', send('eip155:5042002', { from: KEY_ADDRESS, to: BASE_USDC, data: '0x01' }), 'eip155:5042002'],
    ['no chain', send(undefined, { from: KEY_ADDRESS, to: BASE_USDC, data: '0x01' }), 'no chain'],
    [
      'another sender',
      send('eip155:84532', { from: '0x000000000000000000000000000000000000dEaD', to: BASE_USDC, data: '0x01' }),
      'from 0x000000000000000000000000000000000000dEaD'
    ],
    ['no target', send('eip155:84532', { from: KEY_ADDRESS, data: '0x01' }), 'to undefined'],
    ['no calldata', send('eip155:84532', { from: KEY_ADDRESS, to: BASE_USDC, data: '0x' }), 'without calldata'],
    [
      'a value that is not hex',
      send('eip155:84532', { from: KEY_ADDRESS, to: BASE_USDC, data: '0x01', value: 5 }),
      'value 5'
    ]
  ])('refuses %s, naming it', (_case, request, named) => {
    expect(() => parseSendRequest(request, EXPECTED)).toThrow(named);
    expect(() => parseSendRequest(request, EXPECTED)).toThrow(/refused$/);
  });
});

describe('sessionNamespaces', () => {
  it('approves exactly the chains given, for the key', () => {
    expect(sessionNamespaces([84532], KEY_ADDRESS)).toEqual({
      eip155: {
        chains: ['eip155:84532'],
        methods: ['eth_sendTransaction', 'personal_sign', 'eth_sign', 'eth_signTypedData', 'eth_signTypedData_v4'],
        events: ['chainChanged', 'accountsChanged'],
        accounts: [`eip155:84532:${KEY_ADDRESS}`]
      }
    });
  });
});
