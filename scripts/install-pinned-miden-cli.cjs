const { execFileSync, spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLIENT_CRATES = ['miden-client', 'miden-client-cli', 'miden-client-proto', 'miden-client-sqlite-store'];
const KERNEL_CRATES = ['miden-protocol', 'miden-standards', 'miden-tx'];
const KERNEL_SUPPORT_CRATES = ['miden-agglayer', 'miden-protocol-build-utils'];
const VM_CRATE =
  /^miden-(air|assembly(?:-syntax)?|core(?:-lib)?|crypto(?:-derive)?|mast-package|processor|prover|verifier|utils(?:-sync)?)$/;
const PROCESS_GROUP_GRACE_MS = 5_000;
const SOURCE_CLEANUP_RETRIES = 6;
const SOURCE_CLEANUP_RETRY_DELAY_MS = 250;
const DEFAULT_INSTALL_TIMEOUT_MS = 1_800_000;

function packages(lock) {
  return lock
    .split('[[package]]')
    .slice(1)
    .map(block => ({
      name: block.match(/^name = "([^"]+)"/m)?.[1],
      version: block.match(/^version = "([^"]+)"/m)?.[1],
      source: block.match(/^source = "([^"]+)"/m)?.[1]
    }));
}

function constrainManifest(manifest, version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Protocol pin must be an exact stable version');
  for (const name of KERNEL_CRATES) {
    const pattern = new RegExp(`^(${name}\\s*=\\s*\\{[^\\n]*version\\s*=\\s*")[^"]+("[^\\n]*\\})`, 'gm');
    let matches = 0;
    manifest = manifest.replace(pattern, (_, before, after) => {
      matches++;
      return `${before}=${version}${after}`;
    });
    if (matches !== 1) throw new Error(`Expected one workspace dependency for ${name}, found ${matches}`);
  }
  return manifest;
}

function assertGraph(lock, clientVersion, protocolVersion, originalLock) {
  const resolved = packages(lock);
  for (const name of [...CLIENT_CRATES, ...KERNEL_CRATES, ...KERNEL_SUPPORT_CRATES]) {
    const expected = CLIENT_CRATES.includes(name) ? clientVersion : protocolVersion;
    const entries = resolved.filter(pkg => pkg.name === name);
    if (entries.length !== 1 || entries[0].version !== expected) {
      throw new Error(`${name} must resolve exactly once to ${expected}`);
    }
  }
  const vmGraph = text =>
    packages(text)
      .filter(pkg => VM_CRATE.test(pkg.name))
      .map(pkg => `${pkg.name}@${pkg.version}:${pkg.source ?? 'path'}`)
      .sort();
  const original = vmGraph(originalLock);
  if (!original.length || JSON.stringify(original) !== JSON.stringify(vmGraph(lock))) {
    throw new Error('Preparing the CLI changed its frozen Miden VM graph');
  }
}

function pinIdentity(pkg) {
  const pin = {
    git: pkg.midenClientCliGit,
    client: pkg.midenClientCliVersion,
    protocol: pkg.midenClientCliProtocolVersion
  };
  if (!pin.git?.url || !/^[a-f0-9]{40}$/.test(pin.git.rev) || !/^\d+\.\d+\.\d+$/.test(pin.client)) {
    throw new Error('CLI preparation requires a full git commit and exact stable client version');
  }
  constrainManifest(KERNEL_CRATES.map(name => `${name} = { version = "0.0.0" }`).join('\n'), pin.protocol);
  return pin;
}

function fingerprint(pkg) {
  return createHash('sha256')
    .update(JSON.stringify(pinIdentity(pkg)))
    .update(fs.readFileSync(__filename))
    .digest('hex');
}

async function prepareSource(source, pkg, run = runCommand) {
  const pin = pinIdentity(pkg);
  const manifestPath = path.join(source, 'Cargo.toml');
  const lockPath = path.join(source, 'Cargo.lock');
  const original = fs.readFileSync(lockPath, 'utf8');
  fs.writeFileSync(manifestPath, constrainManifest(fs.readFileSync(manifestPath, 'utf8'), pin.protocol));
  await run('cargo', ['update', '--workspace'], {
    cwd: source,
    stdio: 'inherit',
    timeoutMs: 180_000
  });
  assertGraph(fs.readFileSync(lockPath, 'utf8'), pin.client, pin.protocol, original);
  await run('cargo', ['metadata', '--locked', '--all-features', '--format-version', '1'], {
    cwd: source,
    stdio: ['ignore', 'ignore', 'inherit'],
    timeoutMs: 180_000
  });
}

function validPreparedBinary(pkg, root) {
  const binary = path.join(root, 'bin', 'miden-client');
  try {
    const stamp = JSON.parse(fs.readFileSync(path.join(root, 'prepared-cli.json'), 'utf8'));
    const hash = createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
    return stamp.identity === fingerprint(pkg) && stamp.binaryHash === hash;
  } catch {
    return false;
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

async function waitForProcessGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupExists(pid)) return true;
    await delay(100);
  }
  return !processGroupExists(pid);
}

async function waitForChildClose(close, timeoutMs) {
  let timer;
  const closed = await Promise.race([
    close.then(
      () => true,
      () => true
    ),
    new Promise(resolve => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    })
  ]);
  clearTimeout(timer);
  return closed;
}

function signalProcessGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

// A timed-out cargo process can leave rustc descendants using files in the source tree.
async function terminateProcessTree(child, close) {
  const pid = child.pid;
  if (!pid) return;

  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        timeout: PROCESS_GROUP_GRACE_MS
      });
    } catch {
      child.kill('SIGKILL');
    }
    if (!(await waitForChildClose(close, PROCESS_GROUP_GRACE_MS))) {
      throw new Error(`Timed out waiting for process ${pid} to exit after taskkill`);
    }
    return;
  }

  signalProcessGroup(pid, 'SIGTERM');
  const groupStopped = await waitForProcessGroupExit(pid, PROCESS_GROUP_GRACE_MS);
  if (!groupStopped) {
    signalProcessGroup(pid, 'SIGKILL');
    if (!(await waitForProcessGroupExit(pid, PROCESS_GROUP_GRACE_MS))) {
      throw new Error(`Process group ${pid} remained alive after SIGKILL`);
    }
  }
  if (!(await waitForChildClose(close, PROCESS_GROUP_GRACE_MS))) {
    throw new Error(`Timed out waiting for cargo process ${pid} to exit`);
  }
}

async function runCommand(command, args, { cwd, env, stdio = 'inherit', timeoutMs, spawnImpl = spawn } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Invalid timeout for ${command}: ${timeoutMs}`);
  }

  const child = spawnImpl(command, args, {
    cwd,
    env,
    stdio,
    detached: process.platform !== 'win32'
  });
  const close = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });

  let timer;
  let outcome;
  try {
    outcome = await Promise.race([
      close.then(result => ({ type: 'close', result })),
      new Promise(resolve => {
        timer = setTimeout(() => resolve({ type: 'timeout' }), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }

  const description = `${command} ${args.join(' ')}`;
  if (outcome.type === 'timeout') {
    let processTreeStopped = true;
    let terminationError;
    try {
      await terminateProcessTree(child, close);
    } catch (error) {
      processTreeStopped = false;
      terminationError = error;
    }
    const timeoutError = new Error(
      `Timed out after ${timeoutMs} ms running ${description}`,
      terminationError ? { cause: terminationError } : undefined
    );
    timeoutError.processTreeStopped = processTreeStopped;
    throw timeoutError;
  }

  if (outcome.result.code !== 0) {
    const status = outcome.result.code === null ? `signal ${outcome.result.signal}` : `code ${outcome.result.code}`;
    throw new Error(`Command exited with ${status}: ${description}`);
  }
  return outcome.result;
}

async function removeTemporarySource(source, remove = fs.promises.rm) {
  await remove(source, {
    recursive: true,
    force: true,
    maxRetries: SOURCE_CLEANUP_RETRIES,
    retryDelay: SOURCE_CLEANUP_RETRY_DELAY_MS
  });
}

function recordCacheSafety(outputPath, safeToCache) {
  if (outputPath) fs.appendFileSync(outputPath, `safe-to-cache=${safeToCache}\n`);
}

async function withSourceCleanup(source, build, remove = removeTemporarySource) {
  let primaryError;
  try {
    return await build();
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (primaryError?.processTreeStopped === false) {
      // Keep files in place if a compiler might still be using them.
      console.error(`::warning::Retaining ${source} because the failed build process tree could not be stopped.`);
    } else {
      try {
        await remove(source);
      } catch (cleanupError) {
        if (!primaryError) throw cleanupError;
        const cleanupDescription = cleanupError?.code
          ? `${cleanupError.code}: ${cleanupError.message ?? cleanupError}`
          : (cleanupError.message ?? cleanupError);
        console.error(
          `::warning::Could not clean ${source} after the primary failure: ${cleanupDescription}`
        );
      }
    }
  }
}

async function install(
  pkg,
  root = path.join(os.homedir(), '.cache', 'miden-cli', fingerprint(pkg)),
  {
    sourceRoot = process.env.MIDEN_CLI_SOURCE_ROOT,
    buildDir = process.env.MIDEN_CLI_BUILD_DIR,
    timeoutMs = Number(process.env.MIDEN_CLI_INSTALL_TIMEOUT_MS ?? DEFAULT_INSTALL_TIMEOUT_MS),
    spawnImpl = spawn,
    removeSource = removeTemporarySource
  } = {}
) {
  const pin = pinIdentity(pkg);
  const identity = fingerprint(pkg);
  const binary = path.join(root, 'bin', 'miden-client');
  const stampPath = path.join(root, 'prepared-cli.json');
  if (validPreparedBinary(pkg, root)) return binary;

  const source = sourceRoot
    ? path.join(path.resolve(sourceRoot), `miden-cli-source-${identity}`)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'miden-cli-source-'));
  return withSourceCleanup(
    source,
    async () => {
      if (sourceRoot) fs.mkdirSync(sourceRoot, { recursive: true });
      fs.rmSync(source, {
        recursive: true,
        force: true,
        maxRetries: SOURCE_CLEANUP_RETRIES,
        retryDelay: SOURCE_CLEANUP_RETRY_DELAY_MS
      });
      await runCommand('git', ['clone', '--no-checkout', pin.git.url, source], {
        stdio: 'inherit',
        timeoutMs: 180_000,
        spawnImpl
      });
      await runCommand('git', ['checkout', '--detach', pin.git.rev], {
        cwd: source,
        stdio: 'inherit',
        timeoutMs: 180_000,
        spawnImpl
      });
      await prepareSource(source, pkg, (command, args, options) =>
        runCommand(command, args, { ...options, spawnImpl })
      );
      fs.mkdirSync(root, { recursive: true });
      if (buildDir) fs.mkdirSync(buildDir, { recursive: true });
      const installArgs = [
        'install',
        '--path',
        'bin/miden-cli',
        '--bin',
        'miden-client',
        '--locked',
        '--root',
        root,
        '--force'
      ];
      if (buildDir) installArgs.push('--target-dir', buildDir);
      await runCommand('cargo', installArgs, { cwd: source, stdio: 'inherit', timeoutMs, spawnImpl });
      const binaryHash = createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
      fs.writeFileSync(stampPath, JSON.stringify({ identity, binaryHash, pin }, null, 2));
      return binary;
    },
    removeSource
  );
}

module.exports = {
  packages,
  constrainManifest,
  assertGraph,
  pinIdentity,
  fingerprint,
  prepareSource,
  validPreparedBinary,
  runCommand,
  removeTemporarySource,
  withSourceCleanup,
  recordCacheSafety,
  install
};
if (require.main === module) {
  const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
  if (process.argv[2] === 'fingerprint') console.log(fingerprint(pkg));
  else if (process.argv[2] === 'install') {
    install(pkg, process.argv[3])
      .then(binary => {
        recordCacheSafety(process.env.MIDEN_CLI_STATUS_OUTPUT, true);
        console.log(binary);
      })
      .catch(error => {
        recordCacheSafety(process.env.MIDEN_CLI_STATUS_OUTPUT, error?.processTreeStopped === true);
        console.error(error);
        process.exitCode = 1;
      });
  }
  else throw new Error('Usage: install-pinned-miden-cli.cjs {fingerprint|install [root]}');
}
