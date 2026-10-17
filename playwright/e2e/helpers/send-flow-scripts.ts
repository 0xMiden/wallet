/**
 * The Send flow's readers and its network pick as CDP script bodies (top-level `return`, the shape `cdp.eval`
 * expects), shared by the iOS and Android page objects. Nothing here imports Playwright or Node, so jsdom tests run
 * the same bodies against the rendered components.
 */
import type { NetworkChipState } from './bridge';
import type { FieldNetwork } from './contact-network';

export const SEND_FLOW = '[data-testid="send-flow"]';
// A sheet portals to <body>, outside the flow; one that is closing keeps its rows through the exit, marked closed.
export const OPEN_SHEET = '[role="dialog"][data-state="open"]';

/** A script body whose lookups all run under `scope`; `text` reads a test id's text, `val` a DetailRow's value div. */
export function scopedJs(scope: string, body: string): string {
  return (
    `var root = document.querySelector(${JSON.stringify(scope)}); if (!root) return null; ` +
    `function text(id) { var e = root.querySelector('[data-testid="' + id + '"]'); ` +
    `return e ? (e.textContent || '').trim() : null; } ` +
    `function val(id) { var e = root.querySelector('[data-testid="' + id + '"]'); ` +
    `var d = e && e.querySelector(':scope > div'); return d ? (d.textContent || '').trim() : null; } ` +
    body
  );
}

export interface SendNetworkView {
  /** The field's summary row, which names the chosen destination. */
  summary: string;
  /** The rows of the open network sheet; none while it is closed. */
  rows: NetworkChipState[];
}

/** The destination field of a 0x recipient offered several networks; null until its summary row renders. */
export const SEND_NETWORK_JS = scopedJs(
  SEND_FLOW,
  `var picker = root.querySelector('[data-testid="send-network-picker"]'); if (!picker) return null; ` +
    `var sheet = document.querySelector(${JSON.stringify(OPEN_SHEET)}); ` +
    `var rows = sheet ? Array.from(sheet.querySelectorAll('[data-testid^="send-network-"]')) : []; ` +
    `return { summary: (picker.textContent || '').trim(), rows: rows.map(function (e) { ` +
    `return { testId: e.getAttribute('data-testid') || '', pressed: e.getAttribute('aria-pressed') }; }) };`
);

export interface UsdcxRouteView {
  /** RouteCard's `aria-pressed`. */
  pressed: string | null;
  cardText: string;
  fee: string | null;
  net: string | null;
  notice: string | null;
}

export const USDCX_ROUTE_JS = scopedJs(
  SEND_FLOW,
  `var card = root.querySelector('[data-testid="bridge-route-usdcx"]'); if (!card) return null; ` +
    `return { pressed: card.getAttribute('aria-pressed'), cardText: (card.textContent || '').trim(), ` +
    `fee: val('usdcx-payout-fee'), net: val('usdcx-payout-net'), notice: text('usdcx-burn-notice') };`
);

/** What the network pick needs of a page object: a script eval and a click through `el.click()`. */
export interface ScriptedSendPage {
  evalJs<T = unknown>(js: string): Promise<T>;
  click(selector: string): Promise<void>;
}

interface FieldTexts {
  picker: string | null;
  fixed: string | null;
  row: string | null;
}

/**
 * Picks a 0x recipient's destination the way `selectSendNetwork` does on Chrome: through the picker sheet while the
 * field offers a choice, then checks that the closed summary names it; a field with one network only has its static
 * row read.
 */
export async function selectSendNetworkByScript(
  page: ScriptedSendPage,
  network: FieldNetwork,
  timeoutMs: number,
  pollMs = 500
): Promise<void> {
  const picker = `${SEND_FLOW} [data-testid="send-network-picker"]`;
  const fixed = `${SEND_FLOW} [data-testid="send-network-${network.id}"]`;
  const row = `${OPEN_SHEET} [data-testid="send-network-${network.id}"]`;
  const textOf = (selector: string) =>
    `(function () { var e = document.querySelector(${JSON.stringify(selector)}); ` +
    `return e ? (e.textContent || '').trim() : null; })()`;
  const read = `return { picker: ${textOf(picker)}, fixed: ${textOf(fixed)}, row: ${textOf(row)} };`;
  // A failed eval (an inspector reattach) counts as not yet, as the page objects' own polls treat it.
  const until = async (waitingFor: string, done: (texts: FieldTexts) => boolean): Promise<FieldTexts> => {
    const deadline = Date.now() + timeoutMs;
    let last = 'none';
    for (;;) {
      try {
        const texts = await page.evalJs<FieldTexts>(read);
        if (done(texts)) return texts;
        last = JSON.stringify(texts);
      } catch (error) {
        // An eval error can quote location.href, whose search holds the onboarding ?password= all session.
        const message = error instanceof Error ? error.message : String(error);
        last = `failed eval: ${message.replace(/\?[^\s#"]+/g, '')}`;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Send network ${network.id}: ${waitingFor} within ${timeoutMs} ms; last read ${last}`);
      }
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }
  };
  const misread = (shown: string | null) =>
    new Error(`Send network ${network.id} reads ${JSON.stringify(shown)}, expected ${JSON.stringify(network.name)}.`);

  const field = await until(
    'neither the picker nor this network rendered',
    texts => texts.picker !== null || texts.fixed !== null
  );
  if (field.picker === null) {
    if (field.fixed !== network.name) throw misread(field.fixed);
    return;
  }
  await page.click(picker);
  const open = await until('the network sheet showed no such row', texts => texts.row !== null);
  if (open.row !== network.name) throw misread(open.row);
  await page.click(row);
  const closed = await until('the network sheet stayed open', texts => texts.row === null);
  if (closed.picker !== network.name) {
    throw new Error(
      `Send network selection stayed ${JSON.stringify(closed.picker)}, expected ${JSON.stringify(network.name)}.`
    );
  }
}
