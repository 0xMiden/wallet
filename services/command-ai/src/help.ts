export type CardMode = 'write' | 'checked' | 'fixed';

export interface HelpCard {
  id: string;
  pick: string;
  topic: string;
  kind: 'explain' | 'problem';
  mode: CardMode;
  urgent: boolean;
  lead: string[];
  facts: string[];
  limit: string[];
  required: string[];
  forbid: string[];
  answer: string;
}

/** Which cards may be answered in written text. `cards: []` turns writing off. */
export interface WritingConfig {
  writer: string;
  checker: string;
  cards: string[];
}

export interface HelpDataset {
  writing: WritingConfig;
  forbid: string[];
  buttons: Record<string, { card: string; titles: string[] }>;
  facts: Record<string, { text: string; src: string[] }>;
  cards: HelpCard[];
}

export const HELP_RULES = `Help:
- For a question about Bread, Miden or a feature, a problem report, or anything about safety or lost
  access, return help with up to 2 card ids, best first. If no card answers it, use not_covered, not
  unsupported. For an error or money problem that no card matches, use cannot_diagnose.
- How to do something is help; asking to do it is an action; what the user already did is a ledger
  query. For mixed help and action, return help only.
- A card must state the fact asked, not just share its subject; else not_covered.
- In help, a question never gets unsupported, trivia and phrase export included. unsupported is only
  for asking Bread to do something it cannot do.
- <AMT_n> hides any number, including a word count, days or a time.
- "cancel" or "never mind" is cancel. Asking to cancel or get back a payment already sent is help.
- A short reply that could answer a pending question (a name, address, amount, "public", "private",
  "the first one", a network or provider) is not help. A bare amount or provider choice can use
  patch_slots.
- previousHelpTopic only resolves follow-up references.
- When several apply, order them: a secret asked for or exposed, a destructive step, a possible
  double payment, an explanation.
Cards:`;

export function buildHelpPrompt(system: string, data: HelpDataset): string {
  return `${system}\n\n${HELP_RULES}\n${data.cards.map(({ id, pick }) => `${id}: ${pick}`).join('\n')}`;
}

const PLACEHOLDER = /<[A-Z_]+_\d+>/g;
const normalize = (text: string) => text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

export function matchTopicButton(text: string, topic: string | null, data: HelpDataset): HelpCard | undefined {
  const button = topic === null ? undefined : data.buttons[topic];
  if (!button) return undefined;
  const wanted = normalize(text);
  // Adjacent placeholders are one gap. The input is untrusted, and each further gap multiplies regex backtracking.
  const parts = wanted.split(/(?:<[a-z_]+_\d+>)+/);
  if (parts.length > 4) return undefined;
  const literal = parts.join('').length;
  const pattern = new RegExp(`^${parts.map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.+?')}$`);
  const matches = button.titles.some(raw => {
    const title = normalize(raw);
    return literal >= 0.7 * title.length && literal <= title.length && pattern.test(title);
  });
  return matches ? data.cards.find(card => card.id === button.card) : undefined;
}

export const isPlaceholderOnly = (text: string): boolean =>
  text.search(PLACEHOLDER) >= 0 && /^[\s\p{P}\p{S}]*$/u.test(text.replace(PLACEHOLDER, ''));

const UNKNOWN = new Set(['not_covered', 'cannot_diagnose']);

/** The cards a router pick may be answered from, best first: one that wins alone, or up to two. */
export function selectCards(ids: unknown, data: HelpDataset): HelpCard[] {
  const byId = new Map(data.cards.map(card => [card.id, card]));
  const known = [...new Set<unknown>(Array.isArray(ids) ? ids : [])]
    .flatMap(id => byId.get(id as string) ?? [])
    .slice(0, 2);
  const alone =
    known.find(card => card.urgent) ??
    known.find(card => card.mode === 'fixed' && !UNKNOWN.has(card.id)) ??
    (known[0] && UNKNOWN.has(known[0].id) ? known[0] : undefined);
  if (alone) return [alone];
  const kept = known.filter(card => !UNKNOWN.has(card.id));
  return kept.length > 0 ? kept : [byId.get('not_covered')!];
}

export const selectCard = (ids: unknown, data: HelpDataset): HelpCard => selectCards(ids, data)[0]!;

export function explainReply(card: HelpCard): { op: 'explain'; topic: string; answer: string } {
  return { op: 'explain', topic: card.topic, answer: card.answer };
}
