import { crashArtifactLines, crashAssetBase } from './crash-artifacts';

export interface SafeCrashFrame {
  filename: string;
  lineno?: number;
  colno?: number;
}

/** Retain offsets only inside an exact artifact emitted by this wallet build. */
export function sanitizeWalletFrame(filename: unknown, line: unknown, column: unknown): SafeCrashFrame | undefined {
  if (typeof filename !== 'string' || crashAssetBase === '' || !filename.startsWith(crashAssetBase)) return undefined;
  // Raw matching deliberately refuses URL normalization, encoded names, and traversal.
  const path = filename.slice(crashAssetBase.length).split(/[?#]/, 1)[0];
  if (path === undefined || !Object.prototype.hasOwnProperty.call(crashArtifactLines, path)) return undefined;
  const lengths = crashArtifactLines[path];
  if (lengths === undefined || typeof line !== 'number' || !Number.isInteger(line) || line < 1) return undefined;
  const length = lengths[line - 1];
  if (length === undefined) return undefined;
  const safe: SafeCrashFrame = { filename: `app:///${path}`, lineno: line };
  if (typeof column === 'number' && Number.isInteger(column) && column >= 1 && column <= length + 1) {
    safe.colno = column;
  }
  return safe;
}
