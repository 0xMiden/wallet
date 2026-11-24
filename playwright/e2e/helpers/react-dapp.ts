import type { BrowserContext } from '@playwright/test';

import { CellDeadlineExceeded, HarnessFault, InfrastructureFault, type CellContext, type Deadline } from './dapp-cells';
import { canonicalAddress, latestSnapshot, reactAtRest } from './dapp-gates';
import {
  answerIfPrompted,
  currentAccount,
  dappSessionsFor,
  DAPP_SERVE_MODE,
  evaluateCommand,
  revokeDappSession,
  unwrap,
  waitReady,
  type DappHandle
} from './test-dapp';
import {
  createReactDappServer,
  installTestDapp,
  REACT_DAPP_ORIGIN,
  REACT_DAPP_PORT,
  serveTestDappOnLoopback,
  type DappServer
} from './test-dapp-server';
import type { GuardianAwareWalletPage } from '../fixtures/two-wallets';
import type {
  ReactCommandName,
  ReactInput,
  ReactOutput,
  ReactPageView,
  ReactSnapshot,
  ReactTree
} from '../test-dapp/react-protocol';

/**
 * The driver for the React page (spec section 4): opens it beside a wallet on its own origin, calls its
 * `window.testDapp` through the plain page's channel, and brings it to the state each React cell starts from. The
 * prompts, deadlines and refusal checks are test-dapp.ts's own, given this page's handle.
 */

/** What the page reads from its URL: the run's network and node, and whether WalletProvider auto-connects. */
export interface ReactDappQuery {
  network: string;
  rpcUrl: string;
  feeFaucetId: string;
  autoConnect: boolean;
}

let reactServer: DappServer | undefined;
const reactRouted = new WeakSet<BrowserContext>();
let reactLoopback: Promise<() => Promise<void>> | undefined;

async function ensureReactServed(context: BrowserContext): Promise<void> {
  reactServer ??= createReactDappServer();
  if (DAPP_SERVE_MODE === 'loopback') {
    reactLoopback ??= serveTestDappOnLoopback(reactServer, REACT_DAPP_PORT);
    await reactLoopback;
    return;
  }
  if (reactRouted.has(context)) return;
  await installTestDapp(context, reactServer, [REACT_DAPP_ORIGIN]);
  reactRouted.add(context);
}

const urlOf = (query: ReactDappQuery): string =>
  `${REACT_DAPP_ORIGIN}/?${new URLSearchParams({
    network: query.network,
    rpcUrl: query.rpcUrl,
    feeFaucetId: query.feeFaucetId,
    autoConnect: query.autoConnect ? '1' : '0'
  }).toString()}`;

/** One command, raced against the cell's deadline; the page's own and the node's throws map as on the plain page. */
export function callReact<K extends ReactCommandName>(
  react: DappHandle,
  command: K,
  input: ReactInput<K>,
  deadline: Deadline
): Promise<ReactOutput<K>> {
  // The page answers the command it is given, so the pair is pinned here (evaluateCommand is untyped, TS2589).
  return deadline.race(evaluateCommand(react, command, input) as Promise<ReactOutput<K>>, `React dApp ${command}`);
}

/**
 * Loads the page with `query`, keeping its localStorage. A page that never publishes `testDapp` (a module graph that
 * did not link, a shim gap) is the harness's failure, never the wallet's, and names the page errors it saw. A failure
 * the cell runner judges by its class, the cell's budget running out among them, passes through as the plain page's
 * `reloadDapp` lets it.
 */
export async function loadReact(react: DappHandle, query: ReactDappQuery, deadline: Deadline): Promise<void> {
  const errors: string[] = [];
  const onError = (error: Error): void => void errors.push(`${error.name}: ${error.message}`);
  react.page.on('pageerror', onError);
  try {
    await deadline.race(react.page.goto(urlOf(query), { waitUntil: 'domcontentloaded' }), 'React dApp load');
    await deadline.race(waitReady(react.page, deadline.remainingMs()), 'React dApp ready');
  } catch (error) {
    if (
      error instanceof CellDeadlineExceeded ||
      error instanceof HarnessFault ||
      error instanceof InfrastructureFault
    ) {
      throw error;
    }
    const why = error instanceof Error ? error.message : String(error);
    throw new HarnessFault(
      `the React dApp did not start: ${why}${errors.length > 0 ? `; page errors: ${errors.join(' | ')}` : ''}`
    );
  } finally {
    react.page.off('pageerror', onError);
  }
}

/** Opens the React page in a wallet's browser context. */
export async function openReactDapp(
  context: BrowserContext,
  query: ReactDappQuery,
  deadline: Deadline
): Promise<DappHandle> {
  await ensureReactServed(context);
  const react: DappHandle = { page: await context.newPage(), label: 'react', origin: REACT_DAPP_ORIGIN, context };
  await loadReact(react, query, deadline);
  return react;
}

// A probe that throws pushes a page error and no snapshot (commitProbe in test-dapp/react-dapp.ts): the harness's
// fault. Any other page error was thrown by the providers under test, so it fails the cell like any wrong answer.
function pageErrorFailure(view: ReactPageView): Error {
  const text = `the React dApp threw while the driver waited: ${view.pageErrors.join(' | ')}`;
  return view.pageErrors.some(error => error.startsWith('probe ')) ? new HarnessFault(text) : new Error(text);
}

/**
 * The page's view once `done` holds, or the last one read after `ms`; the caller asserts on it. A page error ends the
 * wait at once, since the commit it waits for may never come.
 */
export async function waitForReact(
  react: DappHandle,
  done: (view: ReactPageView) => boolean,
  ms: number,
  ctx: CellContext
): Promise<ReactPageView> {
  const until = Date.now() + ms;
  let view = await callReact(react, 'view', {}, ctx.deadline);
  while (!done(view)) {
    if (view.pageErrors.length > 0) throw pageErrorFailure(view);
    if (Date.now() >= until) break;
    await react.page.waitForTimeout(250);
    view = await callReact(react, 'view', {}, ctx.deadline);
  }
  return view;
}

/**
 * Where every React cell starts: no stored selection before the load (MidenFi then selects its one wallet itself),
 * fresh adapters from a fresh load, WalletProvider not auto-connecting, and the page at rest (`reactAtRest`). `none`
 * first removes the current account's wallet session for the page's origin, so the next connect prompts.
 */
export async function resetReact(
  wallet: GuardianAwareWalletPage,
  react: DappHandle,
  query: ReactDappQuery,
  session: 'keep' | 'none',
  ctx: CellContext
): Promise<ReactPageView> {
  if (session === 'none') {
    await revokeDappSession(wallet, react.origin);
    const current = await currentAccount(wallet.page);
    const left = (await dappSessionsFor(wallet, react.origin)).filter(
      id => current !== null && canonicalAddress(id) === canonicalAddress(current)
    );
    if (left.length > 0) throw new HarnessFault(`the wallet kept its session for ${react.origin}: ${left.join(', ')}`);
  }
  await ctx.deadline.race(
    react.page.evaluate(() => localStorage.clear()),
    'React dApp storage cleared'
  );
  await loadReact(react, { ...query, autoConnect: false }, ctx.deadline);
  // MidenFi selects its one wallet in an effect after mount, so a view read before that commit is at rest with no
  // MidenFi selection: wait for it too, bounded, and let MF1 assert whatever the page then shows.
  const view = await waitForReact(
    react,
    candidate =>
      reactAtRest(candidate).length === 0 && latestSnapshot(candidate, 'midenfi')?.selected === candidate.adapterName,
    15_000,
    ctx
  );
  const problems = reactAtRest(view);
  if (problems.some(problem => problem.endsWith('has not committed'))) {
    throw new HarnessFault(`the React dApp did not render: ${problems.join('; ')}`);
  }
  if (problems.length > 0) throw new Error(`the React dApp did not come to rest: ${problems.join('; ')}`);
  return view;
}

/**
 * Selects the tree's one wallet and waits for React to commit it: a command sent before that commit reads the context
 * from before the selection, whose `connect` throws WalletNotSelectedError.
 */
export async function selectReact(react: DappHandle, tree: ReactTree, ctx: CellContext): Promise<ReactSnapshot> {
  const { selected } = await callReact(react, 'select', { tree }, ctx.deadline);
  const view = await waitForReact(
    react,
    candidate => latestSnapshot(candidate, tree)?.selected === selected,
    5_000,
    ctx
  );
  const snapshot = latestSnapshot(view, tree);
  if (snapshot?.selected !== selected)
    throw new Error(`the ${tree} context did not commit the selection of ${selected}`);
  return snapshot;
}

/**
 * Connects `tree` and waits until its context shows `account`, answering the connect popup only if the wallet asks.
 * Returns the last snapshot read, followed or not; the caller asserts on it.
 */
export async function connectReact(
  react: DappHandle,
  tree: ReactTree,
  account: string,
  ctx: CellContext
): Promise<ReactSnapshot> {
  const { result } = await answerIfPrompted(
    react,
    () => callReact(react, 'connect', { tree }, ctx.deadline),
    'connect',
    ctx
  );
  unwrap(result, `${tree} connect`, ctx);
  const follows = (view: ReactPageView): boolean => {
    const snapshot = latestSnapshot(view, tree);
    return (
      snapshot?.connected === true &&
      snapshot.address !== null &&
      canonicalAddress(snapshot.address) === canonicalAddress(account)
    );
  };
  const view = await waitForReact(react, follows, 10_000, ctx);
  const snapshot = latestSnapshot(view, tree);
  if (snapshot === undefined) throw new HarnessFault(`the ${tree} probe has not committed`);
  // The connect stands whatever the key: one that is not a Word leaves publicKeyHex null, and why is the evidence.
  if (snapshot.publicKeyError !== undefined) ctx.evidence.reactPublicKeyError = snapshot.publicKeyError;
  return snapshot;
}
