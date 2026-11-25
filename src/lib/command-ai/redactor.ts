import type { AiCompilerOutput, AmountExpr } from './schema';

export type RedactedKind = 'ADDR' | 'CONTACT' | 'AMT' | 'FIAT_AMT' | 'TOKEN';

export interface RedactionContact {
  id: string;
  name: string;
  address: string;
  network?: string;
}

export interface RedactionNicheToken {
  symbol: string;
  tokenId: string;
}

export interface RedactionContext {
  contacts: readonly RedactionContact[];
  knownLiquidTickers?: ReadonlySet<string>;
  heldNicheTickers?: readonly RedactionNicheToken[];
}

export interface RedactionMap {
  addrs: Record<string, string>;
  contacts: Record<string, RedactionContact>;
  amounts: Record<string, string>;
  fiatAmounts: Record<string, string>;
  tokens: Record<string, RedactionNicheToken>;
}

export interface RedactionResult {
  redactedText: string;
  map: RedactionMap;
  redactedTokensSummary: RedactedKind[];
}

export const DEFAULT_LIQUID_TICKERS: ReadonlySet<string> = new Set([
  'MIDEN',
  'ETH',
  'WETH',
  'USDC',
  'USDCX',
  'USDT',
  'WBTC',
  'BTC',
  'SOL',
  'NEAR',
  'POL',
  'MATIC',
  'DAI',
  'ARB',
  'OP',
  'BASE'
]);

const RESERVED_CONTACT_WORDS = new Set([
  'send',
  'transfer',
  'pay',
  'swap',
  'trade',
  'bridge',
  'earn',
  'deposit',
  'withdraw',
  'receive',
  'cancel',
  'half',
  'max',
  'all',
  'my',
  'to',
  'from',
  'for',
  'on',
  'in',
  'eth',
  'miden',
  'usdc',
  'usdcx',
  'usdt',
  'btc',
  'sol',
  'near',
  'usd',
  'across',
  'relay',
  'stargate',
  'epoch',
  'agglayer',
  'circle',
  'cctp',
  'private',
  'public'
]);

interface Span {
  start: number;
  end: number;
  priority: number;
  kind: RedactedKind;
  raw: string;
  contact?: RedactionContact;
  token?: RedactionNicheToken;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isWordBoundaryChar(ch: string | undefined): boolean {
  return ch === undefined || !/[A-Za-z0-9_]/.test(ch);
}

function normalizePlaceholderRef(ref: string): string {
  return ref.replace(/^<|>$/g, '').trim();
}

/**
 * Strips addresses (including partial hex like `0x02323`), local contact names,
 * exact/fiat amounts, and niche token symbols into an ephemeral in-memory map
 * before any text leaves the device. Uses interval selection to make nested
 * placeholder re-matching impossible.
 */
export function redactPrompt(input: string, ctx: RedactionContext): RedactionResult {
  const spans: Span[] = [];
  const liquid = ctx.knownLiquidTickers ?? DEFAULT_LIQUID_TICKERS;

  // Priority 1: Addresses — Miden bech32 (including partial prefixes), hex (4+ hex chars), ENS, BTC/Solana literals.
  const addrPatterns = [
    /\b(?:mm1|mtst1|mdev1|mlcl1)[0-9a-zA-Z_]{4,}\b/g,
    /\b0x[0-9a-fA-F]{4,}\b/gi,
    /\b[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9-]{2,})*\.eth\b/gi,
    /\bbc1[ac-hj-np-z02-9]{11,71}\b/gi,
    /\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b/g,
    /\b(?=[1-9A-HJ-NP-Za-km-z]{32,44}\b)(?=.*\d)(?=.*[A-Z])[1-9A-HJ-NP-Za-km-z]{32,44}\b/g
  ];
  for (const rx of addrPatterns) {
    for (const match of input.matchAll(rx)) {
      const raw = match[0];
      const start = match.index ?? 0;
      spans.push({ start, end: start + raw.length, priority: 1, kind: 'ADDR', raw });
    }
  }

  // Priority 2: Local contacts (longest match first, skipping reserved keywords).
  const sortedContacts = [...ctx.contacts]
    .filter(c => {
      const name = c.name.trim();
      return name.length >= 2 && !RESERVED_CONTACT_WORDS.has(name.toLowerCase());
    })
    .sort((a, b) => b.name.trim().length - a.name.trim().length);
  for (const contact of sortedContacts) {
    const trimmed = contact.name.trim();
    const rx = new RegExp(escapeRegExp(trimmed), 'gi');
    for (const match of input.matchAll(rx)) {
      const start = match.index ?? 0;
      const end = start + match[0].length;
      if (!isWordBoundaryChar(input[start - 1]) || !isWordBoundaryChar(input[end])) continue;
      spans.push({ start, end, priority: 2, kind: 'CONTACT', raw: match[0], contact });
    }
  }

  // Priority 3: Fiat amounts (`$100`, `$12.50`, `100 usd`).
  const dollarRx = /\$\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?![A-Za-z0-9_])/g;
  for (const match of input.matchAll(dollarRx)) {
    const start = match.index ?? 0;
    const numeric = `${match[1]!.replace(/,/g, '')}${match[2] ? `.${match[2]}` : ''}`;
    spans.push({ start, end: start + match[0].length, priority: 3, kind: 'FIAT_AMT', raw: numeric });
  }
  const usdSuffixRx = /\b(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*(?:usd|dollars?)\b/gi;
  for (const match of input.matchAll(usdSuffixRx)) {
    const start = match.index ?? 0;
    const numeric = `${match[1]!.replace(/,/g, '')}${match[2] ? `.${match[2]}` : ''}`;
    spans.push({ start, end: start + match[0].length, priority: 3, kind: 'FIAT_AMT', raw: numeric });
  }

  // Track time-window numbers like "last 7 days" or "7d" so ledger queries remain parseable.
  const timeWindowProtected = new Set<number>();
  for (const match of input.matchAll(/\b(?:last|past)\s+(\d+)\s+(?:day|days|week|weeks|month|months)\b/gi)) {
    const numStart = (match.index ?? 0) + match[0].indexOf(match[1]!);
    timeWindowProtected.add(numStart);
  }

  // Priority 4: Exact numeric amounts (excluding explicit percentages like `50%` and time-window digits).
  const numRx = /(?<![A-Za-z0-9_.$])(?:(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?|\.(\d+))(?![A-Za-z0-9_%])/g;
  for (const match of input.matchAll(numRx)) {
    const start = match.index ?? 0;
    if (timeWindowProtected.has(start)) continue;
    const numeric = match[3] ? `0.${match[3]}` : `${match[1]!.replace(/,/g, '')}${match[2] ? `.${match[2]}` : ''}`;
    spans.push({ start, end: start + match[0].length, priority: 4, kind: 'AMT', raw: numeric });
  }

  // Priority 5: Held niche tokens outside the liquid ticker allowlist.
  const nicheTokens = [...(ctx.heldNicheTickers ?? [])]
    .filter(tok => tok.symbol.trim().length >= 2 && !liquid.has(tok.symbol.trim().toUpperCase()))
    .sort((a, b) => b.symbol.trim().length - a.symbol.trim().length);
  for (const token of nicheTokens) {
    const rx = new RegExp(`\\b${escapeRegExp(token.symbol.trim())}\\b`, 'gi');
    for (const match of input.matchAll(rx)) {
      const start = match.index ?? 0;
      spans.push({ start, end: start + match[0].length, priority: 5, kind: 'TOKEN', raw: match[0], token });
    }
  }

  // Resolve overlaps deterministically: higher priority (lower number) wins, then earlier start, then longer span.
  spans.sort((a, b) => a.priority - b.priority || a.start - b.start || b.end - b.start - (a.end - a.start));
  const chosen: Span[] = [];
  for (const candidate of spans) {
    if (chosen.some(existing => candidate.start < existing.end && candidate.end > existing.start)) continue;
    chosen.push(candidate);
  }
  chosen.sort((a, b) => a.start - b.start);

  const map: RedactionMap = {
    addrs: {},
    contacts: {},
    amounts: {},
    fiatAmounts: {},
    tokens: {}
  };
  const counters: Record<RedactedKind, number> = {
    ADDR: 0,
    CONTACT: 0,
    AMT: 0,
    FIAT_AMT: 0,
    TOKEN: 0
  };
  const summarySet = new Set<RedactedKind>();
  const addrReverse = new Map<string, string>();
  const contactReverse = new Map<string, string>();
  const tokenReverse = new Map<string, string>();

  let out = '';
  let cursor = 0;

  for (const span of chosen) {
    out += input.slice(cursor, span.start);
    let key: string;
    switch (span.kind) {
      case 'ADDR': {
        const existing = addrReverse.get(span.raw);
        if (existing) {
          key = existing;
        } else {
          counters.ADDR += 1;
          key = `ADDR_${counters.ADDR}`;
          map.addrs[key] = span.raw;
          addrReverse.set(span.raw, key);
        }
        break;
      }
      case 'CONTACT': {
        const existing = contactReverse.get(span.contact!.id);
        if (existing) {
          key = existing;
        } else {
          counters.CONTACT += 1;
          key = `CONTACT_${counters.CONTACT}`;
          map.contacts[key] = span.contact!;
          contactReverse.set(span.contact!.id, key);
        }
        break;
      }
      case 'FIAT_AMT': {
        counters.FIAT_AMT += 1;
        key = `FIAT_AMT_${counters.FIAT_AMT}`;
        map.fiatAmounts[key] = span.raw;
        break;
      }
      case 'AMT': {
        counters.AMT += 1;
        key = `AMT_${counters.AMT}`;
        map.amounts[key] = span.raw;
        break;
      }
      case 'TOKEN': {
        const existing = tokenReverse.get(span.token!.tokenId);
        if (existing) {
          key = existing;
        } else {
          counters.TOKEN += 1;
          key = `TOKEN_${counters.TOKEN}`;
          map.tokens[key] = span.token!;
          tokenReverse.set(span.token!.tokenId, key);
        }
        break;
      }
    }
    summarySet.add(span.kind);
    out += `<${key}>`;
    cursor = span.end;
  }
  out += input.slice(cursor);

  return {
    redactedText: out,
    map,
    redactedTokensSummary: [...summarySet]
  };
}

function verifyAmountRef(amount: AmountExpr | null, map: RedactionMap): boolean {
  if (!amount) return true;
  if (amount.kind === 'exact_ref') {
    const key = normalizePlaceholderRef(amount.ref);
    return key in map.amounts || key in map.fiatAmounts;
  }
  if (amount.kind === 'fiat_ref') {
    const key = normalizePlaceholderRef(amount.ref);
    return key in map.fiatAmounts || key in map.amounts;
  }
  return true;
}

function verifyTokenRef(asset: string | null, map: RedactionMap): boolean {
  if (!asset) return true;
  const key = normalizePlaceholderRef(asset);
  if (/^TOKEN_\d+$/.test(key)) return key in map.tokens;
  return true;
}

function verifyRecipientRef(ref: string | null, map: RedactionMap): boolean {
  if (!ref) return true;
  const key = normalizePlaceholderRef(ref);
  return key in map.addrs || key in map.contacts;
}

/**
 * Ensures every placeholder reference emitted by the LLM actually originated
 * from the client-side redaction map (blocks hallucinated or injected refs).
 */
export function verifyProvenance(output: AiCompilerOutput, map: RedactionMap): boolean {
  switch (output.op) {
    case 'set_intent':
      return (
        verifyAmountRef(output.amount, map) &&
        verifyRecipientRef(output.recipient_ref, map) &&
        verifyTokenRef(output.asset, map) &&
        verifyTokenRef(output.to_asset, map)
      );
    case 'patch_slots':
      return (
        verifyAmountRef(output.patch.amount, map) &&
        verifyRecipientRef(output.patch.recipient_ref, map) &&
        verifyTokenRef(output.patch.asset, map) &&
        verifyTokenRef(output.patch.to_asset, map)
      );
    case 'query_ledger':
      return (
        verifyTokenRef(output.asset, map) &&
        (output.counterparty_ref === null || verifyRecipientRef(output.counterparty_ref, map))
      );
    case 'cancel':
    case 'unsupported':
      return true;
  }
}

export function resolveAmountRef(ref: string, map: RedactionMap): string | undefined {
  const key = normalizePlaceholderRef(ref);
  return map.amounts[key] ?? map.fiatAmounts[key];
}

export function resolveRecipientRef(
  ref: string,
  map: RedactionMap
): { kind: 'addr'; raw: string } | { kind: 'contact'; contact: RedactionContact } | undefined {
  const key = normalizePlaceholderRef(ref);
  if (key in map.addrs) return { kind: 'addr', raw: map.addrs[key]! };
  if (key in map.contacts) return { kind: 'contact', contact: map.contacts[key]! };
  return undefined;
}

export function resolveAssetRef(asset: string, map: RedactionMap): string {
  const key = normalizePlaceholderRef(asset);
  return map.tokens[key]?.symbol ?? asset;
}

export function resolveNicheTokenId(asset: string, map: RedactionMap): string | undefined {
  const key = normalizePlaceholderRef(asset);
  return map.tokens[key]?.tokenId;
}

export function mergeRedactionMaps(base: RedactionMap, delta: RedactionMap): RedactionMap {
  return {
    addrs: { ...base.addrs, ...delta.addrs },
    contacts: { ...base.contacts, ...delta.contacts },
    amounts: { ...base.amounts, ...delta.amounts },
    fiatAmounts: { ...base.fiatAmounts, ...delta.fiatAmounts },
    tokens: { ...base.tokens, ...delta.tokens }
  };
}
