import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { SourceMap, type SourceMapPayload } from 'node:module';
import { dirname, join } from 'node:path';

const FRAME =
  /^\s*at (?:[^()\n]{1,96} \()?chrome-extension:\/\/([a-p]{32})\/(chunks\/use-user-visible-error\.[A-Za-z0-9_-]{8}\.js):([1-9]\d{0,6}):([1-9]\d{0,8})\)?\s*$/;
const MARKERS = [
  ['/src/app/layouts/Dialogs.tsx', 'Dialogs'],
  ['/src/components/ui/AlertSheet.tsx', 'AlertSheet'],
  ['/src/lib/ui/drawer.tsx', 'drawer'],
  ['/src/screens/command/CommandShell.tsx', 'CommandShell'],
  ['/node_modules/@radix-ui/react-presence/dist/index.mjs', 'radix-presence'],
  ['/node_modules/vaul/dist/index.mjs', 'vaul'],
  ['/node_modules/react-dom/cjs/react-dom.production.min.js', 'react-dom']
] as const;
const MAX_MAP_BYTES = 2_500_000;

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string');
}

function isSourceMapPayload(
  value: unknown
): value is Pick<SourceMapPayload, 'version' | 'file' | 'sources' | 'names' | 'mappings'> {
  return (
    value !== null &&
    typeof value === 'object' &&
    'version' in value &&
    value.version === 3 &&
    'file' in value &&
    typeof value.file === 'string' &&
    'sources' in value &&
    isStringArray(value.sources) &&
    'names' in value &&
    isStringArray(value.names) &&
    'mappings' in value &&
    typeof value.mappings === 'string'
  );
}

/** Return only allowlisted source markers and 1-based positions; raw browser/map data never leaves this helper. */
export function summarizeEarnReactFrames(stacks: readonly string[], extensionId: string, buildDir: string): string {
  if (!/^[a-p]{32}$/.test(extensionId)) return 'unavailable';
  const frames: Array<{ chunk: string; line: number; column: number }> = [];
  for (const stack of stacks.slice(0, 2)) {
    if (stack.length > 16_384 || !stack.includes('Minified React error #185')) continue;
    let framesFromStack = 0;
    for (const line of stack.split('\n').slice(0, 16)) {
      const match = FRAME.exec(line);
      if (!match || match[1] !== extensionId) continue;
      const [, , chunk, lineText, columnText] = match;
      const generatedLine = Number(lineText);
      const generatedColumn = Number(columnText);
      if (!chunk || !Number.isSafeInteger(generatedLine) || !Number.isSafeInteger(generatedColumn)) continue;
      frames.push({ chunk, line: generatedLine, column: generatedColumn });
      framesFromStack++;
      if (framesFromStack === 4) break;
    }
  }
  const firstChunk = frames[0]?.chunk;
  if (!firstChunk) return 'unavailable';
  try {
    const root = realpathSync(buildDir);
    const chunks = join(root, 'chunks');
    if (!lstatSync(chunks).isDirectory() || dirname(realpathSync(chunks)) !== root) return 'unavailable';
    const mapPath = join(chunks, `${firstChunk.slice('chunks/'.length)}.map`);
    const stat = lstatSync(mapPath);
    if (!stat.isFile() || stat.size > MAX_MAP_BYTES || dirname(realpathSync(mapPath)) !== chunks)
      return 'unavailable';
    const payload: unknown = JSON.parse(readFileSync(mapPath, 'utf8'));
    if (!isSourceMapPayload(payload)) return 'unavailable';
    const map = new SourceMap({ ...payload, sourceRoot: '', sourcesContent: payload.sources.map(() => '') });
    const results = new Set<string>();
    for (const frame of frames) {
      if (frame.chunk !== firstChunk) continue;
      const entry = map.findEntry(frame.line - 1, frame.column - 1);
      if (!('originalSource' in entry) || entry.generatedLine !== frame.line - 1) continue;
      const marker = MARKERS.find(([suffix]) => entry.originalSource.endsWith(suffix))?.[1];
      if (!marker || !Number.isSafeInteger(entry.originalLine) || !Number.isSafeInteger(entry.originalColumn))
        continue;
      const line = entry.originalLine + 1;
      const column = entry.originalColumn + 1;
      if (line < 1 || line > 1_000_000 || column < 1 || column > 100_000_000) continue;
      results.add(`${marker}:${line}:${column}`);
      if (results.size === 6) break;
    }
    return results.size ? [...results].join(', ') : 'unavailable';
  } catch {
    return 'unavailable';
  }
}
