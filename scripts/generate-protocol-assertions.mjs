#!/usr/bin/env node
/**
 * Writes the closed table a transaction failure report names a kernel assertion from
 * (src/lib/telemetry/protocol-assertions.json), and the SDK release and crates it was read from
 * (protocol-assertions.sources.json, which protocol-assertions.test.ts pins to the installed SDK).
 *
 * An assertion fails with `error code: N`, where N is the first 8 bytes of blake3(message), little
 * endian (miden-core `error_code_from_msg`). The table maps N to the message's public name for every
 * message in the MASM library sources (`asm/`) of every crate the installed SDK's wasm was built
 * from: each `const NAME = "..."` an assertion can name, and each inline `err="..."`. Test sources
 * are not shipped and are not read: core-lib's `tests/`, its benches and miden-testing's MASM strings.
 *
 * Reads crate sources from the local Cargo registry and builds nothing. Rerun it on every SDK bump:
 *
 *   node scripts/generate-protocol-assertions.mjs [--registry <cargo registry src dir>] [--check]
 */
import { blake3 } from '@noble/hashes/blake3';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SDK = path.join(ROOT, 'node_modules/@miden-sdk/miden-sdk');
const TABLE = path.join(ROOT, 'src/lib/telemetry/protocol-assertions.json');
const SOURCES = path.join(ROOT, 'src/lib/telemetry/protocol-assertions.sources.json');
// The Goldilocks modulus: a code at or above it would print reduced, so the table could not hold it as is.
const FIELD_MODULUS = 2n ** 64n - 2n ** 32n + 1n;

// A crate's source path in a built wasm, as `miden-protocol-0.17.1/`.
const CRATE_PATH = /\b(miden(?:-[a-z][a-z0-9]*)+)-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)\//g;

/** Each crate a built wasm names in its source paths, with the set of versions it names. */
export function cratesBuiltInto(wasm) {
  const found = new Map();
  for (const match of wasm.toString('latin1').matchAll(CRATE_PATH)) {
    const versions = found.get(match[1]) ?? new Set();
    versions.add(match[2]);
    found.set(match[1], versions);
  }
  return found;
}

export function errorCode(message) {
  const digest = blake3(new TextEncoder().encode(message));
  let code = 0n;
  for (let i = 7; i >= 0; i--) code = (code << 8n) | BigInt(digest[i]);
  return code;
}

/** The source with its comments blanked, so a commented-out assertion is not read. A `#` inside a string stays. */
function withoutComments(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      out += char;
      if (char === '\\') out += text[++i] ?? '';
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
      out += char;
    } else if (char === '#') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else {
      out += char;
    }
  }
  return out;
}

/** Each message a module declares or asserts with: `{ name, message }`, `name` undefined for an inline one. */
export function moduleMessages(source) {
  const text = withoutComments(source);
  const consts = new Map();
  for (const match of text.matchAll(/\bconst\s+([A-Za-z_]\w*)\s*=\s*"((?:[^"\\]|\\.)*)"/g)) {
    consts.set(match[1], match[2]);
  }
  const named = new Set([...consts.keys()].filter(name => name.startsWith('ERR_')));
  const inline = [];
  for (const match of text.matchAll(/\b\w+\.err\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([A-Za-z_]\w*))/g)) {
    if (match[1] !== undefined) inline.push(match[1]);
    else if (consts.has(match[2])) named.add(match[2]);
  }
  const messages = [...named].map(name => ({ name, message: consts.get(name) }));
  for (const message of inline) messages.push({ name: undefined, message });
  for (const { message } of messages) {
    // The assembler hashes the literal's text; an escape would need its unescaping rules, which no source uses yet.
    if (message.includes('\\')) throw new Error(`an assertion message with an escape needs handling: ${message}`);
  }
  return messages;
}

const masmFiles = dir =>
  readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .flatMap(entry => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return masmFiles(full);
      return entry.name.endsWith('.masm') ? [full] : [];
    });

// Spelled out, so `start_ptr must be <= end_ptr` does not read as `START_PTR_MUST_BE_END_PTR`. A `-` after a
// snake_case name subtracts; anywhere else it joins a word.
const OPERATOR_WORDS = [
  [/!=/g, ' NE '],
  [/<=/g, ' LE '],
  [/>=/g, ' GE '],
  [/==/g, ' EQ '],
  [/</g, ' LT '],
  [/>/g, ' GT '],
  [/\+/g, ' PLUS '],
  [/(?<=\w)\*(?=\w)/g, ' TIMES '],
  [/\b(\w*_\w*)-/g, '$1 MINUS '],
  [/'/g, '']
];

// An inline message has no name of its own: it is named by its crate and its words.
export function inlineName(crate, message) {
  const words = OPERATOR_WORDS.reduce((text, [pattern, word]) => text.replace(pattern, word), message);
  return `${crate.replace(/^miden-/, '')} ${words}`
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * The table for crates given as `[[crate, sourceDir]]`, in that order. A code keeps the first constant that
 * declares it, else the first inline message, so a message both named and written inline keeps its name.
 */
export function assertionTable(crates) {
  const byCode = new Map();
  for (const [crate, dir] of crates) {
    for (const file of masmFiles(path.join(dir, 'asm'))) {
      for (const { name, message } of moduleMessages(readFileSync(file, 'utf8'))) {
        const code = errorCode(message);
        if (code >= FIELD_MODULUS) throw new Error(`code ${code} of "${message}" is not a canonical field element`);
        const candidate = { name: name ?? inlineName(crate, message), named: name !== undefined };
        const held = byCode.get(code);
        if (held === undefined || (candidate.named && !held.named)) byCode.set(code, candidate);
      }
    }
  }
  const owners = new Map();
  for (const [code, { name }] of byCode) {
    if (owners.has(name)) throw new Error(`${name} names two codes, ${owners.get(name)} and ${code}`);
    owners.set(name, code);
  }
  return new Map([...byCode].map(([code, { name }]) => [String(code), name]));
}

// Keys in text order, written by hand: an object would put a code below 2^32 first, as an array index.
const tableJson = table =>
  `{\n${[...table]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([code, name]) => `  ${JSON.stringify(code)}: ${JSON.stringify(name)}`)
    .join(',\n')}\n}\n`;

function registryRoots(explicit) {
  if (explicit !== undefined) return [explicit];
  const src = path.join(process.env.CARGO_HOME ?? path.join(homedir(), '.cargo'), 'registry', 'src');
  return existsSync(src) ? readdirSync(src).map(index => path.join(src, index)) : [];
}

function main(argv) {
  const at = argv.indexOf('--registry');
  const roots = registryRoots(at === -1 ? undefined : argv[at + 1]);
  const sdkVersion = JSON.parse(readFileSync(path.join(SDK, 'package.json'), 'utf8')).version;
  const built = cratesBuiltInto(readFileSync(path.join(SDK, 'dist/st/assets/miden_client_web.wasm')));
  const crates = [];
  const missing = [];
  for (const [crate, versions] of [...built].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (versions.size !== 1) throw new Error(`the SDK wasm names ${crate} at ${[...versions].join(' and ')}`);
    const [version] = versions;
    const dir = roots.map(root => path.join(root, `${crate}-${version}`)).find(candidate => existsSync(candidate));
    if (dir === undefined) missing.push(`${crate}-${version}`);
    else if (existsSync(path.join(dir, 'asm')) && masmFiles(path.join(dir, 'asm')).length > 0) {
      crates.push([crate, version, dir]);
    }
  }
  if (missing.length > 0) {
    throw new Error(`not in the Cargo registry (fetch them, e.g. with cargo fetch): ${missing.join(', ')}`);
  }
  const table = tableJson(assertionTable(crates.map(([crate, , dir]) => [crate, dir])));
  const sources = `${JSON.stringify({ sdk: sdkVersion, crates: Object.fromEntries(crates.map(([c, v]) => [c, v])) }, null, 2)}\n`;
  if (argv.includes('--check')) {
    const stale = [
      [TABLE, table],
      [SOURCES, sources]
    ].filter(([file, text]) => !existsSync(file) || readFileSync(file, 'utf8') !== text);
    for (const [file] of stale) console.error(`${path.relative(ROOT, file)} is out of date; rerun without --check`);
    return stale.length === 0 ? 0 : 1;
  }
  writeFileSync(TABLE, table);
  writeFileSync(SOURCES, sources);
  console.log(`${table.split('\n').length - 3} codes from ${crates.map(([c, v]) => `${c} ${v}`).join(', ')}`);
  return 0;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
