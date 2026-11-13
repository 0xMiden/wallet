import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

// Rust is only compiled in CI and CI runs no `cargo test`, so the command wiring
// (handler list, ACL list, webview guard) is pinned by reading the sources.
const TAURI_SRC = join(__dirname, '../../../src-tauri/src');
const APP_TOML = join(__dirname, '../../../src-tauri/permissions/app.toml');

function rustFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return rustFiles(path);
    return entry.name.endsWith('.rs') ? [path] : [];
  });
}

function registeredCommands(): string[] {
  const lib = readFileSync(join(TAURI_SRC, 'lib.rs'), 'utf8');
  const body = /generate_handler!\[([\s\S]*?)\]/.exec(lib)?.[1] ?? '';
  return body
    .split(',')
    .map(entry => entry.trim().split('::').pop() ?? '')
    .filter(Boolean);
}

function allowedCommands(): string[] {
  const toml = readFileSync(APP_TOML, 'utf8');
  const body = /commands\.allow\s*=\s*\[([\s\S]*?)\]/.exec(toml)?.[1] ?? '';
  return [...body.matchAll(/"([^"]+)"/g)].map(match => match[1]!);
}

describe('tauri command wiring', () => {
  it('allows exactly the commands generate_handler! registers', () => {
    expect(registeredCommands().length).toBeGreaterThan(0);
    expect(new Set(allowedCommands())).toEqual(new Set(registeredCommands()));
  });

  it('registers and allows set_content_protection', () => {
    expect(registeredCommands()).toContain('set_content_protection');
    expect(allowedCommands()).toContain('set_content_protection');
  });

  it('every app command checks the wallet webview', () => {
    for (const file of rustFiles(TAURI_SRC)) {
      const [, ...commands] = readFileSync(file, 'utf8').split('#[tauri::command]');
      for (const command of commands) {
        // A top-level fn ends at the first closing brace in column 0 (rustfmt layout).
        const fn = command.split(/\n}\n/)[0]!;
        const name = /fn\s+(\w+)/.exec(fn)?.[1];
        expect({ file, name, guarded: fn.includes('ensure_wallet_webview(&webview)?') }).toEqual({
          file,
          name,
          guarded: true
        });
      }
    }
  });
});
