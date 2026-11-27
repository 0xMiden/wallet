/**
 * @jest-environment node
 */
import { describe, expect, it } from '@jest/globals';

import { redactPrompt } from '../../src/lib/command-ai/redactor';
import {
  HELP_RULES,
  type CardMode,
  type HelpCard,
  type HelpDataset,
  buildHelpPrompt,
  explainReply,
  isPlaceholderOnly,
  isTypedReply,
  matchTopicButton,
  selectCard,
  selectCards
} from '../../services/command-ai/src/help';
import context from './eval-context.json';
import helpEval from './help-eval.json';
import shippedTitles from './help-titles-1.18.2.json';
import questions from './questions.json';

const card = (id: string, mode: CardMode, urgent = false): HelpCard => ({
  id,
  pick: `pick ${id}`,
  topic: 'Wallet',
  kind: 'explain',
  mode,
  urgent,
  lead: [],
  facts: [],
  limit: [],
  required: [],
  forbid: [],
  answer: `answer ${id}`
});

const data: HelpDataset = {
  writing: { writer: 'w', checker: 'c', cards: [] },
  forbid: [],
  buttons: {
    Recovery: { card: 'w1', titles: ['What if I lose my device?', 'デバイスを紛失したら？'] },
    Notes: { card: 'w2', titles: ['What are notes?'] }
  },
  facts: {},
  cards: [
    card('w1', 'write'),
    card('w2', 'write'),
    card('c1', 'checked'),
    card('f1', 'fixed'),
    card('u1', 'fixed', true),
    card('not_covered', 'fixed'),
    card('cannot_diagnose', 'fixed')
  ]
};

describe('selectCard', () => {
  it.each<[unknown, string]>([
    [['w1', 'w2'], 'w1'],
    [['w1', 'u1'], 'u1'],
    [['w1', 'f1'], 'f1'], // fixed wins when second
    [['f1', 'u1'], 'u1'],
    [['w1', 'c1'], 'w1'], // checked has no precedence
    [['c1', 'w1'], 'c1'],
    [['w1', 'not_covered'], 'w1'],
    [['w1', 'cannot_diagnose'], 'w1'],
    [['not_covered', 'w1'], 'not_covered'],
    [['cannot_diagnose', 'w1'], 'cannot_diagnose'],
    [['not_covered', 'f1'], 'f1'],
    [['nope', 'w2'], 'w2'],
    [['w1', 'w1', 'f1'], 'f1'],
    [['w1', 'w2', 'f1'], 'w1'], // only the first two distinct known ids
    [[], 'not_covered'],
    ['w1', 'not_covered'],
    [[7, null], 'not_covered']
  ])('selects %j', (ids, id) => {
    expect(selectCard(ids, data).id).toBe(id);
    expect(selectCards(ids, data)[0]?.id).toBe(id);
  });

  it.each<[string[], string[]]>([
    [
      ['w1', 'w2'],
      ['w1', 'w2']
    ],
    [
      ['w2', 'w1'],
      ['w2', 'w1']
    ],
    [
      ['w1', 'c1'],
      ['w1', 'c1']
    ],
    [['w1', 'not_covered'], ['w1']],
    [['not_covered', 'w1'], ['not_covered']],
    [['w1', 'f1'], ['f1']],
    [['w1', 'u1'], ['u1']],
    [['nope', 'w2'], ['w2']],
    [
      ['w1', 'w2', 'c1'],
      ['w1', 'w2']
    ],
    [[], ['not_covered']]
  ])('keeps at most two cards for %j', (ids, kept) => expect(selectCards(ids, data).map(({ id }) => id)).toEqual(kept));
});

describe('matchTopicButton', () => {
  const match = (text: string, topic: string | null) => matchTopicButton(text, topic, data)?.id;

  it('matches the requested topic title across case, spacing and width', () => {
    expect(match('What if I lose my device?', 'Recovery')).toBe('w1');
    expect(match('  what  IF i lose\nmy device? ', 'Recovery')).toBe('w1');
    expect(match('デバイスを紛失したら?', 'Recovery')).toBe('w1');
  });

  it('does not match another topic, no topic or other text', () => {
    expect(match('What if I lose my device?', 'Notes')).toBeUndefined();
    expect(match('What if I lose my device?', null)).toBeUndefined();
    expect(match('What if I lose my device?', 'Fees')).toBeUndefined();
    expect(match('What if I lose my device today?', 'Recovery')).toBeUndefined();
    expect(match('What if I lose my device.', 'Recovery')).toBeUndefined();
  });

  it('lets a placeholder stand for text when most of the title is literal', () => {
    expect(match('What if I lose my <CONTACT_1>?', 'Recovery')).toBe('w1');
    expect(match('What if <TOKEN_1> lose my <CONTACT_1>?', 'Recovery')).toBe('w1');
  });

  it.each([
    '<CONTACT_1>',
    'What <CONTACT_1>?',
    'What if I <TOKEN_1> my <CONTACT_1>?',
    `What if I lose my${' <AMT_1>'.repeat(200)} device?!`
  ])('does not match %s', text => expect(match(text, 'Recovery')).toBeUndefined());
});

it.each<[string, boolean]>([
  ['<AMT_1>', true],
  ['<CONTACT_1>?', true],
  ['<AMT_1> <ADDR_1>.', true],
  ['<FIAT_AMT_1> + <TOKEN_2>', true],
  ['<AMT_1> words', false],
  ['?', false],
  ['no', false]
])('reads %s as placeholders only: %s', (text, expected) => expect(isPlaceholderOnly(text)).toBe(expected));

// A help question read as a typed reply would be answered "unsupported" instead of its card.
it('reads no help question in the eval sets, and no topic button title, as a typed reply', () => {
  const asked = [...helpEval, ...questions].flatMap(item =>
    'cards' in item ? [String('q' in item ? item.q : item.prompt)] : []
  );
  const titles = Object.values(shippedTitles).flat();
  expect(asked.length).toBeGreaterThan(300);
  expect(titles.length).toBeGreaterThan(100);
  expect([...asked, ...titles].filter(text => isTypedReply(redactPrompt(text, context).redactedText))).toEqual([]);
});

describe('buildHelpPrompt', () => {
  it('appends the rules and one pick line per card to the system prompt', () => {
    const prompt = buildHelpPrompt('SYSTEM', data);
    expect(prompt.startsWith('SYSTEM\n\nHelp:\n')).toBe(true);
    expect(prompt.endsWith(`Cards:\n${data.cards.map(({ id, pick }) => `${id}: ${pick}`).join('\n')}`)).toBe(true);
  });

  it.each([
    'up to 2 card ids, best first',
    'cannot_diagnose',
    'How to do something is help',
    'Showing or getting your own address or QR code is set_intent receive',
    'A how-to question is help even when it names a token, chain or amount',
    'the fact asked',
    'never gets unsupported',
    'hides any number',
    '"cancel" or "never mind" is cancel',
    '"cancel my last payment" and getting back a sent payment are help',
    'could answer a pending question',
    'previousHelpTopic only resolves follow-up references',
    'a secret asked for or exposed'
  ])('states the rule: %s', phrase => expect(HELP_RULES.replace(/\s+/g, ' ')).toContain(phrase));

  it('keeps the rules within the token budget', () => expect(HELP_RULES.length).toBeLessThanOrEqual(1400));
});

it('builds the explain reply from the checked answer only', () => {
  expect(explainReply(card('w1', 'write'))).toEqual({ op: 'explain', topic: 'Wallet', answer: 'answer w1' });
});
