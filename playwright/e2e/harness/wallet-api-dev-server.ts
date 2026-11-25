/**
 * The local wallet-api Worker of the multi-device E2E suite.
 *
 * The suite runs the extension on testnet against the encrypted-backup Worker in `services/wallet-api`. This module
 * starts that Worker on this machine with `wrangler dev`. The Worker refuses each request whose `Origin` header is not
 * in `ALLOWED_ORIGINS`, and the committed `wrangler.jsonc` allows no origin. Thus this module writes a local copy of
 * that config that allows the extension origin, and starts the Worker from the copy.
 *
 * Isolation. Each start makes a new temporary directory (`miden-wallet-api-*` in the OS temporary directory):
 *   - `wrangler.json`: the committed config, with absolute paths and the local `vars`.
 *   - `.dev.vars`: a new random `JWT_SIGNING_KEY`. Wrangler reads `.dev.vars` from the directory of the config file.
 *     Thus it does not read a `.dev.vars` that a developer keeps in `services/wallet-api`, and this module does not
 *     change that file.
 *   - `state/`: the local D1 database (`--persist-to`), so two runs do not share data.
 *   - `.wrangler/`: the bundle output of Wrangler.
 *   - `dev-server.json`: the process data that global teardown reads.
 * A stop removes the directory. The Worker log goes to `test-results/wallet-api/` (or `E2E_WALLET_API_LOG_DIR`),
 * which the workflow uploads, and stays after the stop.
 *
 * The extension origin. The unpacked extension has no manifest `key`. Chrome then makes the extension id from the
 * SHA-256 of the real absolute path of the extension directory (after it resolves symbolic links): it takes the first
 * 32 hex digits and writes each digit 0-f as a letter a-p. The fixture loads `EXTENSION_DIST`, else
 * `dist/chrome_unpacked`, in each profile, so all wallets of a run have one id. This rule is for Linux and macOS.
 * The fixture also calls {@link assertWalletApiAllowsExtension} with the id it reads from the service worker URL, so
 * an incorrect id stops the run with a clear error.
 */
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

export type Env = Record<string, string | undefined>;
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export const DEFAULT_WALLET_API_URL = 'http://127.0.0.1:8787';
/** The prefix of each temporary directory. A stop removes only a directory with this prefix. */
export const TEMP_DIR_PREFIX = 'miden-wallet-api-';
const STATE_FILE = 'dev-server.json';
const STOP_MARKER = 'stop-requested';
const FOREIGN_ORIGIN = 'https://wallet-api-probe.invalid';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);
const ROOT_DIR = path.resolve(__dirname, '../../..');
const SERVICE_DIR = path.join(ROOT_DIR, 'services', 'wallet-api');
const REQUEST_TIMEOUT_MS = 10_000;
const MIGRATE_TIMEOUT_MS = 240_000;
const DEFAULT_START_TIMEOUT_MS = 180_000;

/** The process ids that this realm asked to stop. The exit watch does not report them as a crash. */
const stopRequested = new Set<number>();

const isJsonObject = (value: JsonValue | undefined): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

// ── Base URL ────────────────────────────────────────────────────────────────

/** The base URL of the Worker, with no trailing slash: `E2E_WALLET_API_URL`, else the local default. */
export function walletApiBaseUrl(env: Env = process.env): string {
  const raw = env.E2E_WALLET_API_URL ?? DEFAULT_WALLET_API_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`E2E_WALLET_API_URL is not a URL: ${raw}`);
  }
  const plain =
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.username === '' &&
    url.password === '' &&
    url.search === '' &&
    url.hash === '' &&
    !raw.endsWith('/');
  if (!plain) {
    throw new Error(
      `E2E_WALLET_API_URL must be an http or https URL with no credentials, query, fragment or trailing slash: ${raw}`
    );
  }
  return `${url.origin}${url.pathname === '/' ? '' : url.pathname}`;
}

/** True when the run uses a Worker that runs elsewhere. Then global setup starts nothing and only checks it. */
export function isExternalWalletApi(env: Env = process.env): boolean {
  return env.E2E_WALLET_API_EXTERNAL === 'true';
}

export interface ListenAddress {
  host: string;
  port: number;
}

/** The address that `wrangler dev` listens on. A local Worker needs a loopback http URL with no path. */
export function localListenAddress(baseUrl: string): ListenAddress {
  const url = new URL(baseUrl);
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname) || url.pathname !== '/') {
    throw new Error(
      `A local Worker needs a loopback http base URL with no path, such as ${DEFAULT_WALLET_API_URL}. ` +
        `Got ${baseUrl}. Set E2E_WALLET_API_EXTERNAL=true to use a Worker that runs elsewhere.`
    );
  }
  return { host: url.hostname, port: url.port === '' ? 80 : Number(url.port) };
}

// ── Extension origin ────────────────────────────────────────────────────────

/** Chrome's id for `input`: the first 32 hex digits of its SHA-256, each digit 0-f written as a letter a-p. */
export function chromeExtensionId(input: string): string {
  const hex = createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 32);
  return Array.from(hex, digit => String.fromCharCode(97 + parseInt(digit, 16))).join('');
}

/** The id that Chrome gives an unpacked extension with no manifest `key`, from its real absolute path. */
export function unpackedExtensionId(realAbsolutePath: string): string {
  if (!path.isAbsolute(realAbsolutePath)) {
    throw new Error(`An unpacked extension id needs an absolute path: ${realAbsolutePath}`);
  }
  return chromeExtensionId(realAbsolutePath);
}

/** The extension directory that the fixture loads: `EXTENSION_DIST`, else `dist/chrome_unpacked`. */
export function defaultExtensionPath(env: Env = process.env): string {
  return path.resolve(env.EXTENSION_DIST ?? path.join(ROOT_DIR, 'dist', 'chrome_unpacked'));
}

/** The id of the extension build in `directory`. The directory must hold a `manifest.json`. */
export function extensionIdForDirectory(directory: string): string {
  const manifest = path.join(directory, 'manifest.json');
  if (!existsSync(manifest)) {
    throw new Error(`No extension build at ${directory}. Run "yarn test:e2e:multi-device:build" first.`);
  }
  return unpackedExtensionId(realpathSync(path.resolve(directory)));
}

export function extensionOrigin(extensionId: string): string {
  if (!/^[a-p]{32}$/.test(extensionId)) throw new Error(`Not a Chrome extension id: ${extensionId}`);
  return `chrome-extension://${extensionId}`;
}

// ── Worker config ───────────────────────────────────────────────────────────

function endOfString(text: string, start: number): number {
  let at = start + 1;
  while (at < text.length) {
    const char = text.charAt(at);
    if (char === '\\') {
      at += 2;
      continue;
    }
    if (char === '"') return at + 1;
    at += 1;
  }
  throw new Error('JSONC text has a string with no end');
}

/** The JSONC text with its `//` and `/* *\/` comments removed. A comment marker in a string stays. */
export function stripJsonComments(text: string): string {
  let out = '';
  let at = 0;
  while (at < text.length) {
    const pair = text.slice(at, at + 2);
    if (text.charAt(at) === '"') {
      const end = endOfString(text, at);
      out += text.slice(at, end);
      at = end;
      continue;
    }
    if (pair === '//') {
      const end = text.indexOf('\n', at);
      at = end === -1 ? text.length : end;
      continue;
    }
    if (pair === '/*') {
      const end = text.indexOf('*/', at + 2);
      if (end === -1) throw new Error('JSONC text has a block comment with no end');
      at = end + 2;
      continue;
    }
    out += text.charAt(at);
    at += 1;
  }
  return out;
}

function parseJson(text: string, where: string): JsonValue {
  try {
    const value: JsonValue = JSON.parse(text);
    return value;
  } catch (error) {
    throw new Error(`${where} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The one Wrangler version that the scripts of `services/wallet-api/package.json` pin. */
export function readWranglerVersion(packageJsonText: string): string {
  const manifest = parseJson(packageJsonText, 'services/wallet-api/package.json');
  const scripts = isJsonObject(manifest) ? manifest.scripts : undefined;
  const versions = new Set<string>();
  if (isJsonObject(scripts)) {
    for (const script of Object.values(scripts)) {
      if (typeof script !== 'string') continue;
      for (const match of script.matchAll(/wrangler@(\d+\.\d+\.\d+)\b/g)) {
        if (match[1] !== undefined) versions.add(match[1]);
      }
    }
  }
  const [version] = [...versions];
  if (version === undefined || versions.size !== 1) {
    throw new Error(
      `services/wallet-api/package.json must pin one Wrangler version in its scripts; found ${[...versions].join(', ') || 'none'}`
    );
  }
  return version;
}

export interface LocalWorkerOptions {
  serviceDir: string;
  allowedOrigins: readonly string[];
  revision: string;
}

/**
 * The local copy of the committed Worker config: `main` and each `migrations_dir` as absolute paths, so the copy
 * works from another directory, and `vars` with the allowed origins and a revision. The bindings stay as committed.
 */
export function localWorkerConfig(committed: JsonValue, options: LocalWorkerOptions): JsonObject {
  if (!isJsonObject(committed)) throw new Error('wrangler.jsonc is not a JSON object');
  const main = committed.main;
  if (typeof main !== 'string') throw new Error('wrangler.jsonc has no main entry point');
  const databases = committed.d1_databases;
  if (!Array.isArray(databases)) throw new Error('wrangler.jsonc has no d1_databases list');
  const localDatabases = databases.map(database => {
    if (!isJsonObject(database)) throw new Error('wrangler.jsonc has a d1_databases entry that is not an object');
    const migrations = database.migrations_dir;
    return typeof migrations === 'string'
      ? { ...database, migrations_dir: path.resolve(options.serviceDir, migrations) }
      : database;
  });
  if (!localDatabases.some(database => database.binding === 'DB')) {
    throw new Error('wrangler.jsonc has no D1 binding named DB');
  }
  const config: JsonObject = {};
  for (const [key, value] of Object.entries(committed)) {
    if (key !== '$schema') config[key] = value;
  }
  const vars = committed.vars;
  config.main = path.resolve(options.serviceDir, main);
  config.d1_databases = localDatabases;
  config.vars = {
    ...(isJsonObject(vars) ? vars : {}),
    ALLOWED_ORIGINS: JSON.stringify(options.allowedOrigins),
    DEPLOYMENT_REVISION: options.revision
  };
  return config;
}

/** The database name of the `DB` binding, which `wrangler d1 migrations apply` takes. */
export function d1DatabaseName(config: JsonObject): string {
  const databases = config.d1_databases;
  const binding = Array.isArray(databases)
    ? databases.find(database => isJsonObject(database) && database.binding === 'DB')
    : undefined;
  const name = isJsonObject(binding) ? binding.database_name : undefined;
  if (typeof name !== 'string') throw new Error('The DB binding has no database_name');
  return name;
}

export interface WranglerRun {
  version: string;
  configPath: string;
  persistDir: string;
}

/** The `npx` arguments that apply the D1 migrations to the local database of the run. */
export function wranglerMigrateArgs(run: WranglerRun & { databaseName: string }): string[] {
  return [
    '--yes',
    `wrangler@${run.version}`,
    'd1',
    'migrations',
    'apply',
    run.databaseName,
    '--local',
    '--config',
    run.configPath,
    '--persist-to',
    run.persistDir
  ];
}

/** The `npx` arguments that start the Worker on the listen address, with remote bindings off. */
export function wranglerDevArgs(run: WranglerRun & ListenAddress): string[] {
  return [
    '--yes',
    `wrangler@${run.version}`,
    'dev',
    '--config',
    run.configPath,
    '--local',
    '--ip',
    run.host,
    '--port',
    String(run.port),
    '--persist-to',
    run.persistDir,
    '--show-interactive-dev-session=false',
    '--log-level',
    'info'
  ];
}

// ── CORS contract ───────────────────────────────────────────────────────────

export interface WalletApiRequestShape {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** The request headers that need a preflight, in lower case. */
  headers: readonly string[];
}

/**
 * The requests that `send()` in `src/lib/backup/api-client.ts` makes. `Accept` is a safelisted header, so it needs
 * no preflight. `Content-Type: application/json` and the other headers do.
 */
export const WALLET_API_REQUESTS: readonly WalletApiRequestShape[] = [
  // The nonce and the login.
  { method: 'POST', headers: ['content-type'] },
  // The salt and the entry writes.
  { method: 'PUT', headers: ['authorization', 'content-type'] },
  // The reads, conditional on an ETag.
  { method: 'GET', headers: ['authorization', 'if-none-match'] },
  // The profile delete.
  { method: 'DELETE', headers: ['authorization'] }
];

export interface ResponseView {
  status: number;
  headers: Headers;
}

const tokens = (list: string | null, ignoreCase: boolean): Set<string> =>
  new Set(
    (list ?? '')
      .split(',')
      .map(token => (ignoreCase ? token.trim().toLowerCase() : token.trim()))
      .filter(token => token.length > 0)
  );

/** What is wrong with the preflight answer for one wallet request from `origin`. Empty when it passes. */
export function preflightProblems(shape: WalletApiRequestShape, origin: string, response: ResponseView): string[] {
  const label = `The ${shape.method} preflight`;
  const problems: string[] = [];
  if (response.status !== 204) problems.push(`${label} answered ${response.status}, not 204`);
  const allowOrigin = response.headers.get('Access-Control-Allow-Origin');
  if (allowOrigin !== origin) problems.push(`${label} allows the origin ${allowOrigin ?? '(none)'}, not ${origin}`);
  if (!tokens(response.headers.get('Vary'), true).has('origin')) problems.push(`${label} has no Vary: Origin`);
  if (!tokens(response.headers.get('Access-Control-Allow-Methods'), false).has(shape.method)) {
    problems.push(`${label} does not allow the method ${shape.method}`);
  }
  const allowedHeaders = tokens(response.headers.get('Access-Control-Allow-Headers'), true);
  const missing = shape.headers.filter(header => !allowedHeaders.has(header));
  if (missing.length > 0) problems.push(`${label} does not allow the headers ${missing.join(', ')}`);
  return problems;
}

/** What is wrong with the answer to a plain request from the allowed origin. */
export function allowedOriginProblems(origin: string, response: ResponseView): string[] {
  const problems: string[] = [];
  if (response.status !== 200) problems.push(`A GET /healthz from ${origin} answered ${response.status}, not 200`);
  const allowOrigin = response.headers.get('Access-Control-Allow-Origin');
  if (allowOrigin !== origin) {
    problems.push(`A GET /healthz from ${origin} allows the origin ${allowOrigin ?? '(none)'}, not ${origin}`);
  }
  return problems;
}

/** What is wrong with the answer to a request from an origin that the Worker must refuse. */
export function foreignOriginProblems(label: string, response: ResponseView): string[] {
  const problems: string[] = [];
  if (response.status !== 403) problems.push(`${label} answered ${response.status}, not 403`);
  if (response.headers.get('Access-Control-Allow-Origin') !== null) {
    problems.push(`${label} has an Access-Control-Allow-Origin header`);
  }
  return problems;
}

async function probe(fetchImpl: FetchLike, url: string, init: RequestInit): Promise<ResponseView> {
  const response = await fetchImpl(url, {
    cache: 'no-store',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...init
  });
  // Read the body, so the connection goes back to the pool.
  await response.arrayBuffer().catch(() => undefined);
  return { status: response.status, headers: response.headers };
}

export interface CorsCheckOptions {
  baseUrl: string;
  origin: string;
  fetchImpl?: FetchLike;
}

/**
 * Check the CORS contract that the wallet needs: each preflight of a wallet request from `origin` passes, a plain
 * request from `origin` gets its `Access-Control-Allow-Origin`, and an unknown origin gets 403. Throw an error that
 * lists each problem.
 */
export async function checkWalletApiCors({ baseUrl, origin, fetchImpl = fetch }: CorsCheckOptions): Promise<void> {
  const problems: string[] = [];
  for (const shape of WALLET_API_REQUESTS) {
    const headers: Record<string, string> = { Origin: origin, 'Access-Control-Request-Method': shape.method };
    if (shape.headers.length > 0) headers['Access-Control-Request-Headers'] = shape.headers.join(', ');
    const preflight = await probe(fetchImpl, `${baseUrl}/v1/storage`, { method: 'OPTIONS', headers });
    problems.push(...preflightProblems(shape, origin, preflight));
  }
  const allowed = await probe(fetchImpl, `${baseUrl}/healthz`, { method: 'GET', headers: { Origin: origin } });
  problems.push(...allowedOriginProblems(origin, allowed));
  const foreignRead = await probe(fetchImpl, `${baseUrl}/healthz`, {
    method: 'GET',
    headers: { Origin: FOREIGN_ORIGIN }
  });
  problems.push(...foreignOriginProblems(`A GET /healthz from ${FOREIGN_ORIGIN}`, foreignRead));
  const foreignPreflight = await probe(fetchImpl, `${baseUrl}/v1/storage`, {
    method: 'OPTIONS',
    headers: { Origin: FOREIGN_ORIGIN, 'Access-Control-Request-Method': 'GET' }
  });
  problems.push(...foreignOriginProblems(`A preflight from ${FOREIGN_ORIGIN}`, foreignPreflight));
  if (problems.length > 0) {
    throw new Error(
      `The wallet-api Worker at ${baseUrl} does not keep the CORS contract for ${origin}:\n  - ${problems.join('\n  - ')}`
    );
  }
}

/** Why `/healthz` does not answer `{"ok":true}`, or null when it does. */
export async function walletApiHealthProblem(baseUrl: string, fetchImpl: FetchLike = fetch): Promise<string | null> {
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/healthz`, {
      method: 'GET',
      cache: 'no-store',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    return `no answer from ${baseUrl}/healthz (${error instanceof Error ? error.message : String(error)})`;
  }
  const text = await response.text().catch(() => '');
  let body: JsonValue = null;
  try {
    body = JSON.parse(text);
  } catch {
    return `${baseUrl}/healthz answered ${response.status} with a body that is not JSON`;
  }
  if (response.status !== 200 || !isJsonObject(body) || body.ok !== true) {
    return `${baseUrl}/healthz answered ${response.status} ${text.slice(0, 200)}`;
  }
  return null;
}

/**
 * The run-time cross-check for the fixture. Give it the extension id that a launched wallet has (the host of its
 * service worker URL). It throws a clear error when the Worker does not answer or does not allow that origin.
 */
export async function assertWalletApiAllowsExtension(
  extensionId: string,
  options: { env?: Env; fetchImpl?: FetchLike } = {}
): Promise<void> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = walletApiBaseUrl(env);
  const origin = extensionOrigin(extensionId);
  const logHint = env.E2E_WALLET_API_LOG ? `\nWorker log: ${env.E2E_WALLET_API_LOG}.` : '';
  const health = await walletApiHealthProblem(baseUrl, fetchImpl);
  if (health !== null) {
    throw new Error(`The wallet-api Worker is not healthy: ${health}. It can have stopped during the run.${logHint}`);
  }
  try {
    await checkWalletApiCors({ baseUrl, origin, fetchImpl });
  } catch (error) {
    const expected = env.E2E_WALLET_API_EXTENSION_ID;
    const mismatch =
      expected !== undefined && expected !== '' && expected !== extensionId
        ? `\nGlobal setup allowed the extension id ${expected}, which it calculated from the extension path, but the ` +
          `wallet runs as ${extensionId}. Chrome calculates the id from the real absolute path of the unpacked ` +
          'extension. Make sure that EXTENSION_DIST is the same for global setup and for the fixture.'
        : '';
    throw new Error(`${error instanceof Error ? error.message : String(error)}${mismatch}${logHint}`);
  }
}

// ── Processes ───────────────────────────────────────────────────────────────

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // The process group is already gone.
  }
}

async function waitUntil(test: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await test()) return true;
    if (Date.now() >= deadline) return false;
    await delay(200);
  }
}

/** True when a TCP connection to the address opens. */
export function portAnswers({ host, port }: ListenAddress, timeoutMs = 1_000): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host, port });
    const finish = (answers: boolean): void => {
      socket.destroy();
      resolve(answers);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

async function stopProcessGroup(pid: number): Promise<void> {
  signalGroup(pid, 'SIGTERM');
  if (await waitUntil(() => !groupAlive(pid), 10_000)) return;
  signalGroup(pid, 'SIGKILL');
  await waitUntil(() => !groupAlive(pid), 5_000);
}

function logTail(logPath: string, bytes = 4_000): string {
  try {
    return readFileSync(logPath, 'utf8').slice(-bytes);
  } catch {
    return '(no log)';
  }
}

const childEnv = (): NodeJS.ProcessEnv => ({ ...process.env, WRANGLER_SEND_METRICS: 'false', FORCE_COLOR: '0' });

/** Run `npx` with the arguments to its end, with its output in the log. Each child is the leader of its own group. */
function runLogged(args: string[], cwd: string, logPath: string, timeoutMs: number): Promise<void> {
  appendFileSync(logPath, `\n$ npx ${args.join(' ')}\n`);
  const log = openSync(logPath, 'a');
  const child = spawn('npx', args, { cwd, env: childEnv(), stdio: ['ignore', log, log], detached: true });
  closeSync(log);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (child.pid !== undefined) signalGroup(child.pid, 'SIGKILL');
      reject(new Error(`npx ${args.slice(1, 4).join(' ')} did not finish in ${timeoutMs / 1000} s`));
    }, timeoutMs);
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`npx ${args.slice(1, 4).join(' ')} stopped with ${code ?? signal}`));
    });
  });
}

// ── Start and stop ──────────────────────────────────────────────────────────

export interface DevServerState {
  pid: number;
  tempDir: string;
  logPath: string;
  host: string;
  port: number;
}

export interface WalletApiDevServer {
  baseUrl: string;
  extensionId: string;
  origin: string;
  /** True when the run uses a Worker that runs elsewhere. Then `stop()` does nothing. */
  external: boolean;
  /** The Worker log, which stays after the stop. Null for an external Worker. */
  logPath: string | null;
  /** The file that global teardown gives to {@link stopWalletApiDevServerFromState}. Null for an external Worker. */
  statePath: string | null;
  stop(): Promise<void>;
}

export interface StartOptions {
  env?: Env;
  /** The extension id to allow. The default is the id of the build that the fixture loads. */
  extensionId?: string;
  logDir?: string;
  startTimeoutMs?: number;
  fetchImpl?: FetchLike;
}

/** Read and check a state file. A temporary directory outside the OS temporary directory is refused. */
export function readDevServerState(statePath: string): DevServerState {
  const value = parseJson(readFileSync(statePath, 'utf8'), statePath);
  if (!isJsonObject(value)) throw new Error(`${statePath} is not a JSON object`);
  const { pid, tempDir, logPath, host, port } = value;
  if (
    typeof pid !== 'number' ||
    typeof tempDir !== 'string' ||
    typeof logPath !== 'string' ||
    typeof host !== 'string' ||
    typeof port !== 'number'
  ) {
    throw new Error(`${statePath} does not hold the wallet-api process data`);
  }
  const resolved = path.resolve(tempDir);
  if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith(TEMP_DIR_PREFIX)) {
    throw new Error(`${statePath} names a directory that this module did not make: ${tempDir}`);
  }
  return { pid, tempDir: resolved, logPath, host, port };
}

/** Stop the Worker, make sure that its port is free, and remove its temporary directory. The log stays. */
export async function stopWalletApiDevServer(state: DevServerState): Promise<void> {
  stopRequested.add(state.pid);
  try {
    writeFileSync(path.join(state.tempDir, STOP_MARKER), '');
  } catch {
    // The directory is already gone. The stop continues.
  }
  await stopProcessGroup(state.pid);
  const freed = await waitUntil(async () => !(await portAnswers(state)), 10_000);
  rmSync(state.tempDir, { recursive: true, force: true });
  if (!freed) throw new Error(`The wallet-api Worker stopped, but ${state.host}:${state.port} still answers.`);
}

export async function stopWalletApiDevServerFromState(statePath: string): Promise<void> {
  await stopWalletApiDevServer(readDevServerState(statePath));
}

/**
 * Start the Worker for the run, or check the external one. When this returns, the Worker answers at the base URL
 * and allows the extension origin.
 */
export async function startWalletApiDevServer(options: StartOptions = {}): Promise<WalletApiDevServer> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = walletApiBaseUrl(env);
  const extensionId = options.extensionId ?? extensionIdForDirectory(defaultExtensionPath(env));
  const origin = extensionOrigin(extensionId);

  if (isExternalWalletApi(env)) {
    const health = await walletApiHealthProblem(baseUrl, fetchImpl);
    if (health !== null) throw new Error(`The external wallet-api Worker is not healthy: ${health}`);
    await checkWalletApiCors({ baseUrl, origin, fetchImpl });
    return { baseUrl, extensionId, origin, external: true, logPath: null, statePath: null, stop: async () => {} };
  }

  const address = localListenAddress(baseUrl);
  if (await portAnswers(address)) {
    throw new Error(
      `${address.host}:${address.port} already answers. Stop the other server, or set E2E_WALLET_API_EXTERNAL=true ` +
        'to use it as the Worker of the run.'
    );
  }
  const version = readWranglerVersion(readFileSync(path.join(SERVICE_DIR, 'package.json'), 'utf8'));
  const committed = parseJson(
    stripJsonComments(readFileSync(path.join(SERVICE_DIR, 'wrangler.jsonc'), 'utf8')),
    'services/wallet-api/wrangler.jsonc'
  );
  const config = localWorkerConfig(committed, {
    serviceDir: SERVICE_DIR,
    allowedOrigins: [origin],
    revision: 'e2e-local'
  });

  const tempDir = mkdtempSync(path.join(tmpdir(), TEMP_DIR_PREFIX));
  const run: WranglerRun = {
    version,
    configPath: path.join(tempDir, 'wrangler.json'),
    persistDir: path.join(tempDir, 'state')
  };
  writeFileSync(run.configPath, `${JSON.stringify(config, null, 2)}\n`);
  // A throwaway key: 64 hex characters, over the 32 that the Worker needs.
  writeFileSync(path.join(tempDir, '.dev.vars'), `JWT_SIGNING_KEY=${randomBytes(32).toString('hex')}\n`, {
    mode: 0o600
  });

  const logDir = path.resolve(
    options.logDir ?? env.E2E_WALLET_API_LOG_DIR ?? path.join(ROOT_DIR, 'test-results', 'wallet-api')
  );
  mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `wallet-api-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  writeFileSync(logPath, `wallet-api Worker for ${origin} at ${baseUrl}, wrangler@${version}, state in ${tempDir}\n`);

  let pid: number | undefined;
  try {
    await runLogged(
      wranglerMigrateArgs({ ...run, databaseName: d1DatabaseName(config) }),
      tempDir,
      logPath,
      MIGRATE_TIMEOUT_MS
    );

    const devArgs = wranglerDevArgs({ ...run, ...address });
    appendFileSync(logPath, `\n$ npx ${devArgs.join(' ')}\n`);
    const log = openSync(logPath, 'a');
    const child = spawn('npx', devArgs, {
      cwd: tempDir,
      env: childEnv(),
      stdio: ['ignore', log, log],
      detached: true
    });
    closeSync(log);
    pid = child.pid;
    if (pid === undefined) throw new Error('Could not start wrangler dev');
    const childPid = pid;
    // An object, not a `let`: the callbacks below write it, and the wait loop reads it.
    const status: { exited: string | null } = { exited: null };
    child.once('error', error => {
      status.exited = error.message;
    });
    child.once('exit', (code, signal) => {
      status.exited = `wrangler dev stopped with ${code ?? signal}`;
      if (stopRequested.has(childPid) || existsSync(path.join(tempDir, STOP_MARKER))) return;
      // Make a crash visible: the tests that follow see failed backup requests, and this line names the reason.
      const message = `[wallet-api] The local Worker stopped during the run (${code ?? signal}). Log: ${logPath}`;
      console.error(message);
      try {
        appendFileSync(logPath, `\n${message}\n`);
      } catch {
        // The log directory is gone. The console line stays.
      }
    });
    // A run that ends with no teardown (an interrupt) must not leave the Worker on the port.
    process.once('exit', () => {
      if (stopRequested.has(childPid)) return;
      signalGroup(childPid, 'SIGTERM');
      rmSync(tempDir, { recursive: true, force: true });
    });

    const deadline = Date.now() + (options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS);
    let health = await walletApiHealthProblem(baseUrl, fetchImpl);
    while (health !== null) {
      if (status.exited !== null) throw new Error(`The Worker did not start: ${status.exited}`);
      if (Date.now() >= deadline) throw new Error(`The Worker did not become healthy: ${health}`);
      await delay(500);
      health = await walletApiHealthProblem(baseUrl, fetchImpl);
    }
    await checkWalletApiCors({ baseUrl, origin, fetchImpl });
  } catch (error) {
    if (pid !== undefined) await stopWalletApiDevServer({ pid, tempDir, logPath, ...address }).catch(() => undefined);
    else rmSync(tempDir, { recursive: true, force: true });
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}\nLog: ${logPath}\n${logTail(logPath)}`);
  }

  const state: DevServerState = { pid, tempDir, logPath, ...address };
  const statePath = path.join(tempDir, STATE_FILE);
  writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  return {
    baseUrl,
    extensionId,
    origin,
    external: false,
    logPath,
    statePath,
    stop: () => stopWalletApiDevServer(state)
  };
}
