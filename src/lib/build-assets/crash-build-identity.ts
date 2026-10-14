import { execFileSync } from 'node:child_process';

/** Only the revision and dirty bit leave the build process, never source filenames. */
export function readWalletBuildIdentity(root: string): { revision: string; dirty: string } {
  try {
    const options = { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] } satisfies Parameters<
      typeof execFileSync
    >[2];
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], options).toString().trim();
    if (!/^[a-f0-9]{40}$/.test(revision)) return { revision: '', dirty: 'unknown' };
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], options).toString();
    return { revision, dirty: String(status.length !== 0) };
  } catch {
    return { revision: '', dirty: 'unknown' };
  }
}
