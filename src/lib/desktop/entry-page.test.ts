import fs from 'fs';
import path from 'path';

const read = (file: string) => fs.readFileSync(path.join(__dirname, '../../..', file), 'utf8');

// Tauri opens `index.html` unless the window names a page, and the desktop build emits only its Vite input, so a window
// without a matching `url` shows "asset not found: index.html" instead of the app. No CI job launches the desktop app.
it('opens the main desktop window on the page the desktop build emits', () => {
  const config: { app: { windows: { url?: string }[] } } = JSON.parse(read('src-tauri/tauri.conf.json'));
  const input = /input:\s*resolve\(__dirname,\s*'([^']+)'\)/.exec(read('vite.desktop.config.ts'))?.[1];

  expect(input).toBeDefined();
  expect(config.app.windows).toHaveLength(1);
  expect(config.app.windows[0]?.url).toBe(input);
  expect(fs.existsSync(path.join(__dirname, '../../..', input ?? ''))).toBe(true);
});
