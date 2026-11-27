/**
 * @jest-environment node
 */
import { describe, expect, it } from '@jest/globals';
import { createHash } from 'node:crypto';

import helpFacts from '../../src/lib/command-ai/help-facts.json';
import { redactPrompt } from '../../src/lib/command-ai/redactor';
import { type HelpDataset } from '../../services/command-ai/src/help';
import helpCards from '../../services/command-ai/src/help-cards.json';
import evalContext from './eval-context.json';
import questions from './help-eval.json';

interface HelpCase {
  id: string;
  cluster: string;
  class: 'answerable' | 'near_miss' | 'out_of_scope' | 'action' | 'fragment';
  priority: 'P0' | 'P1' | 'P2';
  q: string;
  lang: string;
  helpContext: string | null;
  cards: string[];
  forbidCards: string[];
  split: 'dev' | 'regression';
  must: string[];
  mustNot: string[];
  benignHowTo?: true;
  numberVariant?: true;
  previousQuestion?: string;
  previousCard?: string;
  near?: string;
}

const cases = questions as unknown as HelpCase[];
const data = helpCards as unknown as HelpDataset;
const REQUIRED = 'id cluster class priority q lang helpContext cards forbidCards split must mustNot'.split(' ');
const OPTIONAL = 'benignHowTo numberVariant previousQuestion previousCard near'.split(' ');
const UNKNOWN = ['not_covered', 'cannot_diagnose'];
const urgent = data.cards.filter(card => card.urgent).map(card => card.id);

// The card groups of the dataset. Near misses must reach each of them.
const GROUPS = [
  'guardian_what guardian_why guardian_see guardian_funds guardian_who_cost guardian_switch guardian_down guardian_waiting',
  'lost_device recovery_phrase keys_explained lost_phrase lost_phrase_and_device forgot_password reset_reinstall no_guardian_found restore_missing wallet_file multi_device unlock_lock',
  'stay_safe secrets_scams phrase_exposed device_stolen unexpected_tokens',
  'send_receive send_addresses notes_what accept_why accept_auto accept_stuck decline pending_why send_not_arrived send_stuck_failed delivery_warning cancel_take_back wrong_address',
  'fees_usdcx no_usdcx usdcx money_missing',
  'privacy_overview privacy_check who_sees_payment validators delegated_proving swap_bridge_privacy',
  'bridge_what bridge_in bridge_out bridge_routes_limits connect_outside_wallet bridge_stuck bridge_deposit_locked swap_how swap_not_filled earn_what earn_problem',
  'miden_what miden_proofs accounts_addresses public_private_accounts finality_blocking mainnet_testnet',
  'bread_overview assistant_sees apps_connect platforms invite_code support_contact'
].map(group => group.split(' '));

const ids = (bad: (item: HelpCase) => boolean) => cases.filter(bad).map(item => item.id);
const ofCluster = (name: string) => cases.filter(item => item.cluster === name);
const ofClass = (name: HelpCase['class']) => cases.filter(item => item.class === name);
const splitOf = (cluster: string) =>
  parseInt(createHash('sha256').update(cluster).digest('hex').slice(0, 8), 16) % 100 < 15 ? 'regression' : 'dev';

it('uses unique ids and only the case fields', () => {
  expect(cases.length).toBeGreaterThan(0);
  expect(new Set(cases.map(item => item.id)).size).toBe(cases.length);
  expect(
    ids(
      item =>
        !REQUIRED.every(key => key in item) || Object.keys(item).some(key => ![...REQUIRED, ...OPTIONAL].includes(key))
    )
  ).toEqual([]);
  const classes = ['answerable', 'near_miss', 'out_of_scope', 'action', 'fragment'];
  expect(ids(item => !classes.includes(item.class) || !['P0', 'P1', 'P2'].includes(item.priority))).toEqual([]);
});

describe('card references', () => {
  it('names only existing cards', () => {
    const known = new Set(data.cards.map(card => card.id));
    expect(
      ids(item =>
        [...item.cards, ...item.forbidCards, item.near, item.previousCard].some(
          id => id !== undefined && !known.has(id)
        )
      )
    ).toEqual([]);
  });

  it('accepts cards exactly for answerable cases, never an unknown reply or a forbidden card', () => {
    expect(ids(item => (item.class === 'answerable') !== item.cards.length > 0)).toEqual([]);
    expect(ids(item => item.cards.some(id => UNKNOWN.includes(id) || item.forbidCards.includes(id)))).toEqual([]);
  });

  it('accepts every card in at least two cases', () => {
    const thin = data.cards.filter(
      card => !UNKNOWN.includes(card.id) && cases.filter(item => item.cards.includes(card.id)).length < 2
    );
    expect(thin.map(card => card.id)).toEqual([]);
  });

  // Accuracy is gated on dev and holdout only, so a card accepted only in regression cases is never measured.
  it('accepts every card in a dev case', () => {
    const measured = new Set(cases.filter(item => item.split === 'dev').flatMap(item => item.cards));
    expect(data.cards.map(card => card.id).filter(id => !UNKNOWN.includes(id) && !measured.has(id))).toEqual([]);
  });

  it('forbids at least one card on every P0 case', () => {
    expect(ids(item => item.priority === 'P0' && item.forbidCards.length === 0)).toEqual([]);
  });
});

// A cluster is one intent and is scored once, so merged intents hide each other's misses.
it('keeps one class and a commonly accepted card in each cluster', () => {
  const merged = [...new Set(cases.map(item => item.cluster))].filter(cluster => {
    const [first, ...rest] = ofCluster(cluster);
    const shared = first!.cards.filter(id => rest.every(item => item.cards.includes(id)));
    return rest.some(item => item.class !== first!.class) || (first!.class === 'answerable' && shared.length === 0);
  });
  expect(merged).toEqual([]);
});

it('splits by cluster hash, so sibling cases never straddle the sets', () => {
  expect(ids(item => item.split !== splitOf(item.cluster))).toEqual([]);
  const regression = new Set(cases.filter(item => item.split === 'regression').map(item => item.cluster));
  const share = regression.size / new Set(cases.map(item => item.cluster)).size;
  expect(share).toBeGreaterThan(0.08);
  expect(share).toBeLessThan(0.22);
});

it('survives redaction, which hides the number in every number variant', () => {
  const redacted = (item: HelpCase) => redactPrompt(item.q, evalContext).redactedText;
  expect(cases.filter(item => item.numberVariant).length).toBeGreaterThanOrEqual(8);
  expect(ids(item => redacted(item).trim() === '')).toEqual([]);
  expect(ids(item => item.numberVariant === true && !redacted(item).includes('<AMT_'))).toEqual([]);
});

it('gives follow-ups the topic of the previous accepted card', () => {
  const topics = Object.keys(helpFacts.topics);
  expect(ids(item => item.helpContext !== null && !topics.includes(item.helpContext))).toEqual([]);
  const followUps = cases.filter(item => item.helpContext !== null);
  expect(followUps.some(item => item.class === 'answerable')).toBe(true);
  expect(followUps.some(item => item.class !== 'answerable')).toBe(true);
  expect(
    ids(item => {
      const previous = data.cards.find(card => card.id === item.previousCard);
      return item.helpContext === null
        ? item.previousQuestion !== undefined || item.previousCard !== undefined
        : !item.previousQuestion || previous?.topic !== item.helpContext;
    })
  ).toEqual([]);
});

it('has near misses for every card group and urgent card, and plain out-of-scope questions', () => {
  const near = ofClass('near_miss');
  expect(near.length).toBeGreaterThanOrEqual(60);
  expect(ofClass('out_of_scope').length).toBeGreaterThanOrEqual(40);
  expect(near.filter(item => !item.near).map(item => item.id)).toEqual([]);
  expect(GROUPS.flat().sort()).toEqual(
    data.cards
      .map(card => card.id)
      .filter(id => !UNKNOWN.includes(id))
      .sort()
  );
  expect(GROUPS.filter(group => !near.some(item => group.includes(item.near ?? '')))).toEqual([]);
  expect(urgent.filter(id => !near.some(item => item.near === id))).toEqual([]);
});

it('guards each urgent card with at least two benign how-tos', () => {
  const benign = cases.filter(item => item.benignHowTo);
  expect(urgent).toHaveLength(7);
  expect(urgent.filter(id => benign.filter(item => item.forbidCards.includes(id)).length < 2)).toEqual([]);
  expect(benign.filter(item => item.cards.some(id => urgent.includes(id))).map(item => item.id)).toEqual([]);
});
