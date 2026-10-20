import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UserRejectedRequestError } from 'viem';

import { englishWordlist } from '@miden/hd-key';

import {
  BRIDGE_RECEIVE_LIBRARY_ERRORS,
  BRIDGE_RECEIVE_ROUTES,
  BRIDGE_RECEIVE_STEPS,
  type BridgeReceiveFailure,
  bridgeReceiveLibraryError,
  walletRaised
} from './bridge-receive-failure';
import { captureCrash } from './crash';
import { containsSeedMaterial } from './redact';
import { reportTransactionFailure } from './transaction-failure';

jest.mock('./crash', () => ({ captureCrash: jest.fn() }));

const REPO_ROOT = join(__dirname, '..', '..', '..');

// What the Android Fast route stores for a deposit the wallet refused: the Epoch SDK keeps only viem's flattened text.
const REFUSED_FAST_DEPOSIT =
  'An unknown RPC error occurred.\n\nDetails: User rejected the request.\nVersion: viem@2.55.4';

const reportedMessage = (): string => {
  const [error] = jest.mocked(captureCrash).mock.calls.at(-1) ?? [];
  return error instanceof Error ? error.message : '';
};

const reportBridge = (bridgeReceive: BridgeReceiveFailure, error?: unknown): string => {
  reportTransactionFailure({ type: 'bridged-receive', point: 'bridge_receive_settlement', error, bridgeReceive });
  return reportedMessage();
};

const named = (name: string, message: string, fields: object = {}, cause?: unknown): Error =>
  Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { name }, fields);

beforeEach(() => {
  jest.clearAllMocks();
});

it('names the route, step and wallet answer of a refused Fast deposit, and none of its text', () => {
  const message = reportBridge(
    { route: 'epoch', step: 'epoch_solve', cause: REFUSED_FAST_DEPOSIT },
    REFUSED_FAST_DEPOSIT
  );

  expect(message).toContain(
    '; point bridge_receive_settlement; rpc; via epoch; failed at epoch_solve; evm error user_rejected. authentication preparation'
  );
  for (const text of ['User rejected', 'unknown RPC', 'viem', '2.55.4']) expect(message).not.toContain(text);
});

it('reads the library error from the cause the writer handed over, not the stored text', () => {
  const cause = named('HttpRequestError', 'HTTP request failed.', { status: 503 });

  expect(reportBridge({ route: 'agglayer', step: 'deposit_receipt', cause }, 'Service Unavailable')).toContain(
    '; via agglayer; failed at deposit_receipt; evm error http_503. '
  );
});

it('reports no answer for a failure the wallet raised, whose writer hands over no cause', () => {
  expect(
    reportBridge(
      { route: 'epoch', step: 'submission_interrupted' },
      'Bridge submission was interrupted before an intent was recorded.'
    )
  ).toContain('; via epoch; failed at submission_interrupted; evm error none. ');
});

it('reports no answer for a failure with no cause, even when the row stores a wallet answer', () => {
  expect(reportBridge({ route: 'epoch', step: 'epoch_solve' }, REFUSED_FAST_DEPOSIT)).toContain(
    '; via epoch; failed at epoch_solve; evm error none. '
  );
});

it('reports other for a cause that names no library error', () => {
  const cause = new Error('socket hang up');

  expect(reportBridge({ route: 'agglayer', step: 'reconciler_receipt', cause }, cause.message)).toContain(
    '; via agglayer; failed at reconciler_receipt; evm error other. '
  );
});

const OWN_WORDS = 'The Fast route has no quoted deposit.';

it('reports no answer for a cause the wallet raised itself that wraps none', () => {
  const cause = walletRaised(new Error(OWN_WORDS));

  expect(bridgeReceiveLibraryError(cause)).toBe('none');
  expect(reportBridge({ route: 'epoch', step: 'precheck_route', cause }, OWN_WORDS)).toContain(
    '; via epoch; failed at precheck_route; evm error none. '
  );
});

it('reads past a cause the wallet raised itself to the answer it wraps', () => {
  const rejection = new UserRejectedRequestError(new Error('User denied transaction signature.'));

  expect(bridgeReceiveLibraryError(walletRaised(new Error(OWN_WORDS, { cause: rejection })))).toBe('user_rejected');
});

it('reports other for the same words when the wallet did not mark them as its own', () => {
  expect(bridgeReceiveLibraryError(new Error(OWN_WORDS))).toBe('other');
});

// [identity, the failure as a writer hands it over]
const LIBRARY_CASES: ReadonlyArray<readonly [string, unknown]> = [
  ['user_rejected', REFUSED_FAST_DEPOSIT],
  ['user_rejected', 'MetaMask Tx Signature: User denied transaction signature.'],
  ['user_rejected', 'Transaction was cancelled by the user'],
  [
    'user_rejected',
    named('TransactionExecutionError', 'Transaction creation failed.', {}, { code: 4001, message: 'no' })
  ],
  ['user_rejected', named('UnknownRpcError', 'An unknown RPC error occurred.', { details: 'Rejected by user' })],
  ['session_deleted', 'WalletConnect session was deleted'],
  ['no_session', 'No WalletConnect session is connected'],
  ['request_expired', 'An unknown RPC error occurred.\n\nDetails: Request expired\nVersion: viem@2.55.4'],
  [
    'insufficient_funds',
    'The total cost (gas * gas fee + value) of executing this transaction exceeds the balance of the account.'
  ],
  ['insufficient_funds', named('InsufficientFundsError', 'The total cost of executing this transaction is too high.')],
  ['reverted', named('EvmTransactionRevertedError', 'The Sepolia transaction reverted')],
  ['reverted', 'Execution reverted for an unknown reason.'],
  [
    'timeout',
    'The request took too long to respond.\n\nURL: https://rpc.example.org\n\nDetails: The request timed out.'
  ],
  ['timeout', 'Timed out while waiting for transaction with hash "0x01" to be confirmed.'],
  ['timeout', 'Transaction simulation failed after 30000ms: Unknown error'],
  [
    'timeout',
    new Error('Could not check the USDC allowance the bridge has on Sepolia.', {
      cause: named('RpcTimeoutError', 'RPC "erc20-allowance:11155111" timed out after 5000ms')
    })
  ],
  ['http_429', 'HTTP request failed.\n\nStatus: 429\nURL: https://rpc.example.org\n\nDetails: Too Many Requests'],
  ['http_100', named('HttpRequestError', 'HTTP request failed.', { status: 100 })],
  ['http_599', named('HttpRequestError', 'HTTP request failed.', { status: 599 })],
  ['http_other', 'HTTP request failed.\n\nURL: https://rpc.example.org'],
  ['http_other', named('HttpRequestError', 'HTTP request failed.', { status: 700 })],
  ['http_other', named('HttpRequestError', 'HTTP request failed.', { status: 404.5 })],
  ['http_other', named('HttpRequestError', 'HTTP request failed.', { status: '429' })],
  ['unknown_rpc_error', 'An unknown RPC error occurred.\n\nDetails: Something went wrong.\nVersion: viem@2.55.4'],
  ['unknown_rpc_error', named('UnknownRpcError', 'An unknown error occurred.')],
  // The App's own words name no library error, its own timeout included.
  ['other', 'Bridge delivery timed out.'],
  ['other', 'Circle attested this deposit to a different amount.'],
  ['other', {}],
  ['none', undefined],
  ['none', '']
];

it.each(LIBRARY_CASES)('names the library error %s', (identity, error) => {
  expect(bridgeReceiveLibraryError(error)).toBe(identity);
});

it('drives every library error it can name', () => {
  const driven = new Set(LIBRARY_CASES.map(([identity]) => (identity.startsWith('http_') ? 'http_' : identity)));
  expect(BRIDGE_RECEIVE_LIBRARY_ERRORS.filter(identity => !driven.has(identity))).toEqual([]);
});

it('keeps the links it read before a cause accessor that throws', () => {
  const hostile = Object.defineProperty(new Error('User rejected the request.'), 'cause', {
    get: () => {
      throw new Error('hostile accessor');
    }
  });

  expect(bridgeReceiveLibraryError(hostile)).toBe('user_rejected');
  expect(reportBridge({ route: 'epoch', step: 'epoch_execute', cause: hostile })).toContain(
    '; evm error user_rejected. '
  );
});

it('stops at a cause chain that loops', () => {
  const looped = new Error('first');
  Object.assign(looped, { cause: looped });

  expect(bridgeReceiveLibraryError(looped)).toBe('other');
});

// The crash reporter discards a report holding four recovery-phrase wordlist words in a row, and `other`, `route`,
// `step`, `library`, `session` and `network` are all wordlist words.
it('never builds a report the recovery-phrase filter would discard, for any route, step and library error', () => {
  const causes = new Map<string, unknown>(LIBRARY_CASES);
  const discarded: string[] = [];
  for (const route of [...BRIDGE_RECEIVE_ROUTES, 'other'])
    for (const step of [...BRIDGE_RECEIVE_STEPS, undefined])
      for (const [identity, cause] of causes)
        for (const stored of ['network down', 'unknown']) {
          const message = reportBridge({ route, step, cause }, stored);
          if (containsSeedMaterial(message, englishWordlist)) discarded.push(`${route} ${step} ${identity}`);
        }
  expect(discarded).toEqual([]);
});

it.each([...BRIDGE_RECEIVE_ROUTES])('names the route %s', route => {
  expect(reportBridge({ route })).toContain(`; via ${route}; failed at other; evm error none. `);
});

it.each([...BRIDGE_RECEIVE_STEPS])('names the step %s', step => {
  expect(reportBridge({ route: 'usdcx', step })).toContain(`; via usdcx; failed at ${step}; evm error none. `);
});

it('sends a route or step outside its list, or none, as other', () => {
  const poison = 'mtst1aqsjql4cyylvpu2d2cwpxumpvvw5depe';

  expect(reportBridge({ route: poison, step: poison as never })).toContain(
    '; via other; failed at other; evm error none. '
  );
  expect(reportedMessage()).not.toContain(poison);
  expect(reportBridge({})).toContain('; via other; failed at other; evm error none. ');
});

it('sends none of the stored text, the cause, the endpoint, an address, a hash or an amount', () => {
  const address = `0x${'a1'.repeat(20)}`;
  const hash = `0x${'b2'.repeat(32)}`;
  const stored = [
    'An unknown RPC error occurred.',
    '',
    'URL: https://rpc.walletconnect.org/v1/?chainId=eip155:11155111&projectId=0123456789abcdef',
    'Request Arguments:',
    `  from:   ${address}`,
    '  value:  1234.5678 USDC',
    `  hash:   ${hash}`,
    '',
    'Details: User rejected the request.',
    'Version: viem@2.55.4'
  ].join('\n');

  const message = reportBridge({ route: 'epoch', step: 'epoch_solve', cause: new Error(stored) }, stored);

  expect(message).toContain('; via epoch; failed at epoch_solve; evm error user_rejected. ');
  for (const text of [
    'walletconnect',
    'eip155',
    '0123456789abcdef',
    'a1a1',
    'b2b2',
    '1234.5678',
    'Request Arguments'
  ]) {
    expect(message).not.toContain(text);
  }
});

it('adds nothing to a report that names no inbound bridge', () => {
  reportTransactionFailure({ type: 'send', error: REFUSED_FAST_DEPOSIT });
  expect(reportedMessage()).not.toMatch(/route|library/);
});

/** The clause of the policy's inbound-bridge bullet that runs from `from` up to `to`, or to its end. */
const bridgePolicyClause = (from: string, to?: string): string => {
  const policy = readFileSync(join(REPO_ROOT, 'docs/privacy-policy/index.md'), 'utf8');
  const section = policy.slice(policy.indexOf('### Crash reports'));
  const bullet =
    section
      .slice(0, section.indexOf('\n#', 1))
      .split('\n')
      .find(line => line.startsWith('- **An inbound bridge that failed**')) ?? '';
  const start = bullet.indexOf(from);
  const end = to === undefined ? bullet.length : bullet.indexOf(to, start);
  return start === -1 || end === -1 ? '' : bullet.slice(start, end);
};

const listedIn = (clause: string): string[] => [...clause.matchAll(/`([^`]+)`/g)].map(match => match[1]!).sort();

it.each([
  ['route', () => [...BRIDGE_RECEIVE_ROUTES, 'other'], () => bridgePolicyClause('the route', '; the step')],
  [
    'step',
    () => [...BRIDGE_RECEIVE_STEPS, 'other'],
    () => bridgePolicyClause('; the step', '; and what the other network')
  ],
  [
    'library error',
    () => [...BRIDGE_RECEIVE_LIBRARY_ERRORS, 'http_other', 'other', 'none'],
    () => bridgePolicyClause('; and what the other network')
  ]
])(
  'the privacy policy lists every reportable inbound-bridge %s in its own clause, and nothing else',
  (_name, values, clause) => {
    expect(clause()).not.toBe('');
    expect(listedIn(clause())).toEqual([...values()].sort());
  }
);

it('the privacy policy states the HTTP status range of a library error and its fallback', () => {
  const clause = bridgePolicyClause('`http_`', '`unknown_rpc_error`');
  expect(clause).toMatch(/\b100\b[^.]*\b599\b/);
  expect(clause).toContain('`http_other`');
});
