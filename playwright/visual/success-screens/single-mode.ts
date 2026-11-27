// What the page is when it runs as one self-contained HTML file (see build-single.py), where nothing
// can be fetched: no second page for the dApp windows, no comparison files beside it.
//   'flow' : only the current Send flow, no tab bar.
//   'all'  : every tab. Frames that normally load another file are filled from this same file.
type Mode = 'flow' | 'all' | undefined;
const scope = globalThis as { __BREAD_SINGLE__?: Mode; __DAPP_ID__?: string };

export const SINGLE_MODE: Mode = scope.__BREAD_SINGLE__;

/** Inside a dApp-window frame of the single file: which request to show. */
export const DAPP_ID = scope.__DAPP_ID__;

/** A comparison page with its images embedded, as the single file carries it. */
export function comparePage(file: string): string | undefined {
  const node = document.getElementById('bread-compare');
  if (!node?.textContent) return undefined;
  const pages: Record<string, string> = JSON.parse(node.textContent);
  return pages[file];
}

/** A whole document for a dApp-window frame: this file's own stylesheet and script, told which request to draw. */
export function dappDocument(id: string): string | undefined {
  const css = document.getElementById('bread-css')?.textContent;
  const js = document.getElementById('bread-js')?.textContent;
  if (!css || !js) return undefined;
  return (
    '<!doctype html><html><head><meta charset="UTF-8" /><style id="bread-css">' + css + '</style></head><body style="margin:0"><div id="root"></div>' +
    '<script>window.__BREAD_SINGLE__ = "all"; window.__DAPP_ID__ = ' + JSON.stringify(id) + ';</' + 'script>' +
    '<script type="module" id="bread-js">' + js + '</' + 'script></body></html>'
  );
}
