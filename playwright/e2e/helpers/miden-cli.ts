import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import type { CLIRunner } from '../harness/cli-runner';
import { mintFromPublicFaucet, publicFaucetApiUrl } from './public-faucet';
import type { CLIInvocation, EnvironmentConfig } from '../harness/types';

/**
 * MIDEN sent to each account the harness creates so it can pay its own transaction fees.
 *
 * A fee is `verification_base_fee * (ilog2(cycles) + 1)`, capped at 30 multiples, so at
 * `verification_base_fee = 10000` a transaction costs at most 300_000 and typically ~170_000.
 * This buys roughly 66 transactions at the cap, ~117 at the typical figure — NOT the "few
 * thousand" an earlier version of this comment claimed, which overstated it by ~20x.
 *
 * The number that matters for the genesis funders is not what a test SPENDS but what it KEEPS:
 * an account is funded once, spends a few hundred thousand, and is then discarded still holding
 * most of this. Every funding therefore strands ~85% of itself permanently, and a sweep's drain
 * on the funders is `accounts_funded * FUNDING_MIDEN`, independent of how many fees were paid.
 * That is why the funders emptied overnight at the old genesis balance, and why lowering this
 * constant buys far more headroom than it looks like it should — 4x lower here is 4x more
 * sweeps. It has not been lowered because no one has measured the busiest spec's transaction
 * count, and under-funding fails indirectly: the account simply cannot pay, and the suite
 * reports a product-looking error rather than an empty account.
 */
const FUNDING_MIDEN = 20_000_000;

const DEFAULT_FAUCET_MAX_SUPPLY = 1_000_000_000_000;

const faucetInitToml = (symbol: string, decimals: number, maxSupply: number | bigint = DEFAULT_FAUCET_MAX_SUPPLY) =>
  `[fungible-faucet-metadata]\nmax_supply = ${maxSupply}\ndecimals = ${decimals}\nsymbol = "${symbol}"\n`;

/**
 * Classify a `miden-client` CLI stderr as a transient failure that should be
 * retried (vs. a deterministic error that should fail fast). Matched
 * wrap-tolerantly with `\s+` because miette folds messages at terminal width.
 *
 * Categories:
 *  - RPC/transport to the node: 5xx, gRPC framing, reset/timeout.
 *  - `new nonce N is less than old nonce M`: the node's account state lags the
 *    store's optimistic post-submit state while a deploy/mint is still in
 *    flight, and miden-client's sqlite store hard-fails the whole sync on it
 *    (0xMiden/miden-client#2243). Clears once the tx commits.
 *  - Remote-prover connection failures (`failed to connect to ... prover`,
 *    `transport error`, `no native certs found`): the TLS/gRPC handshake to the
 *    delegated prover endpoint flakes intermittently on the macOS CI runners
 *    (a sibling mint in the same test connects fine), so a connection-level
 *    prover error is transient, not a proving-logic failure.
 */
export function isTransientCliError(stderr: string): boolean {
  return /HTTP status code 5\d\d|grpc request failed|grpc-status header missing|connection reset|timed out|Temporary failure|less\s+than\s+old\s+nonce|failed\s+to\s+connect\s+to(\s+the)?(\s+remote)?\s+prover|transport\s+error|no\s+native\s+certs/i.test(
    stderr
  );
}

/**
 * Resolve the miden-client binary path.
 * 1. MIDEN_CLIENT_BIN env var
 * 2. `miden-client` in PATH
 * 3. Auto-install from crates.io at the pinned `midenClientCliVersion` from
 *    the root package.json (decoupled from the JS SDK version — the
 *    miden-client Rust workspace and `@miden-sdk/*` npm packages release on
 *    independent cadences, so version-matching them was brittle: a JS-only
 *    SDK bump would request a CLI version that doesn't exist on crates.io
 *    and CI would fail before the test even ran).
 */
export function resolveCliPath(): string {
  // 1. Explicit override
  if (process.env.MIDEN_CLIENT_BIN) {
    return process.env.MIDEN_CLIENT_BIN;
  }

  // 2. Already in PATH — but only if it is the PINNED version.
  //
  // This used to return on any `--version` that exited 0, which meant a
  // developer's own `miden-client` silently won regardless of version. A 0.16
  // CLI against a 0.15 node fails with
  //
  //     cli::client_error ├─▶ accept header validation failed
  //
  // which names neither the version nor the mismatch, and sends you looking at
  // the wallet. Presence is not the same as correctness — the same trap as an
  // AVD that is listed but has no config.ini.
  try {
    const reported = execSync('miden-client --version', { stdio: 'pipe' }).toString().trim();
    const pinned = readPinnedCliVersion();
    if (!pinned || reported.includes(pinned)) {
      return 'miden-client';
    }
    // Under a GIT pin the version field records what the rev builds, and a rev
    // bump can legitimately land before the field catches up. So WARN rather
    // than fail: a hard failure here reds every E2E job over metadata lag, which
    // is worse than the mismatch it reports. This is not hypothetical — the
    // first version of this check did exactly that, because the field read
    // 0.14.8 while the pinned rev builds 0.15.0 (corrected in #675).
    if (hasGitPin()) {
      console.warn(
        `[miden-cli] PATH miden-client is "${reported}" but package.json records ${pinned} for the pinned rev. ` +
          `If chain calls fail with "accept header validation failed", this mismatch is why — point ` +
          `MIDEN_CLIENT_BIN at a binary built from the pinned rev.`
      );
      return 'miden-client';
    }
    throw new Error(
      `miden-client on PATH is "${reported}" but this repo pins ${pinned} ` +
        `(package.json → midenClientCliVersion).\n` +
        `A mismatched CLI fails against the node with an unrelated-looking "accept header validation failed".\n` +
        `Either install the pin (cargo install miden-client-cli --version ${pinned} --locked) or point the ` +
        `harness at a matching binary with MIDEN_CLIENT_BIN=/path/to/miden-client.`
    );
  } catch (err) {
    // A version MISMATCH is a hard stop; only "not installed" falls through to
    // the auto-install below.
    if (err instanceof Error && err.message.includes('but this repo pins')) throw err;
  }

  // (see readPinnedCliVersion below for where the pin comes from)

  // 3. Auto-install at the pin from package.json. Two pin shapes:
  //    - `midenClientCliGit: { url, rev }` — takes precedence; used while the
  //      target miden-client line is unreleased on crates.io (e.g. the 0.15
  //      series ships from the repo's `next` branch only). Pinned to a REV,
  //      not a branch, so installs are reproducible and match the protocol
  //      rev the bundled SDK WASM was built against.
  //    - `midenClientCliVersion: "x.y.z"` — crates.io release.
  let version: string | undefined;
  let gitPin: { url: string; rev: string } | undefined;
  try {
    const pkgPath = path.resolve('package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    gitPin = pkg.midenClientCliGit;
    version = pkg.midenClientCliVersion;
    if (gitPin && (typeof gitPin.url !== 'string' || typeof gitPin.rev !== 'string')) {
      throw new Error('midenClientCliGit must have string `url` and `rev` fields');
    }
    if (!gitPin && (!version || typeof version !== 'string')) {
      throw new Error('midenClientCliVersion missing from package.json');
    }
  } catch (err: any) {
    throw new Error(`Cannot resolve miden-client CLI pin from package.json: ${err.message}`);
  }

  if (gitPin) {
    console.log(`Installing miden-client-cli from ${gitPin.url}@${gitPin.rev.slice(0, 8)} (first run only)...`);
    try {
      // `--locked` consumes the repo's Cargo.lock at that rev — same
      // MAST-root-drift protection as the crates.io path below.
      execSync(`cargo install miden-client-cli --git ${gitPin.url} --rev ${gitPin.rev} --locked`, {
        stdio: 'inherit',
        timeout: 600_000 // 10 min for compile
      });
    } catch (err: any) {
      throw new Error(
        `Failed to install miden-client-cli from ${gitPin.url}@${gitPin.rev}. ` +
          `Ensure the Rust toolchain is installed (https://rustup.rs). Error: ${err.message}`
      );
    }
    return 'miden-client';
  }

  console.log(`Installing miden-client-cli@${version} from crates.io (first run only)...`);
  try {
    // `--locked` consumes the Cargo.lock shipped with the published crate,
    // which pins `miden-assembly` (and every other transitive) to the same
    // versions the SDK released against. Without it, cargo re-resolves
    // each dep to the latest semver-compatible version at install time —
    // and miden-assembly patch releases have moved BasicFungibleFaucet's
    // procedure MAST roots (see miden-vm#3144). That drift causes the
    // wallet (built against miden-assembly 0.22.1 via the bundled SDK)
    // to fall through `BasicFungibleFaucetComponent::from_account` for
    // CLI-deployed faucets, rendering the token as "Unknown" instead of
    // its real symbol — which then breaks any test selector that filters
    // by token symbol.
    execSync(`cargo install miden-client-cli --version ${version} --locked`, {
      stdio: 'inherit',
      timeout: 600_000 // 10 min for compile
    });
  } catch (err: any) {
    throw new Error(
      `Failed to install miden-client-cli@${version} from crates.io. ` +
        `Ensure the Rust toolchain is installed (https://rustup.rs). Error: ${err.message}`
    );
  }

  return 'miden-client';
}

/**
 * High-level wrapper around the miden-client CLI.
 * Each test run gets an isolated .miden directory via --local.
 */
export class MidenCli {
  private faucets = new Map<string, string>(); // symbol -> faucetId
  private lastFaucetId?: string;
  private binaryPath: string;
  private workDir: string;
  /** Set once `init()` has run for this instance; see the guard in `init()`. */
  private initialized = false;
  private env: EnvironmentConfig;
  private cliRunner: CLIRunner;

  constructor(opts: { binaryPath: string; workDir: string; env: EnvironmentConfig; cliRunner: CLIRunner }) {
    this.binaryPath = opts.binaryPath;
    this.workDir = opts.workDir;
    this.env = opts.env;
    this.cliRunner = opts.cliRunner;
  }

  private async run(args: string, opts?: { timeoutMs?: number }): Promise<CLIInvocation> {
    return this.cliRunner.run(`${this.binaryPath} ${args}`, {
      cwd: this.workDir,
      timeoutMs: opts?.timeoutMs
    });
  }

  /**
   * Initialize the miden-client with --local for isolated state.
   */
  async init(): Promise<void> {
    // "Ensure initialised", not "initialise". `workDir` is a fresh mkdtemp per TEST, so a
    // second call can only be the same test initialising twice -- which happens whenever a
    // spec inits and then calls a helper that also inits (`ensureFeeFunded` does, because
    // two of its callers do not init themselves). Without this guard the CLI fails the whole
    // test with `cli::config_already_exists`, which reads like a chain problem and is not one.
    if (this.initialized) return;

    fs.mkdirSync(this.workDir, { recursive: true });

    let initArgs = `init --local --network ${this.env.networkFlag}`;

    // For localhost, note transport must be passed explicitly
    if (this.env.networkFlag === 'localhost' && this.env.transportUrl) {
      initArgs += ` --note-transport-endpoint ${this.env.transportUrl}`;
    }

    // Remote prover for testnet/devnet
    if (this.env.provingUrl && this.env.delegateProving) {
      initArgs += ` --remote-prover-endpoint ${this.env.provingUrl}`;
    }

    const result = await this.run(initArgs);
    if (result.exitCode !== 0) {
      throw new Error(`miden-client init failed: ${result.stderr}`);
    }

    // Latched HERE, not at the end of the method. The config file exists from this line
    // onward, so a failure in either of the two awaits below would leave the flag false with
    // the config already written -- and the next `init()` would re-run `init --local`, get a
    // non-zero exit and throw the very `config_already_exists` this guard exists to prevent,
    // burying the real failure. The remaining steps are idempotent, so re-entering after one
    // of them failed is safe; re-entering the CLI init is not.
    this.initialized = true;

    // Import the funder wallets BEFORE the first sync. `import` writes each account at the state
    // recorded in its .mac snapshot, and `sync` only walks blocks newer than the store's
    // checkpoint -- so importing into a store already at the chain tip leaves no blocks to walk and
    // the funder stays pinned at its genesis state. The node then rejects its next transaction with
    // `initial account commitment ... does not match the current commitment`. Importing first lets
    // the initial genesis-to-tip sync reconcile them. No-op on stacks that ship no funders.
    await this.importFunders();

    // Sync to fetch genesis block and chain tip (required before account creation)
    await this.sync();
  }

  /**
   * Deploy a new fungible faucet account.
   * Returns the faucet account ID.
   */
  /**
   * Whether a CLI failure is the chain telling us the account cannot pay its own fee.
   *
   * The CLI exposes no way to read `verification_base_fee`, so the harness cannot ask the chain
   * up front whether it charges. Detecting it from the failure instead is self-correcting: a
   * chain that starts charging is handled without a harness change, and one that does not never
   * takes the funding path at all. Both shapes are the same underlying condition — the vault
   * cannot cover the fee `pay_fee` withdraws before anything else runs.
   */
  private static isUnfundedFeeError(stderr: string): boolean {
    return (
      /amount of the asset in the vault is less/i.test(stderr) ||
      /conversion info committed via the auth args/i.test(stderr)
    );
  }

  /**
   * Imports the genesis funder wallets so this client can spend from them.
   *
   * The local stack writes MIDEN-funded wallets to its accounts directory when fees are on (see
   * `test-node-genesis`). They are public so a client that did not create them can still read
   * their state, which is what lets an ephemeral test client use them.
   */
  private funderIds: string[] = [];
  private nativeFaucetId?: string;
  /** Set once a deployment has failed for want of a fee, which is how the chain reveals it charges. */
  private chainChargesFees = false;
  private readonly fundedForFees = new Set<string>();

  private static funderDir(): string {
    return (
      process.env.MIDEN_E2E_FUNDER_DIR ??
      path.join(process.env.HOME ?? '', 'miden/miden-client/target/test-node/data/accounts')
    );
  }

  private async importFunders(): Promise<string[]> {
    const dir = MidenCli.funderDir();
    const files = fs.existsSync(dir)
      ? fs
          .readdirSync(dir)
          .filter(f => /^wallet_\d+\.mac$/.test(f))
          .sort()
      : [];
    // A chain that charges no fee needs no funders, so an absent directory is not an error here.
    // Only the funding path itself can say whether one was required; it reports that below.
    if (files.length === 0) {
      return this.funderIds;
    }
    if (this.funderIds.length === 0) {
      // The CLI's token-symbol map has no entry for MIDEN, so the funding asset has to be named by
      // faucet id. Import the native faucet to learn it.
      const nativeFaucet = path.join(dir, 'native_faucet.mac');
      if (fs.existsSync(nativeFaucet)) {
        const imported = await this.run(`import ${nativeFaucet}`, { timeoutMs: 120_000 });
        this.nativeFaucetId = imported.stdout.match(/imported account\s+(0x[0-9a-f]+)/i)?.[1];
      }
      for (const f of files) {
        const imported = await this.run(`import ${path.join(dir, f)}`, { timeoutMs: 120_000 });
        // `import` prints "Successfully imported account 0x...". The account id is what `transfer`
        // needs; the file name is not an address the CLI understands.
        const id = imported.stdout.match(/imported account\s+(0x[0-9a-f]+)/i)?.[1];
        if (id) this.funderIds.push(id);
      }
      if (this.funderIds.length === 0) {
        throw new Error(`Imported ${files.length} funder file(s) but parsed no account ids`);
      }
    }
    return this.funderIds;
  }

  /**
   * Creates a faucet on a fee-charging chain, funding it so it can pay for its own deployment.
   *
   * Mirrors the miden-client harness's `deploy_by_consuming`: an account's first transaction can be
   * the one that consumes a note carrying the native fee asset, because the credit is applied to
   * the vault before `pay_fee` withdraws from it.
   */
  private async createFaucetFunded(tomlPath: string): Promise<CLIInvocation> {
    // `basic-wallet` is composed in deliberately. The fungible faucet component exports
    // `mint_and_send`, `receive_and_burn` and metadata accessors, but NOT `receive_asset` -- so a
    // plain faucet cannot consume a P2ID note at all, and the funding transfer aborts with
    // `account procedure ... is not in the account procedure index map`. Since genesis has no way
    // to give a faucet a starting balance either (`[[fungible_faucet]]` takes no `assets`, only
    // `[[wallet]]` does), a fee-charging chain leaves a plain faucet permanently unable to
    // transact: empty vault, no fee, no way to receive one. Adding the wallet component gives it
    // `receive_asset` so it can be funded like any other account.
    const created = await this.run(
      `new-account --account-type public -p basic-fungible-faucet -p basic-wallet ` +
        `--init-storage-data-path ${tomlPath}`,
      { timeoutMs: 180_000 }
    );
    if (created.exitCode !== 0) {
      throw new Error(`Failed to create faucet (undeployed): ${created.stderr}`);
    }
    const newId = created.parsed?.accountId ?? created.stdout.match(/account\s+-s\s+(\S+)/)?.[1];
    if (!newId) {
      throw new Error(`Created a faucet but could not parse its id from: ${created.stdout}`);
    }

    // Genesis funders on a local stack, the chain's public faucet on devnet; either way this
    // only SENDS the note. Consuming it below is what funds the vault -- and for this still-
    // undeployed faucet, that consumption is also its deploy.
    const fundedBy = await this.sendNativeFundingNote(newId);

    // The funding note only becomes consumable once it is committed in a block, and
    // `consume-notes` exits 0 when it finds nothing to consume -- so a single attempt can report
    // success while leaving the vault empty. That failure would then surface at the account's next
    // transaction as an unpayable fee, a long way from its cause. Poll until the asset is actually
    // in the vault, and treat "still nothing" as the error it is.
    let consumed: CLIInvocation | undefined;
    let funded = false;
    for (let attempt = 1; attempt <= 10 && !funded; attempt++) {
      await this.sync();
      consumed = await this.run(`consume-notes --account ${newId} --force`, { timeoutMs: 180_000 });
      funded = await this.holdsFeeAsset(newId);
      if (!funded) {
        await new Promise(r => setTimeout(r, 3_000));
      }
    }
    if (!funded) {
      throw new Error(
        `Faucet ${newId} never received its funding note from ${fundedBy}; its vault still holds ` +
          `none of the fee asset after 10 attempts. Last consume-notes output: ` +
          `${consumed?.stderr || consumed?.stdout || 'no output'}`
      );
    }
    return created;
  }

  /**
   * Sends an account enough of the native asset to pay its own transaction fees.
   *
   * Idempotent per account and a no-op on a chain that charges nothing. The note is left for the
   * recipient to claim: this client holds no key for a wallet living in the extension, and the
   * claim is exactly the transaction the funding makes payable.
   */
  /**
   * Whether this chain charges a transaction fee, as the harness has determined it.
   *
   * Lets a spec assert it was actually funded rather than proceed hopefully: an unfunded
   * account fails much later, at whatever transaction it first cannot pay for, with a
   * kernel assertion code that says nothing about the cause.
   */
  async chainCharges(): Promise<boolean> {
    if (!this.chainChargesFees && (this.env.chargesFees || (await this.importFunders()).length > 0)) {
      this.chainChargesFees = true;
    }
    return this.chainChargesFees;
  }

  /**
   * Sends `target` a note carrying the native fee asset, from whichever source this chain
   * offers, and returns a label naming the source for error messages.
   *
   * Local stacks have genesis funder wallets; a public chain does not, and until this
   * existed the harness simply could not fund anything on devnet. The public faucet is the
   * chain's own native-asset faucet there, so its grant is spendable on fees.
   *
   * Only SENDS. The caller consumes the note, which is what actually moves the asset into
   * the vault -- and, for an undeployed account, doubles as the deploy.
   */
  private async sendNativeFundingNote(target: string): Promise<string> {
    const funders = await this.importFunders();

    if (funders.length > 0) {
      if (!this.nativeFaucetId) {
        throw new Error('Could not determine the native fee faucet id; cannot fund from a genesis funder');
      }
      const failures: string[] = [];
      for (const funder of funders) {
        // A funder's on-chain state moves under us across specs; a submission built on a
        // stale view is rejected by name, and re-syncing is the recovery. An empty vault
        // never is, so that falls through to the next funder.
        for (let attempt = 1; attempt <= 4; attempt++) {
          await this.sync();
          const sent = await this.run(
            `transfer --sender ${funder} --target ${target} ` +
              `--asset ${FUNDING_MIDEN}::${this.nativeFaucetId} --note-type public --force`,
            { timeoutMs: 180_000 }
          );
          if (sent.exitCode === 0) return `genesis funder ${funder}`;
          const stale = /invalid request|stale|nonce|does not match the current commitment/i.test(sent.stderr);
          if (!stale || attempt === 4) {
            failures.push(`${funder}: ${sent.stderr.trim().slice(0, 200)}`);
            break;
          }
          await new Promise(r => setTimeout(r, 2_000 * attempt));
        }
      }
      throw new Error(
        `Could not fund ${target} from any of ${funders.length} genesis funder(s). If they all report ` +
          `an empty vault, the local chain has been drained and needs re-genesising: restart the node ` +
          `with MIDEN_TEST_NODE_VERIFICATION_BASE_FEE set.\n  ` +
          failures.join('\n  ')
      );
    }

    const faucetApi = publicFaucetApiUrl(this.env.name);
    if (!faucetApi) {
      throw new Error(
        `This chain charges a transaction fee, so ${target} must hold the native asset before it can ` +
          `transact, but ${this.env.name} has neither genesis funder wallets (looked in ` +
          `${MidenCli.funderDir()}) nor a public faucet. Bring the local stack up with ` +
          `MIDEN_TEST_NODE_VERIFICATION_BASE_FEE set, or point MIDEN_E2E_FUNDER_DIR at funded ` +
          `wallet_N.mac files.`
      );
    }
    await mintFromPublicFaucet(faucetApi, target);
    return `public faucet ${faucetApi}`;
  }

  async fundAccountForFees(accountId: string): Promise<void> {
    if (this.fundedForFees.has(accountId)) {
      return;
    }
    // `chainChargesFees` is normally learned from a deployment that failed for want of a
    // fee, which only happens inside `createFaucet`. A spec that transacts WITHOUT minting
    // -- guardian-seed-backup-verify rotates a hot key and never mints -- would otherwise
    // find the flag still false and skip funding, and its first fee-paying transaction
    // fails with "failed to remove the fungible asset from the vault since the amount ...
    // is less than the amount to remove".
    //
    // Genesis funder wallets are the direct signal: `start-test-node.sh` only writes them
    // when MIDEN_TEST_NODE_VERIFICATION_BASE_FEE is non-zero, so their presence means the
    // chain charges, with no faucet deployment needed to find out.
    if (!this.chainChargesFees && (this.env.chargesFees || (await this.importFunders()).length > 0)) {
      this.chainChargesFees = true;
    }
    if (!this.chainChargesFees) {
      return;
    }
    // Only SENDS. These targets are the BROWSER wallets, which the CLI does not own and
    // cannot consume for -- the wallet claims the note itself through auto-consume. (The
    // faucet path in `createFaucet` is the opposite case: that account IS CLI-owned, so it
    // consumes there, and the consumption doubles as its deploy.)
    await this.sendNativeFundingNote(accountId);

    this.fundedForFees.add(accountId);
    await this.sync();
  }

  /**
   * Whether an account's vault holds a non-zero balance of the native fee asset.
   *
   * Used to confirm funding actually landed rather than trusting a consume that had nothing to do.
   */
  private async holdsFeeAsset(accountId: string): Promise<boolean> {
    const shown = await this.run(`account -s ${accountId}`, { timeoutMs: 60_000 });
    if (shown.exitCode !== 0) {
      return false;
    }
    // The vault renders one row per asset. Which IDENTIFIER lands in the faucet column depends
    // on whether the CLI knows that faucet's token metadata: the local stack resolves it to the
    // symbol (`| Fungible Asset | MIDEN | 20.000000 |`), while a public chain prints the raw
    // faucet id (`| Fungible Asset | 0xb6b0c673850deb71 | 99830000 |`). Matching only the symbol
    // reported "not funded" forever on devnet against a vault that had in fact just been funded.
    //
    // Any positive fungible row is sufficient BECAUSE OF WHO THIS IS ASKED ABOUT: the single
    // caller is the funding poll for a faucet created moments earlier and still undeployed, so
    // the grant is the only asset it can hold. Widen the caller set and this needs to identify
    // the fee asset properly again. Match the ROW, not the whole output: the same listing carries
    // storage keys like `miden::standards::faucets::token_name_0`, and a looser search finds one
    // of those first and reads its trailing digit as the balance.
    const row = shown.stdout.split('\n').find(line => /fungible asset/i.test(line));
    if (row === undefined) {
      return false;
    }
    const numbers = row.match(/[\d,]+(?:\.\d+)?/g);
    const amount = numbers?.[numbers.length - 1];
    return amount !== undefined && parseFloat(amount.replace(/,/g, '')) > 0;
  }

  async createFaucet(
    symbol = 'TST',
    decimals = 8,
    maxSupply: number | bigint = DEFAULT_FAUCET_MAX_SUPPLY
  ): Promise<string> {
    // Write the init storage data TOML
    const tomlPath = path.join(this.workDir, 'faucet-init.toml');
    fs.writeFileSync(tomlPath, faucetInitToml(symbol, decimals, maxSupply));

    // On a fee-charging chain a brand-new account cannot pay for its own deployment: its vault is
    // empty and `pay_fee` withdraws before anything else runs. So create it locally, fund it from a
    // genesis funder, and let the funding note's consumption be the transaction that deploys it —
    // note credit lands before the fee is taken, so that first transaction settles its own fee.
    // Where no fee is charged the account can deploy itself and this is the original one-shot path.
    const createArgs =
      `new-account --account-type public ` +
      `-p basic-fungible-faucet ` +
      `--init-storage-data-path ${tomlPath} ` +
      `--deploy`;

    const maxAttempts = 5;
    let lastErr = '';
    let createResult: CLIInvocation | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      createResult = await this.run(createArgs, { timeoutMs: 180_000 });
      if (createResult.exitCode === 0) {
        break;
      }
      lastErr = createResult.stderr;
      const transient = isTransientCliError(lastErr);
      if (!transient || attempt === maxAttempts) break;
      const backoffMs = Math.min(30_000, 1_000 * 2 ** (attempt - 1));
      // eslint-disable-next-line no-console
      console.log(
        `[miden-cli] createFaucet attempt ${attempt}/${maxAttempts} transient RPC failure, retrying in ${backoffMs}ms`
      );
      await new Promise(r => setTimeout(r, backoffMs));
    }

    if (!createResult || createResult.exitCode !== 0) {
      if (!MidenCli.isUnfundedFeeError(lastErr)) {
        throw new Error(`Failed to create faucet: ${lastErr}`);
      }
      // Remember this for every later account: once one deployment has failed this way, the chain
      // is known to charge, and recipients have to be funded before they can transact at all.
      this.chainChargesFees = true;
      // The chain charges a fee and this account has nothing to pay it with. Create it without
      // deploying, fund it from a genesis funder, and let the consumption of that funding note be
      // its first transaction — note credit lands in the vault before `pay_fee` withdraws from it,
      // so that transaction settles its own fee.
      createResult = await this.createFaucetFunded(tomlPath);
    }

    // Parse account ID from stdout
    const accountId = createResult.parsed?.accountId;
    let id: string;
    if (!accountId) {
      // Fallback: try to parse from "account -s <ID>" pattern
      const match = createResult.stdout.match(/account\s+-s\s+(\S+)/);
      if (!match || !match[1]) {
        throw new Error(`Could not parse faucet account ID from output:\n${createResult.stdout}`);
      }
      id = match[1];
    } else {
      id = accountId;
    }

    this.faucets.set(symbol, id);
    this.lastFaucetId = id;

    // Sync to confirm deployment
    await this.sync();

    return id;
  }

  /**
   * Mint tokens from the deployed faucet to a target account.
   */
  async mint(
    faucetId: string,
    targetAccountId: string,
    amount: number | bigint,
    noteType: 'public' | 'private'
  ): Promise<{ txId: string; noteId: string }> {
    if (!faucetId) {
      throw new Error('mint: faucetId required');
    }

    // The recipient's own claim of this note is a transaction, and on a fee-charging chain
    // `pay_fee` withdraws the NATIVE asset -- which a token note does not credit. So a wallet that
    // is only ever sent tokens can never claim them. Send it the fee asset too; its claim picks up
    // both notes and the credit lands before the fee is taken, so that first transaction pays for
    // itself. No-op where the chain charges nothing.
    await this.fundAccountForFees(targetAccountId);

    let mintArgs = `mint --target ${targetAccountId} --asset ${amount}::${faucetId} --note-type ${noteType} --force`;

    if (this.env.delegateProving) {
      mintArgs += ' --delegate-proving';
    }

    const maxAttempts = 5;
    let lastErr = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await this.run(mintArgs, { timeoutMs: this.env.txTimeoutMs });
      if (result.exitCode === 0) {
        const txId = result.parsed?.transactionId;
        const noteId = result.parsed?.noteId;
        if (!txId || !noteId) {
          throw new Error(`Could not parse mint result from output:\n${result.stdout}`);
        }
        return { txId, noteId };
      }
      lastErr = result.stderr;
      const transient = isTransientCliError(lastErr);
      if (!transient || attempt === maxAttempts) break;
      const backoffMs = Math.min(30_000, 1_000 * 2 ** (attempt - 1));
      // eslint-disable-next-line no-console
      console.log(
        `[miden-cli] mint attempt ${attempt}/${maxAttempts} transient RPC failure, retrying in ${backoffMs}ms`
      );
      await new Promise(r => setTimeout(r, backoffMs));
    }
    throw new Error(`Mint failed after retries: ${lastErr}`);
  }

  /**
   * Sync the miden-client state with the network.
   */
  async sync(): Promise<void> {
    const maxAttempts = 5;
    let lastErr = '';
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await this.run('sync', { timeoutMs: 60_000 });
      if (result.exitCode === 0) return;
      lastErr = result.stderr;
      const transient = isTransientCliError(lastErr);
      if (!transient || attempt === maxAttempts) break;
      const backoffMs = Math.min(30_000, 1_000 * 2 ** (attempt - 1));
      // eslint-disable-next-line no-console
      console.log(
        `[miden-cli] sync attempt ${attempt}/${maxAttempts} transient RPC failure, retrying in ${backoffMs}ms`
      );
      await new Promise(r => setTimeout(r, backoffMs));
    }
    throw new Error(`Sync failed: ${lastErr}`);
  }

  /**
   * Get the faucet ID (if deployed).
   */
  getFaucetId(): string | undefined {
    return this.lastFaucetId;
  }

  /**
   * Get the work directory path.
   */
  getWorkDir(): string {
    return this.workDir;
  }

  /**
   * Clean up the isolated miden-client directory.
   */
  async cleanup(): Promise<void> {
    try {
      fs.rmSync(this.workDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

/**
 * The CLI version this repo pins, or undefined if package.json does not declare
 * one (in which case a PATH binary is accepted as-is, the previous behaviour).
 */
function readPinnedCliVersion(): string | undefined {
  try {
    const pkgPath = path.resolve('package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { midenClientCliVersion?: string };
    return typeof pkg.midenClientCliVersion === 'string' ? pkg.midenClientCliVersion : undefined;
  } catch {
    return undefined;
  }
}

/** Is the CLI pinned by git rev? If so, `midenClientCliVersion` does not describe the installed binary. */
function hasGitPin(): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8')) as {
      midenClientCliGit?: { url?: string; rev?: string };
    };
    return typeof pkg.midenClientCliGit?.rev === 'string';
  } catch {
    return false;
  }
}
