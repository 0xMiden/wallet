#!/usr/bin/env node

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const adbPath = process.env.ADB_BIN || 'adb';
const timeoutMs = 15_000;
const maxBuffer = 16 * 1024 * 1024;
const outputPath = path.join(process.cwd(), 'test-results-android', 'emulator-logs', 'failure-diagnostics.log');
const filter = /miden|chromium|console|fatal|ANR|lowmemorykiller|Killed/i;

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(
  outputPath,
  `Android emulator diagnostics for run ${process.env.GITHUB_RUN_ID || 'local'}\n` +
    `Each adb command is limited to ${timeoutMs}ms.\n`
);

function record(label, output) {
  const block = `\n===== ${label} =====\n${output.trimEnd() || '(no output)'}\n`;
  fs.appendFileSync(outputPath, block);
  process.stdout.write(block);
}

function errorOutput(error) {
  const details = [];
  if (typeof error?.stdout === 'string' && error.stdout.trim()) details.push(error.stdout.trimEnd());
  if (typeof error?.stderr === 'string' && error.stderr.trim()) details.push(error.stderr.trimEnd());
  details.push(error instanceof Error ? error.message : String(error));
  return details.join('\n');
}

async function capture(label, args, format = value => value) {
  try {
    const { stdout, stderr } = await execFileAsync(adbPath, args, {
      encoding: 'utf8',
      maxBuffer,
      timeout: timeoutMs
    });
    record(label, format([stdout, stderr].filter(Boolean).join('\n')));
  } catch (error) {
    record(`${label} (command failed or timed out)`, errorOutput(error));
  }
}

const tailLines = (text, count) => text.split('\n').filter(Boolean).slice(-count).join('\n');
const matchingTail = text =>
  tailLines(
    text
      .split('\n')
      .filter(line => filter.test(line))
      .join('\n'),
    300
  );

await capture('adb devices', ['devices']);

for (const serial of ['emulator-5554']) {
  const device = ['-s', serial];
  await capture(`${serial}: app process`, [...device, 'shell', 'ps', '-A'], output => {
    const matching = output.split('\n').filter(line => /miden/i.test(line));
    return matching.length ? matching.join('\n') : 'NO MIDEN PROCESS (app not running)';
  });
  await capture(`${serial}: crash buffer`, [...device, 'logcat', '-b', 'crash', '-d', '-t', '200']);
  await capture(`${serial}: recent wallet/chromium/OOM lines`, [...device, 'logcat', '-d', '-t', '5000'], matchingTail);
  await capture(`${serial}: raw logcat tail`, [...device, 'logcat', '-d', '-t', '150'], value => tailLines(value, 150));
}

process.stdout.write(`Saved bounded emulator diagnostics to ${outputPath}\n`);
