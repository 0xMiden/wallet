import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const supportedVersion = 'Perfetto v59.1-1e9c61e98 (1e9c61e9844affd7dccd3d42d9ea9f3a3d10cf6d)';

// Chromium's Mojo interface omits the Perfetto buffer version and drain period.
// Use a private Perfetto service to keep both options and bound capture memory.
const traceConfig = `buffers {
  size_kb: 65536
  fill_policy: RING_BUFFER
  experimental_mode: TRACE_BUFFER_V2
}
data_sources {
  config {
    name: "track_event"
    chrome_config { privacy_filtering_enabled: false }
    track_event_config {
      disabled_categories: "*"
      enabled_categories: "IndexedDB"
      enabled_categories: "blink.user_timing"
      enabled_categories: "__metadata"
      enable_thread_time_sampling: true
      filter_dynamic_event_names: false
      filter_debug_annotations: false
      timestamp_unit_multiplier: 1000
    }
  }
}
incremental_state_config { clear_period_ms: 500 }
write_into_file: true
file_write_period_ms: 1000
`;

async function withTimeout(task, duration, message) {
  let timer;
  try {
    return await Promise.race([task, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), duration);
      timer.unref();
    })]);
  } finally {
    clearTimeout(timer);
  }
}

function run(binary, args, env, notify = false) {
  const child = spawn(binary, args, { env, stdio: ['ignore', 'ignore', 'pipe', notify ? 'pipe' : 'ignore'] });
  let stderr = '';
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-8192); });
  const exited = new Promise(resolve => {
    child.once('error', error => resolve({ error }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const explain = result => result.error?.message || stderr.trim() || result.signal || `exit ${result.code}`;
  return { child, exited, explain };
}

async function terminate(process) {
  if (process.child.exitCode === null && process.child.signalCode === null) process.child.kill('SIGTERM');
  try {
    return await withTimeout(process.exited, 15_000, 'Perfetto did not exit');
  } catch (error) {
    process.child.kill('SIGKILL');
    await process.exited;
    throw error;
  }
}

export class PrivatePerfetto {
  static async prepare(file, binary) {
    if (!binary || !isAbsolute(binary)) throw new Error('STRESS_PERFETTO_BIN must point to a local Perfetto tracebox executable');
    await access(binary, constants.X_OK);
    const { stdout } = await execFileAsync(binary, ['--version'], { timeout: 5_000 });
    if (stdout.trim() !== supportedVersion) throw new Error('Native capture requires Perfetto tracebox v59.1 (1e9c61e98)');
    const directory = await mkdtemp(join(tmpdir(), 'wallet-perfetto-'));
    const capture = new PrivatePerfetto(directory, file, binary);
    try {
      if (Buffer.byteLength(capture.env.PERFETTO_CONSUMER_SOCK_NAME) > 103) {
        throw new Error('The local Perfetto socket path is too long');
      }
      const config = join(directory, 'trace.pbtxt');
      await writeFile(config, traceConfig, { mode: 0o600 });
      // This is written with owner-only permissions even with a permissive umask.
      await writeFile(capture.pendingFile, '', { mode: 0o600, flag: 'wx' });
      capture.daemon = run(binary, ['traced'], capture.env);
      await capture.waitForSocket();
      return capture;
    } catch (error) {
      await capture.close();
      throw error;
    }
  }

  constructor(directory, file, binary) {
    this.directory = directory;
    this.file = file;
    this.binary = binary;
    this.pendingFile = `${file}.pending`;
    this.env = {
      ...process.env,
      PERFETTO_PRODUCER_SOCK_NAME: join(directory, 'producer.sock'),
      PERFETTO_CONSUMER_SOCK_NAME: join(directory, 'consumer.sock')
    };
  }

  async waitForSocket() {
    await withTimeout(Promise.race([
      (async () => {
        // Stop polling if the child exits or there is an unexpected FS error.
        while (this.daemon.child.exitCode === null && this.daemon.child.signalCode === null) {
          const socket = await stat(this.env.PERFETTO_CONSUMER_SOCK_NAME).catch(error => {
            if (error.code !== 'ENOENT') throw error;
          });
          if (socket?.isSocket()) return;
          await sleep(40);
        }
        throw new Error('Perfetto service exited before opening its socket');
      })(),
      this.daemon.exited.then(result => { throw new Error(this.daemon.explain(result)); })
    ]), 5_000, 'Perfetto did not open its private socket');
  }

  async start() {
    this.consumer = run(this.binary, ['perfetto', '--txt', '-c', join(this.directory, 'trace.pbtxt'),
      '-o', this.pendingFile, '--notify-fd', '3'], this.env, true);
    const [status] = await withTimeout(Promise.race([
      once(this.consumer.child.stdio[3], 'data'),
      this.consumer.exited.then(result => { throw new Error(this.consumer.explain(result)); })
    ]), 35_000, 'Perfetto did not confirm recorder startup');
    if (status[0] !== 0) throw new Error('Perfetto rejected the trace configuration');
  }

  assertRunning() {
    if (!this.consumer?.child.pid || this.consumer.child.exitCode !== null ||
        this.consumer.child.signalCode !== null || this.daemon.child.exitCode !== null ||
        this.daemon.child.signalCode !== null) throw new Error('Perfetto stopped during the workload');
  }

  async save() {
    this.assertRunning();
    const result = await terminate(this.consumer);
    if (result.code !== 0) throw new Error(this.consumer.explain(result));
    await rename(this.pendingFile, this.file);
  }

  async close() {
    try {
      if (this.consumer) await terminate(this.consumer);
    } finally {
      try {
        if (this.daemon) await terminate(this.daemon);
      } finally {
        await rm(this.directory, { recursive: true, force: true });
      }
    }
  }
}
