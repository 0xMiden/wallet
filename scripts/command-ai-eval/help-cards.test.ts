/**
 * @jest-environment node
 */
import { describe, expect, it } from '@jest/globals';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import helpFacts from '../../src/lib/command-ai/help-facts.json';
import { parseAiCompilerOutput } from '../../src/lib/command-ai/schema';
import { hasUnsafeSharingAdvice } from '../../services/command-ai/src/help-safety.mjs';
import { type HelpCard, type HelpDataset, buildHelpPrompt, explainReply } from '../../services/command-ai/src/help';
import helpCards from '../../services/command-ai/src/help-cards.json';
import { SYSTEM_PROMPT } from '../../services/command-ai/src/index';
import shippedTitles from './help-titles-1.18.2.json';

const data = helpCards as unknown as HelpDataset;

// `id topic flags`: B topic button, P problem, C checked, F fixed, U urgent and fixed.
const EXPECTED = `
  guardian_what Wallet
  guardian_why Recovery
  guardian_see Wallet C
  guardian_funds Wallet
  guardian_who_cost Wallet
  guardian_switch Wallet
  guardian_down Pending P
  guardian_waiting Pending P
  lost_device Recovery B
  recovery_phrase Recovery
  keys_explained Recovery
  lost_phrase Recovery UP
  lost_phrase_and_device Recovery UP
  forgot_password Recovery UP
  reset_reinstall Safety UP
  no_guardian_found Recovery P
  restore_missing Recovery P
  wallet_file Recovery
  multi_device Recovery
  unlock_lock Wallet
  stay_safe Safety B
  secrets_scams Safety UP
  phrase_exposed Safety UP
  device_stolen Safety UP
  unexpected_tokens Safety P
  send_receive Wallet
  send_addresses Wallet
  notes_what Notes B
  accept_why Accept B
  accept_auto Accept
  accept_stuck Accept P
  decline Decline B
  pending_why Pending B
  send_not_arrived Pending P
  send_stuck_failed Pending FP
  delivery_warning Pending P
  cancel_take_back Pending P
  wrong_address Pending P
  fees_usdcx Fees B
  no_usdcx Fees P
  usdcx Fees
  money_missing Wallet P
  privacy_overview Privacy BC
  privacy_check Verify BC
  who_sees_payment Privacy C
  validators Privacy C
  delegated_proving Privacy C
  swap_bridge_privacy Privacy C
  bridge_what Bridge B
  bridge_in Bridge
  bridge_out Bridge
  bridge_routes_limits Bridge
  connect_outside_wallet Bridge P
  bridge_stuck Pending P
  bridge_deposit_locked Pending P
  swap_how Wallet
  swap_not_filled Pending P
  earn_what Wallet
  earn_problem Pending P
  miden_what Miden B
  miden_proofs Miden
  accounts_addresses Miden
  public_private_accounts Miden
  finality_blocking Wallet
  mainnet_testnet Network B
  bread_overview Wallet B
  assistant_sees Assistant B
  apps_connect Wallet
  platforms Wallet
  invite_code Wallet
  support_contact Wallet
  not_covered Wallet F
  cannot_diagnose Wallet FP
`
  .trim()
  .split('\n')
  .map(line => {
    const [id = '', topic = '', flags = ''] = line.trim().split(' ');
    return {
      id,
      topic,
      button: flags.includes('B'),
      kind: flags.includes('P') ? 'problem' : 'explain',
      mode: /[FU]/.test(flags) ? 'fixed' : flags.includes('C') ? 'checked' : 'write',
      urgent: flags.includes('U')
    };
  });

const FORBIDDEN = [
  String.raw`\b(is|are|stays?|remains?|fully|completely) (anonymous|untraceable|unlinkable)\b`,
  String.raw`\bend[- ]to[- ]end\b`,
  String.raw`\b(two|2) (of|out of) (the )?(three|3)\b`,
  String.raw`\bonly (you|the (recipient|receiver)) can (see|read|view)\b`,
  String.raw`\bsafe to (retry|resend|send (it )?again|try again)\b`,
  String.raw`\birreversible\b|\b(cannot|can't) be (reversed|undone)\b`,
  String.raw`\btrusted (person|friend|contact|family)\b`,
  String.raw`\bmove (all )?(your )?(money|funds) to (a new|another) account\b`
];

const UNKNOWN_ANSWERS = {
  not_covered:
    "I don't know the answer to that. For help with your wallet, go to support.miden.xyz. Never share your recovery phrase.",
  cannot_diagnose:
    "I can't tell what went wrong from here. Don't reset or delete Bread. If it was a payment, don't send it again while you are unsure what happened to it. Open it in Activity and read its message. For help, go to support.miden.xyz. Never share your recovery phrase."
};

const text = (id: string): string => data.facts[id]?.text ?? `(missing fact ${id})`;
const refs = (card: HelpCard) => [...card.lead, ...card.facts, ...card.limit];
const offenders = (bad: (card: HelpCard) => boolean) => data.cards.filter(bad).map(card => card.id);

it('has exactly the listed cards with their topics and flags', () => {
  const row = ({ id, topic, kind, mode, urgent }: Omit<(typeof EXPECTED)[number], 'button'>) =>
    `${id} ${topic} ${kind} ${mode}${urgent ? ' urgent' : ''}`;
  expect(data.cards.map(row).sort()).toEqual(EXPECTED.map(row).sort());
  const count = (mode: string) => data.cards.filter(card => card.mode === mode).length;
  expect({
    cards: data.cards.length,
    ids: new Set(data.cards.map(card => card.id)).size,
    fixed: count('fixed'),
    checked: count('checked'),
    write: count('write'),
    urgent: data.cards.filter(card => card.urgent).length
  }).toEqual({ cards: 73, ids: 73, fixed: 10, checked: 7, write: 56, urgent: 7 });
});

it('resolves every fact reference, uses every fact and cites a public source for each', () => {
  const used = new Set(data.cards.flatMap(refs));
  expect(
    data.cards.flatMap(card =>
      refs(card)
        .filter(id => !data.facts[id])
        .map(id => `${card.id}: ${id}`)
    )
  ).toEqual([]);
  expect(Object.keys(data.facts).filter(id => !used.has(id))).toEqual([]);
  const source = /^(https:\/\/|[a-z-]+@[0-9a-f]{7,40}:|owner:wallet#2359)/;
  expect(
    Object.entries(data.facts)
      .filter(([, fact]) => fact.src.length === 0 || !fact.src.every(src => source.test(src)))
      .map(([id]) => id)
  ).toEqual([]);
});

it('keeps pick lines short and unique and the help prompt within its budget', () => {
  expect(offenders(card => card.pick.length > 40)).toEqual([]);
  expect(offenders(card => data.cards.some(other => other !== card && other.pick === card.pick))).toEqual([]);
  expect(buildHelpPrompt(SYSTEM_PROMPT, data).length - SYSTEM_PROMPT.length).toBeLessThanOrEqual(5600);
});

it('places every required fact where it cannot be dropped', () => {
  expect(offenders(card => !card.required.every(id => refs(card).includes(id)))).toEqual([]);
  expect(
    offenders(
      card =>
        !card.required.every(id =>
          card.mode === 'write' ? [...card.lead, ...card.limit].includes(id) : card.answer.includes(text(id))
        )
    )
  ).toEqual([]);
});

it('opens each answer with its lead and keeps every limit', () => {
  expect(offenders(card => !card.answer.startsWith(card.lead.map(text).join(' ')))).toEqual([]);
  expect(offenders(card => !card.limit.every(id => card.answer.includes(text(id))))).toEqual([]);
  expect(offenders(card => card.mode === 'write' && card.kind === 'problem' && card.lead.length === 0)).toEqual([]);
  expect(offenders(card => [...card.lead, ...card.limit].map(text).join(' ').length > 300)).toEqual([]);
});

it('keeps every answer within what 1.18.2 shows and the sharing rules', () => {
  expect(offenders(card => card.answer.length > (card.urgent ? 750 : 600))).toEqual([]);
  expect(
    offenders(card => JSON.stringify(parseAiCompilerOutput(explainReply(card))) !== JSON.stringify(explainReply(card)))
  ).toEqual([]);
  expect(offenders(card => hasUnsafeSharingAdvice(explainReply(card)))).toEqual([]);
  expect(offenders(card => /^(Yes|No)[,.!:]/.test(card.answer))).toEqual([]);
});

describe('wording', () => {
  const matches = (patterns: string[], value: string) => patterns.some(p => new RegExp(p, 'i').test(value));

  it('has no forbidden claim', () => {
    expect(FORBIDDEN.filter(pattern => !data.forbid.includes(pattern))).toEqual([]);
    const forbidden = [...FORBIDDEN, ...data.forbid];
    expect(
      offenders(card => [card.answer, ...refs(card).map(text)].some(v => matches([...forbidden, ...card.forbid], v)))
    ).toEqual([]);
    expect(Object.keys(data.facts).filter(id => matches(forbidden, text(id)))).toEqual([]);
  });

  it('has no en or em dash', () => {
    const dash = /[\u2013\u2014]/;
    expect(offenders(card => dash.test(`${card.pick} ${card.answer}`))).toEqual([]);
    expect(Object.keys(data.facts).filter(id => dash.test(text(id)))).toEqual([]);
  });
});

describe('owner decisions', () => {
  const answer = (id: string) => data.cards.find(card => card.id === id)?.answer ?? '';

  it('explains a Guardian in the approved words and leaves its outage limit to the outage card', () => {
    expect(answer('guardian_what')).toBe(
      'In Bread, a Guardian is an online service, usually run by a company. It keeps a copy of your account data, so while it is online, you can get your account back on a new device with your recovery phrase. It is not a friend, relative or contact of yours. It must approve your payments along with your own key. It never receives your 12-word recovery phrase or private keys. It cannot move your money on its own. Assume the company running it can see your account and payments.'
    );
    for (const limit of [
      'your payments stop',
      'If you cannot switch, you may have to wait.',
      'A restore with only your 12 words cannot switch away from a Guardian that is down or refuses.'
    ])
      expect(answer('guardian_down')).toContain(limit);
  });

  it('never leaves open that support could recover funds', () => {
    const open = (value: string) =>
      value
        .split(/(?<=\.) /)
        .some(
          s =>
            /support\b.*\bcannot\b.*\brecover\b.*\b(funds|money)\b/i.test(s) &&
            !s.includes('recover funds on your behalf')
        );
    expect(offenders(card => open(card.answer))).toEqual([]);
  });

  it('never allows a repeat after only a look at Activity', () => {
    expect(offenders(card => /before (sending|placing)( it)? again/i.test(card.answer))).toEqual([]);
  });

  it('says on recovery cards that not everything may come back', () => {
    const honest =
      /(payments?|history)[^.]*\b(may not come back|may not bring back)\b|\bmay not bring back\b[^.]*\bhistory\b/;
    const cards = ['lost_device', 'recovery_phrase', 'forgot_password', 'reset_reinstall', 'restore_missing'];
    expect(cards.filter(id => !honest.test(answer(id)))).toEqual([]);
  });
});

it('answers unknown questions with the fixed text', () => {
  const answers = Object.fromEntries(
    Object.keys(UNKNOWN_ANSWERS).map(id => [id, data.cards.find(card => card.id === id)?.answer])
  );
  expect(answers).toEqual(UNKNOWN_ANSWERS);
});

it('maps each topic button to its card and lists every shipped and current title', () => {
  const root = path.resolve(__dirname, '../../public/_locales');
  const locales = readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => JSON.parse(readFileSync(path.join(root, entry.name, `${entry.name}.json`), 'utf8')));
  expect(locales).toHaveLength(14);
  const topics = Object.keys(helpFacts.topics);
  expect(Object.keys(data.buttons).sort()).toEqual([...topics].sort());
  const bad = topics.flatMap(topic => {
    const button = data.buttons[topic];
    const card = data.cards.find(c => c.id === button?.card);
    const expected = EXPECTED.find(row => row.button && row.topic === topic)?.id;
    if (!button || !card || card.id !== expected || card.topic !== topic) return [`${topic}: card ${button?.card}`];
    const titles = [
      ...shippedTitles[topic as keyof typeof shippedTitles],
      ...locales.map(locale => String(locale[`commandAiHelp${topic}Title`]))
    ];
    return titles.filter(title => !button.titles.includes(title)).map(title => `${topic}: ${title}`);
  });
  expect(bad).toEqual([]);
});
