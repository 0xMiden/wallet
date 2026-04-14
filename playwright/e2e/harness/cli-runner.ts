import { execFile } from 'child_process';
import { promisify } from 'util';

import type { TimelineRecorder } from './timeline-recorder';
import type { CLIInvocation } from './types';

const execFileAsync = promisify(execFile);

/**
 * Parse structured fields from miden-client CLI stdout.
 */
function parseCliOutput(stdout: string): CLIInvocation['parsed'] {
  const parsed: CLIInvocation['parsed'] = {};

  // "To view account details execute miden-client account -s <ACCOUNT_ID>"
  const accountMatch = stdout.match(/account\s+-s\s+(\S+)/);
  if (accountMatch) {
    parsed.accountId = accountMatch[1];
  }

  // "Transaction ID: <hex>"
  const txMatch = stdout.match(/Transaction ID:\s+(\S+)/);
  if (txMatch) {
    parsed.transactionId = txMatch[1];
  }

  // "Output notes:\n\t- <note_id>"
  const noteMatch = stdout.match(/Output notes:\s*\n\s*-\s+(\S+)/);
  if (noteMatch) {
    parsed.noteId = noteMatch[1];
  }

  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

/**
 * Run a CLI command with structured capture and timeline logging.
 */
export async function runCliCommand(
  timeline: TimelineRecorder,
  command: string,
  options: {
    cwd?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
    stepName?: string;
  } = {}
): Promise<CLIInvocation> {
  const startedAt = Date.now();
  const cwd = options.cwd ?? process.cwd();
  const timeoutMs = options.timeoutMs ?? 120_000;

  // Split command into binary + args to use execFile (no shell, no injection risk)
  const parts = command.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [command];
  const bin = parts[0]!;
  const args = parts.slice(1).map(a => a.replace(/^"|"$/g, ''));

  let result: CLIInvocation;

  try {
    const { stdout, stderr } = await execFileAsync(bin, args, {
      timeout: timeoutMs,
      cwd,
      env: { ...process.env, ...options.env },
      maxBuffer: 10 * 1024 * 1024,
    });

    result = {
      command,
      args: command.split(/\s+/).slice(1),
      cwd,
      exitCode: 0,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      durationMs: Date.now() - startedAt,
      timedOut: false,
      parsed: parseCliOutput(stdout),
    };
  } catch (err: any) {
    result = {
      command,
      args: command.split(/\s+/).slice(1),
      cwd,
      exitCode: err.code ?? null,
      signal: err.signal,
      stdout: (err.stdout ?? '').trim(),
      stderr: (err.stderr ?? '').trim(),
      durationMs: Date.now() - startedAt,
      timedOut: err.killed === true,
      timeoutMs: err.killed ? timeoutMs : undefined,
      parsed: parseCliOutput(err.stdout ?? ''),
    };
  }

  // Emit timeline event
  const shortCmd = command.split(/\s+/).slice(0, 3).join(' ');
  timeline.emit({
    category: 'cli_command',
    severity: result.exitCode === 0 ? 'info' : 'error',
    message: `CLI: ${shortCmd} [exit=${result.exitCode}${result.timedOut ? ' TIMEOUT' : ''}] (${result.durationMs}ms)`,
    data: result as unknown as Record<string, unknown>,
    durationMs: result.durationMs,
    ...(options.stepName ? { stepName: options.stepName } : {}),
  });

  return result;
}

/**
 * CLIRunner class that wraps runCliCommand with a bound timeline.
 */
export class CLIRunner {
  constructor(private timeline: TimelineRecorder) {}

  async run(
    command: string,
    options: {
      cwd?: string;
      timeoutMs?: number;
      env?: Record<string, string>;
      stepName?: string;
    } = {}
  ): Promise<CLIInvocation> {
    return runCliCommand(this.timeline, command, options);
  }
}
