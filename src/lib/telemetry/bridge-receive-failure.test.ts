import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UserRejectedRequestError } from 'viem';

import { englishWordlist } from '@miden/hd-key';
import { markReownNativeFailure, type ReownNativeFailure } from 'lib/walletconnect/native-request-failure';

import {
  BRIDGE_BALANCE_CHECKS,
  BRIDGE_ORPHAN_CHECKS,
  BRIDGE_SOURCE_ROUTES,
  BRIDGE_RECEIVE_LIBRARY_ERRORS,
  BRIDGE_RECEIVE_ROUTES,
  BRIDGE_RECEIVE_STEPS,
  type BridgeReceiveFailure,
  bridgeReceiveLibraryError,
  bridgeReceiveNativeFailure,
  markNativeSessionPrecheck,
  NATIVE_SESSION_PRECHECK_FAILURES,
  NATIVE_SESSION_PRECHECK_RECOVERIES,
  readNativeSessionPrecheck,
  REOWN_NATIVE_ORIGINS,
  REOWN_WALLET_RESPONSE_CODES,
  REOWN_REQUEST_AGES,
  REOWN_PUBLICATIONS,
  REOWN_BACKGROUND_ANSWERS,
  walletRaised
} from './bridge-receive-failure';
import { resolveTelemetryContext } from './context';
import { captureCrash } from './crash';
import { snapshotCrashDiagnostics } from './crash-diagnostics';
import { containsSeedMaterial } from './redact';
import { reportTransactionFailure } from './transaction-failure';

jest.mock('./crash', () => ({ captureCrash: jest.fn() }));
jest.mock('./context', () => ({ resolveTelemetryContext: jest.fn() }));

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
  jest
    .mocked(resolveTelemetryContext)
    .mockReturnValue({ platform: 'android', network: 'testnet', appVersion: '1.17.6' });
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

it('keeps the wallet request client within its closed values', () => {
  expect(reportBridge({ route: 'agglayer', step: 'wallet_deposit', requestClient: 'unlisted' } as never)).toContain(
    'wallet request client other'
  );
});

it('omits the wallet request client outside an approve or deposit request', () => {
  expect(reportBridge({ route: 'agglayer', step: 'deposit_receipt', requestClient: 'wagmi' })).not.toContain(
    'wallet request client'
  );
});

it('reports the Fast solve request client', () => {
  const native = reportBridge({
    route: 'epoch',
    step: 'epoch_solve',
    requestClient: 'native_reown',
    cause: REFUSED_FAST_DEPOSIT
  });
  const wagmi = reportBridge({
    route: 'epoch',
    step: 'epoch_solve',
    requestClient: 'wagmi',
    cause: REFUSED_FAST_DEPOSIT
  });
  const unlisted = reportBridge({
    route: 'epoch',
    step: 'epoch_solve',
    requestClient: 'unlisted',
    cause: REFUSED_FAST_DEPOSIT
  } as never);
  const unset = reportBridge({ route: 'epoch', step: 'epoch_solve', cause: REFUSED_FAST_DEPOSIT });

  expect(native).toContain('failed at epoch_solve; wallet request client native_reown; evm error user_rejected');
  expect(native).toContain('wallet request client native_reown');
  expect(wagmi).toContain('wallet request client wagmi');
  expect(unlisted).toContain('wallet request client other');
  expect(unset).not.toContain('wallet request client');
  for (const message of [native, wagmi, unlisted, unset])
    expect(containsSeedMaterial(message, englishWordlist)).toBe(false);
});

it('names epoch_solve in the Fast solve request client policy line', () => {
  const policyLine = readFileSync(join(REPO_ROOT, 'docs/privacy/index.md'), 'utf8')
    .split('\n')
    .find(line => line.includes('Only inbound bridge failures') && line.includes('wallet request client'));

  expect(policyLine).toContain('`epoch_solve` carry wallet request client');
  expect(policyLine).toContain('wallet request client (`native_reown`, `wagmi`)');
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

it('does not classify a ninth original answer through a wallet-raised wrapper', () => {
  let cause: unknown = { code: 4001 };
  for (let index = 0; index < 8; index++) cause = new Error('opaque cause', { cause });

  expect(bridgeReceiveLibraryError(walletRaised(new Error(OWN_WORDS, { cause })))).toBe('other');
});

it('stops at a cause cycle made only of wallet-raised wrappers', () => {
  const error = walletRaised(new Error(OWN_WORDS));
  Object.assign(error, { cause: error });

  expect(bridgeReceiveLibraryError(error)).toBe('none');
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
  ['receipt_timeout', named('WaitForTransactionReceiptTimeoutError', 'Timed out while waiting for transaction.')],
  ['chain_mismatch', named('ChainMismatchError', 'The current chain of the wallet does not match.')],
  ['chain_unconfigured', named('ChainNotFoundError', 'No chain was provided to the request.')],
  ['chain_unconfigured', named('ClientChainNotConfiguredError', 'No chain was provided to the Client.')],
  ['chain_unconfigured', named('InvalidChainIdError', 'Chain ID is invalid.')],
  ['provider_unauthorized', named('UnauthorizedProviderError', 'Not authorized.')],
  ['provider_unauthorized', { code: 4100, message: 'The requested method has not been authorized.' }],
  ['method_unsupported', named('UnsupportedProviderMethodError', 'Unsupported method.')],
  ['method_unsupported', named('MethodNotFoundRpcError', 'Method not found.')],
  ['method_unsupported', named('MethodNotSupportedRpcError', 'Method not supported.')],
  ['method_unsupported', { code: 4200, message: 'x' }],
  ['method_unsupported', { code: -32601, message: 'x' }],
  ['method_unsupported', { code: -32004, message: 'x' }],
  ['provider_disconnected', named('ProviderDisconnectedError', 'Disconnected.')],
  ['provider_disconnected', { code: 4900, message: 'x' }],
  ['chain_disconnected', named('ChainDisconnectedError', 'Chain disconnected.')],
  ['chain_disconnected', { code: 4901, message: 'x' }],
  ['chain_switch_failed', named('SwitchChainError', 'Switch chain failed.')],
  ['chain_switch_failed', { code: 4902, message: 'Unrecognized chain ID "0xaa36a7".' }],
  ['request_invalid', named('ParseRpcError', 'Invalid JSON.')],
  ['request_invalid', named('InvalidRequestRpcError', 'Invalid request.')],
  ['request_invalid', named('InvalidParamsRpcError', 'Invalid parameters.')],
  ['request_invalid', named('InvalidInputRpcError', 'Missing or invalid parameters.')],
  ['request_invalid', { code: -32700, message: 'x' }],
  ['request_invalid', { code: -32600, message: 'x' }],
  ['request_invalid', { code: -32602, message: 'x' }],
  // Nodes answer every server fault with -32000 (nonce too low, header not found); only viem's class names input.
  ['other', { code: -32000, message: 'nonce too low' }],
  ['rpc_internal', named('InternalRpcError', 'Internal error.')],
  ['rpc_internal', { code: -32603, message: 'x' }],
  ['rpc_unavailable', named('ResourceNotFoundRpcError', 'Resource not found.')],
  ['rpc_unavailable', named('ResourceUnavailableRpcError', 'Resource unavailable.')],
  ['rpc_unavailable', { code: -32001, message: 'x' }],
  ['rpc_unavailable', { code: -32002, message: 'x' }],
  ['transaction_rejected', named('TransactionRejectedRpcError', 'Transaction rejected.')],
  ['transaction_rejected', { code: -32003, message: 'x' }],
  ['rpc_limited', named('LimitExceededRpcError', 'Limit exceeded.')],
  ['rpc_limited', { code: -32005, message: 'x' }],
  ['invalid_permissions', new Error('Invalid permissions for call.')],
  ['other', new Error('prefix Invalid permissions for call.')],
  ['other', new Error('invalid permissions for call.')],
  ['other', new Error('Invalid permissions for call')],
  // Codes are matched exactly: a string, an unlisted number or a lookalike name names nothing new.
  ['other', { code: '4100', message: 'x' }],
  ['other', { code: 4999, message: 'x' }],
  ['other', named('ChainMismatchErrorX', 'x')],
  // A generic timeout stays a timeout; only the named receipt wait is a receipt timeout.
  ['timeout', named('TimeoutError', 'The request took too long to respond.')],
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

it('never builds a report the recovery-phrase filter would discard for any session precheck pair', () => {
  const discarded: string[] = [];
  for (const failure of NATIVE_SESSION_PRECHECK_FAILURES)
    for (const recovery of NATIVE_SESSION_PRECHECK_RECOVERIES)
      for (const raised of [false, true])
        for (const stored of ['network down', 'unknown']) {
          const cause = raised ? walletRaised(new Error('socket hang up')) : new Error('socket hang up');
          markNativeSessionPrecheck(cause, { failure, recovery });
          const message = reportBridge({ route: 'usdcx', step: 'precheck_session_chain', cause }, stored);
          if (
            containsSeedMaterial(message, englishWordlist) ||
            !message.includes(`precheck ${failure}; attempt ${recovery}`)
          )
            discarded.push(`${failure} ${recovery} ${raised} ${stored}`);
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

  const cause = new Error(stored);
  markReownNativeFailure(cause, nativeSnapshot);
  const message = reportBridge({ route: 'epoch', step: 'epoch_solve', cause }, stored);

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
  const policy = readFileSync(join(REPO_ROOT, 'docs/privacy/index.md'), 'utf8');
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
    () => bridgePolicyClause('; and what the other network', '; native origin')
  ],
  ['native origin', () => REOWN_NATIVE_ORIGINS, () => bridgePolicyClause('; native origin', '; wallet response code')],
  [
    'wallet response code',
    () => REOWN_WALLET_RESPONSE_CODES,
    () => bridgePolicyClause('; wallet response code', '; request age')
  ],
  ['request age', () => REOWN_REQUEST_AGES, () => bridgePolicyClause('; request age', '; publication observation')],
  [
    'publication observation',
    () => REOWN_PUBLICATIONS,
    () => bridgePolicyClause('; publication observation', '; background observation')
  ],
  [
    'background observation',
    () => REOWN_BACKGROUND_ANSWERS,
    () => bridgePolicyClause('; background observation', '; balance check')
  ],
  ['balance check', () => BRIDGE_BALANCE_CHECKS, () => bridgePolicyClause('; balance check', '; orphan check')],
  ['orphan check', () => BRIDGE_ORPHAN_CHECKS, () => bridgePolicyClause('; orphan check', '; USDCx source route')],
  [
    'USDCx source route',
    () => BRIDGE_SOURCE_ROUTES,
    () => bridgePolicyClause('; USDCx source route', 'When a native session precheck')
  ]
])(
  'the privacy policy lists every reportable inbound-bridge %s in its own clause, and nothing else',
  (_name, values, clause) => {
    expect(clause()).not.toBe('');
    expect(listedIn(clause())).toEqual([...values()].sort());
  }
);

it('the privacy policy lists every native session precheck failure and add-and-switch attempt', () => {
  const failures = bridgePolicyClause('that failed condition', '; and what the add-and-switch attempt');
  const attempts = bridgePolicyClause('; and what the add-and-switch attempt', '. The answer');

  expect(failures).not.toBe('');
  expect(attempts).not.toBe('');
  expect(listedIn(failures)).toEqual([...NATIVE_SESSION_PRECHECK_FAILURES, 'other'].sort());
  expect(listedIn(attempts)).toEqual([...NATIVE_SESSION_PRECHECK_RECOVERIES, 'other'].sort());
  expect(listedIn(failures.replace('`state_unread`', ''))).not.toEqual(
    [...NATIVE_SESSION_PRECHECK_FAILURES, 'other'].sort()
  );
  expect(listedIn(`${attempts} \`eip155:1\``)).not.toEqual([...NATIVE_SESSION_PRECHECK_RECOVERIES, 'other'].sort());
});

it('policyClauseRejectsMissingOrExtraSentinels', () => {
  const clause = bridgePolicyClause('; request age', '; publication observation');
  expect(listedIn(clause)).toEqual([...REOWN_REQUEST_AGES].sort());
  expect(listedIn(clause.replace('`unknown`', ''))).not.toEqual([...REOWN_REQUEST_AGES].sort());
  expect(listedIn(clause + ' `unavailable`')).not.toEqual([...REOWN_REQUEST_AGES].sort());
});

it('the privacy policy states the HTTP status range of a library error and its fallback', () => {
  const clause = bridgePolicyClause('`http_`', '`unknown_rpc_error`');
  expect(clause).toMatch(/\b100\b[^.]*\b599\b/);
  expect(clause).toContain('`http_other`');
});

const nativeSnapshot: ReownNativeFailure = {
  nativeOrigin: 'wallet_error',
  walletResponseCode: 'internal_error',
  requestAge: '120_to_300s',
  published: 'confirmed',
  backgrounded: 'yes'
};

it('reports the marked Android bridge cause as closed diagnostics on a cause-free Error', () => {
  const cause = new Error('Invalid permissions for call.');
  markReownNativeFailure(cause, nativeSnapshot);
  reportBridge({ route: 'usdcx', step: 'wallet_approve', cause });
  const report = jest.mocked(captureCrash).mock.calls.at(-1)?.[0];
  expect(report).toBeInstanceOf(Error);
  if (!(report instanceof Error)) throw new Error('Missing report');
  expect(report.message).toContain('evm error invalid_permissions');
  expect(snapshotCrashDiagnostics(report)).toEqual({
    reownNativeOrigin: 'wallet_error',
    reownWalletResponseCode: 'internal_error',
    reownRequestAge: '120_to_300s',
    reownPublished: 'confirmed',
    reownBackgrounded: 'yes'
  });
  expect(report.cause).toBeUndefined();
  expect(report.stack).toBeUndefined();
});

it('reports the balance check, orphan check and USDCx source route as closed diagnostics', () => {
  reportBridge({
    route: 'usdcx',
    step: 'precheck_balance',
    cause: new Error('Balance read failed for 0x9a2f6A2C2b5E7D2bC1a0F4b47cCF4d5F1A0dE9b3 holding 12.5 USDC'),
    balanceCheck: 'read_failed',
    orphanCheck: 'origin_lock',
    sourceRoute: 'cctp_executor'
  });
  const report = jest.mocked(captureCrash).mock.calls.at(-1)?.[0];
  if (!(report instanceof Error)) throw new Error('Missing report');
  expect(snapshotCrashDiagnostics(report)).toEqual({
    bridgeBalanceCheck: 'read_failed',
    bridgeOrphanCheck: 'origin_lock',
    bridgeSourceRoute: 'cctp_executor'
  });
  const sent = JSON.stringify([report.message, snapshotCrashDiagnostics(report)]);
  for (const fragment of ['0x9a2f', '12.5', 'USDC holding', 'Balance read failed'])
    expect(sent).not.toContain(fragment);
});

it('drops an unlisted balance check, orphan check or source route', () => {
  // A stored or forged source can carry any value; JSON keeps the test from naming a type that forbids it.
  reportBridge(
    JSON.parse(
      '{"route":"usdcx","step":"precheck_balance","balanceCheck":"shortfall_of_12","orphanCheck":"lock","sourceRoute":"0xdeadbeef"}'
    )
  );
  const report = jest.mocked(captureCrash).mock.calls.at(-1)?.[0];
  if (!(report instanceof Error)) throw new Error('Missing report');
  expect(snapshotCrashDiagnostics(report)).toEqual({});
});

it('permissionClassPreservesExistingPrecedence', () => {
  const refusal = 'Invalid permissions for call.';
  for (const field of ['details', 'shortMessage']) {
    expect(bridgeReceiveLibraryError(named('Error', '', { [field]: refusal }))).toBe('invalid_permissions');
  }
  expect(bridgeReceiveLibraryError(new Error(`first line\n${refusal}\nlast line`))).toBe('invalid_permissions');
  expect(
    bridgeReceiveLibraryError(named('UnknownRpcError', 'An unknown RPC error occurred.', {}, new Error(refusal)))
  ).toBe('invalid_permissions');
  for (const [identity, cause] of LIBRARY_CASES.filter(
    ([identity]) => !['other', 'none', 'unknown_rpc_error', 'invalid_permissions'].includes(identity)
  )) {
    expect(bridgeReceiveLibraryError(new Error(refusal, { cause }))).toBe(identity);
  }
  expect(bridgeReceiveLibraryError(walletRaised(named('NativeSessionChainNotApprovedError', refusal)))).toBe('none');
});

it('readsOneNearestMarkedSnapshotWithoutMixingRequests', () => {
  const innerSnapshot: ReownNativeFailure = {
    nativeOrigin: 'publish_error',
    requestAge: 'under_30s',
    published: 'unobserved'
  };
  const nearSnapshot = nativeSnapshot;
  const inner = new Error('inner');
  markReownNativeFailure(inner, innerSnapshot);
  const near = walletRaised(new Error('near', { cause: inner }));
  markReownNativeFailure(near, nearSnapshot);
  expect(bridgeReceiveNativeFailure(near)).toEqual(nearSnapshot);
  expect(bridgeReceiveNativeFailure(near)).not.toBe(nearSnapshot);
  expect(bridgeReceiveNativeFailure({ published: 'confirmed', cause: inner })).toEqual(innerSnapshot);
});

it('boundsMetadataTraversalAndSurvivesHostileAccessors', () => {
  const innerSnapshot = nativeSnapshot;
  const inner = new Error('inner');
  markReownNativeFailure(inner, innerSnapshot);
  let eighthLinkMarked: Error = inner;
  for (let index = 0; index < 7; index++)
    eighthLinkMarked = walletRaised(new Error('wrapper', { cause: eighthLinkMarked }));
  const ninthLinkMarked = new Error('wrapper', { cause: eighthLinkMarked });
  expect(bridgeReceiveNativeFailure(eighthLinkMarked)).toEqual(innerSnapshot);
  expect(bridgeReceiveNativeFailure(ninthLinkMarked)).toBeUndefined();
  const cycle = new Error('cycle');
  Object.assign(cycle, { cause: cycle });
  expect(bridgeReceiveNativeFailure(cycle)).toBeUndefined();
  const throwingCause = Object.defineProperty(new Error('hostile'), 'cause', {
    get() {
      throw new Error('hostile');
    }
  });
  expect(() => bridgeReceiveNativeFailure(throwingCause)).not.toThrow();
  const hostileMark = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw new Error('hostile mark');
      }
    }
  );
  expect(() => bridgeReceiveNativeFailure(hostileMark)).not.toThrow();
  for (const forged of [
    'Request expired',
    { ...nativeSnapshot, reownNativeFailure: nativeSnapshot },
    { message: JSON.stringify(nativeSnapshot), code: `REOWN_NATIVE_REQUEST_FAILURE:${JSON.stringify(nativeSnapshot)}` }
  ])
    expect(bridgeReceiveNativeFailure(forged)).toBeUndefined();
});

it('keepsNativeOriginIndependentOfEvmClass', () => {
  const walletExpired = new Error('Request expired');
  markReownNativeFailure(walletExpired, nativeSnapshot);
  const sdkExpired = new Error('Request expired');
  markReownNativeFailure(sdkExpired, {
    nativeOrigin: 'request_expired',
    requestAge: 'over_300s',
    published: 'confirmed'
  });
  expect(bridgeReceiveLibraryError(walletExpired)).toBe('request_expired');
  expect(bridgeReceiveNativeFailure(walletExpired)?.nativeOrigin).toBe('wallet_error');
  expect(bridgeReceiveNativeFailure(sdkExpired)?.nativeOrigin).toBe('request_expired');
  const opaque = new Error('unrecognized wallet wording');
  markReownNativeFailure(opaque, { ...nativeSnapshot, walletResponseCode: 'user_rejected' });
  expect(bridgeReceiveLibraryError(opaque)).toBe('other');
  expect(opaque).not.toHaveProperty('code');
});

it('reports a native session precheck from the cause and leaves ids, hex and amounts out of the display string', () => {
  const chainId = 5042002;
  const address = `0x${'ab'.repeat(20)}`;
  const hash = `0x${'cd'.repeat(32)}`;
  const cause = walletRaised(
    new Error(`The connected WalletConnect session did not approve Arc Testnet (eip155:${chainId}).`)
  );
  Object.assign(cause, {
    chainId,
    networkName: 'Arc Testnet',
    topic: 'topic-secret',
    failure: address,
    recovery: '1.25'
  });
  expect(markNativeSessionPrecheck(cause, { failure: 'eip155:1', recovery: 'rejected' } as never)).toBe(false);
  expect(readNativeSessionPrecheck(cause)).toBeUndefined();
  expect(markNativeSessionPrecheck(cause, { failure: 'chain_unapproved', recovery: 'rejected' })).toBe(true);
  expect(markNativeSessionPrecheck(cause, { failure: 'state_unread', recovery: 'not_attempted' })).toBe(false);
  expect(readNativeSessionPrecheck(cause)).toEqual({ failure: 'chain_unapproved', recovery: 'rejected' });
  markReownNativeFailure(cause, nativeSnapshot);

  const message = reportBridge(
    { route: 'usdcx', step: 'precheck_session_chain', cause },
    `Reconnect Arc Testnet eip155:${chainId} amount 9.99 ${hash} https://secret.example topic-secret`
  );

  expect(message).toContain(
    '; via usdcx; failed at precheck_session_chain; precheck chain_unapproved; attempt rejected; evm error none. '
  );
  for (const secret of [
    String(chainId),
    'Arc Testnet',
    'eip155',
    'WalletConnect',
    '1.25',
    '9.99',
    '0x',
    'abab',
    'cdcd',
    'https://',
    'topic-secret',
    address
  ]) {
    expect(message).not.toContain(secret);
  }
  expect(containsSeedMaterial(message, englishWordlist)).toBe(false);
  const report = jest.mocked(captureCrash).mock.calls.at(-1)?.[0];
  expect(snapshotCrashDiagnostics(report)).toEqual({
    reownNativeOrigin: 'wallet_error',
    reownWalletResponseCode: 'internal_error',
    reownRequestAge: '120_to_300s',
    reownPublished: 'confirmed',
    reownBackgrounded: 'yes'
  });
});
