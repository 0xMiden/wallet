import { DEFAULT_LIQUID_TICKERS } from '../../../src/lib/command-ai/redactor';

const TOKEN_REF = /^<?(TOKEN_\d+)>?$/;
const PLACEHOLDERS = /<[A-Z_]+_\d+>/g;
const ASSETS = ['asset', 'to_asset'];
const ROUTE = [...ASSETS, 'from_chain', 'to_chain'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const lower = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : undefined);

/**
 * Whether app 1.18.2 could apply this follow-up reply and keep the id of the old token or route. It writes a new
 * symbol into its draft but replaces the token id only for a typed `<TOKEN_n>`, it looks the id up first, and a
 * bridge draft with a route id ignores asset and chain changes. The snapshot says nothing about which ids the draft
 * holds, so every change that could meet one counts. `scripts/command-ai-eval/follow-up.test.ts` proves each case.
 */
export function keepsStaleId(
  output: Record<string, unknown>,
  snapshot: Record<string, unknown>,
  utterance: string
): boolean {
  // The same unwrapping as the app's parser. Only a patch is applied over the old draft.
  const result = 'result' in output && Object.keys(output).length === 1 ? output.result : output;
  if (!isRecord(result) || result.op !== 'patch_slots' || !isRecord(result.patch)) return false;
  const { patch } = result;
  const draft = isRecord(snapshot.draft) ? snapshot.draft : {};
  const changes = (key: string) => patch[key] !== null && lower(patch[key]) !== lower(draft[key]);

  // A patch that changes nothing asks the same question again, dropping whatever the reply said.
  if (Object.values(patch).every(value => value === null)) return true;
  // A new action would carry the old one's ids with it.
  if (changes('action')) return true;
  if (draft.action === 'bridge' && ROUTE.some(changes)) return true;
  const replaced = ASSETS.some(key => {
    // No value yet means no id yet, and a token typed in this reply brings its own id.
    if (!patch[key] || !changes(key) || draft[key] === null) return false;
    const ref = TOKEN_REF.exec(String(patch[key]))?.[1];
    return !ref || !utterance.includes(`<${ref}>`);
  });
  if (replaced) return true;

  // A token the reply names but the patch leaves out would be dropped without a word. Only the pending pay token may
  // go unrepeated: it is what a typed amount is in.
  const known = [draft.asset, ...ASSETS.map(key => patch[key])].map(lower);
  const named = utterance.replace(PLACEHOLDERS, ' ').match(/[A-Za-z0-9]+/g) ?? [];
  if (named.some(word => DEFAULT_LIQUID_TICKERS.has(word.toUpperCase()) && !known.includes(word.toLowerCase()))) {
    return true;
  }
  const refs = ASSETS.map(key => TOKEN_REF.exec(String(patch[key]))?.[1]);
  return [...utterance.matchAll(/<(TOKEN_\d+)>/g)].some(match => !refs.includes(match[1]));
}
