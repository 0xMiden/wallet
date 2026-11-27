/**
 * @jest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import helpFacts from '../../src/lib/command-ai/help-facts.json';
import { redactPrompt } from '../../src/lib/command-ai/redactor';
import { parseAiCompilerOutput } from '../../src/lib/command-ai/schema';
import { type HelpDataset, explainReply } from '../../services/command-ai/src/help';
import helpCards from '../../services/command-ai/src/help-cards.json';
import {
  COMMAND_AI_JSON_SCHEMA,
  type Env,
  type HelpTrace,
  SYSTEM_PROMPT,
  createService
} from '../../services/command-ai/src/index';
import shippedTitles from './help-titles-1.18.2.json';

const data = helpCards as unknown as HelpDataset;
const topics = Object.keys(helpFacts.topics);
const card = (id: string) => data.cards.find(c => c.id === id)!;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

const env: Env = {
  ALLOWED_ORIGINS: '[]',
  GROQ_API_KEY: 'test-groq-key',
  COMMAND_AI_RATE_LIMIT: { limit: async () => ({ success: true }) }
};

const SECRET = 'zebra-quartz request text';
let logs: ReturnType<typeof jest.spyOn>[] = [];

beforeEach(() => {
  logs = (['info', 'warn', 'error', 'log'] as const).map(level =>
    jest.spyOn(console, level).mockImplementation(() => {})
  );
});
afterEach(() => {
  expect(JSON.stringify(logs.flatMap(spy => spy.mock.calls))).not.toContain('zebra');
  jest.restoreAllMocks();
});

const reply = (output: unknown) => Response.json({ choices: [{ message: { content: JSON.stringify(output) } }] });

function setup(output: unknown) {
  const fetchMock = jest.fn<typeof fetch>(async () => reply(output));
  const traces: HelpTrace[] = [];
  const service = createService({ fetchImpl: fetchMock, onTrace: trace => traces.push(trace) });
  return { fetchMock, traces, service };
}

async function compile(service: ReturnType<typeof createService>, body: object) {
  const response = await service.fetch(
    new Request('https://command-ai.test/v1/compile', { method: 'POST', body: JSON.stringify(body) }),
    env
  );
  return { status: response.status, body: (await response.json()) as { output?: unknown } };
}

const upstream = (fetchMock: ReturnType<typeof setup>['fetchMock']) =>
  String((fetchMock.mock.calls[0]?.[1] as RequestInit).body);

describe('command safety', () => {
  it('keeps the command prompt and schema', () => {
    expect(sha256(JSON.stringify([SYSTEM_PROMPT, COMMAND_AI_JSON_SCHEMA]))).toBe(
      '9d057402a7fbb492b58838f797c5d0e85631afe74d75761526c7def184171c1c'
    );
  });

  it('sends a request without a help context unchanged', async () => {
    const { fetchMock, service } = setup({ result: { op: 'cancel' } });
    await compile(service, { redactedText: 'cancel' });
    expect(sha256(upstream(fetchMock))).toBe('3e19f349713947ad40a5c33037e0f93df88a7a3faf1468a8d6680da5a7423f26');
  });

  const slots = {
    action: 'send',
    amount: null,
    asset: null,
    to_asset: null,
    from_chain: null,
    to_chain: null,
    recipient_ref: null,
    provider: null,
    note_type: null,
    earn_op: null
  };
  const commands = [
    { op: 'set_intent', ...slots },
    { op: 'set_plan', steps: [slots, slots] },
    { op: 'patch_slots', patch: slots },
    { op: 'query_ledger', query: 'balance', asset: null, counterparty_ref: null, direction: 'all', window: 'today' },
    { op: 'cancel' },
    { op: 'unsupported', reason: 'No NFTs.', suggested_route: null }
  ];

  it.each(commands.flatMap(command => [{ result: command }, command]))(
    'returns the command %j unchanged after one call',
    async output => {
      const { fetchMock, traces, service } = setup(output);
      const response = await compile(service, { redactedText: SECRET, helpContext: null });
      expect(response).toEqual({ status: 200, body: { output } });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(traces).toEqual([{ path: 'command', picked: [], unknownIds: [], served: null }]);
    }
  );
});

describe('help replies', () => {
  const ask = async (output: unknown, redactedText = SECRET) => {
    const run = setup(output);
    return { ...run, response: await compile(run.service, { redactedText, helpContext: null }) };
  };

  it.each([true, false])('serves the selected card (wrapped: %s)', async wrapped => {
    const result = { op: 'help', cards: ['guardian_what', 'guardian_why'] };
    const { response, traces } = await ask(wrapped ? { result } : result);
    expect(response.body).toEqual({ output: explainReply(card('guardian_what')) });
    expect(traces).toEqual([{ path: 'card', picked: result.cards, unknownIds: [], served: 'guardian_what' }]);
  });

  it('serves a fixed card ranked second', async () => {
    const { response } = await ask({ result: { op: 'help', cards: ['guardian_what', 'phrase_exposed'] } });
    expect(response.body).toEqual({ output: explainReply(card('phrase_exposed')) });
  });

  it('drops unknown ids and reports them only to the trace', async () => {
    const { response, traces } = await ask({ result: { op: 'help', cards: ['made_up_card', 'usdcx'] } });
    expect(response.body).toEqual({ output: explainReply(card('usdcx')) });
    expect(JSON.stringify(response.body)).not.toContain('made_up_card');
    expect(traces[0]).toMatchObject({ unknownIds: ['made_up_card'], served: 'usdcx' });
  });

  it.each([[['made_up_card']], [[]], ['guardian_what']])('says it does not know for %j', async cards => {
    const { response, traces } = await ask({ result: { op: 'help', cards } });
    expect(response.body).toEqual({ output: explainReply(card('not_covered')) });
    expect(traces[0]).toMatchObject({ path: 'unknown', served: 'not_covered' });
  });

  const freeText = { op: 'explain', topic: 'Wallet', answer: 'A Guardian is a friend you pick.' };

  it.each([{ result: freeText }, freeText, { ...freeText, result: { op: 'cancel' } }])(
    'never forwards model text %j',
    async output => {
      const { response } = await ask(output);
      expect(response.body).toEqual({ output: explainReply(card('not_covered')) });
      expect(JSON.stringify(response.body)).not.toContain('friend you pick');
    }
  );

  it.each([{ op: 'help', cards: ['usdcx'] }, freeText])(
    'leaves a pending question alone for a placeholder-only message %j',
    async result => {
      const { response, traces } = await ask({ result }, '<AMT_1>');
      const output = { op: 'unsupported', reason: '', suggested_route: null };
      expect(response.body).toEqual({ output });
      expect(parseAiCompilerOutput(output)).toEqual(output);
      expect(traces[0]).toMatchObject({ path: 'placeholder', served: null });
    }
  );

  it('only ever emits a dataset answer, whatever id the router returns', async () => {
    const wrong: string[] = [];
    for (const { id } of data.cards) {
      const { response } = await ask({ result: { op: 'help', cards: [id] } });
      if (JSON.stringify(response.body.output) !== JSON.stringify(explainReply(card(id)))) wrong.push(id);
    }
    expect(wrong).toEqual([]);
  });

  it('asks the provider for card ids, not text', async () => {
    const { fetchMock } = await ask({ result: { op: 'cancel' } });
    const { response_format: format } = JSON.parse(upstream(fetchMock));
    const schema = JSON.stringify(format);
    expect(schema).toContain('"help"');
    expect(schema).not.toContain('"explain"');
  });

  it('uses the dataset it is given', async () => {
    const dataset = { ...data, cards: data.cards.map(c => ({ ...c, answer: `swapped ${c.id}` })) };
    const service = createService({ fetchImpl: async () => reply({ op: 'help', cards: ['usdcx'] }), dataset });
    const response = await compile(service, { redactedText: SECRET, helpContext: null });
    expect(response.body.output).toMatchObject({ answer: 'swapped usdcx' });
  });

  it.each<[number, () => Promise<Response>]>([
    [429, async () => new Response(null, { status: 429 })],
    [502, async () => new Response(null, { status: 500 })],
    [502, async () => Response.json({ choices: [{ message: { content: '{not-json' } }] })],
    [
      504,
      async () => {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
    ]
  ])('keeps status %i for a failed router call', async (status, fetchImpl) => {
    const response = await compile(createService({ fetchImpl }), { redactedText: SECRET, helpContext: null });
    expect(response.status).toBe(status);
  });
});

describe('topic buttons', () => {
  const root = path.resolve(__dirname, '../../public/_locales');
  const locales = readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
  const titles = topics.flatMap(topic => [
    ...locales.map(locale => {
      const messages = JSON.parse(readFileSync(path.join(root, locale, `${locale}.json`), 'utf8'));
      return { topic, locale, title: String(messages[`commandAiHelp${topic}Title`]) };
    }),
    ...shippedTitles[topic as keyof typeof shippedTitles].map(title => ({ topic, locale: '1.18.2', title }))
  ]);
  // Contact names that are also words in button titles.
  const contacts = ['Bread', 'notes', 'device', 'private', 'payment', 'bridge', 'fees', 'accept', 'wallet', 'safe'].map(
    name => ({ id: name, name, address: 'mtst1ap2t7nsjausqsgr57c58s2nqqg9f8m62' })
  );

  async function press(topic: string, redactedText: string) {
    const { fetchMock, traces, service } = setup({ result: { op: 'cancel' } });
    const response = await compile(service, { redactedText, helpContext: topic });
    return { response, calls: fetchMock.mock.calls.length, traces };
  }

  it('answers all 14 titles in 14 locales without a provider call', async () => {
    expect(new Set(titles.map(t => t.locale)).size).toBe(15);
    const wrong: string[] = [];
    for (const { topic, locale, title } of titles) {
      const { response, calls, traces } = await press(topic, title);
      const expected = card(data.buttons[topic]!.card);
      const served = JSON.stringify(response.body.output) === JSON.stringify(explainReply(expected));
      if (!served || calls !== 0 || traces[0]?.path !== 'button') wrong.push(`${topic} ${locale}`);
    }
    expect(wrong).toEqual([]);
  });

  it('answers redacted titles, and asks the router only when too little of the title is left', async () => {
    let redacted = 0;
    const routed: string[] = [];
    for (const { topic, locale, title } of titles) {
      const { redactedText } = redactPrompt(title, { contacts });
      if (redactedText === title) continue;
      redacted += 1;
      const { response, calls } = await press(topic, redactedText);
      if (calls === 0) {
        expect(response.body.output).toEqual(explainReply(card(data.buttons[topic]!.card)));
      } else {
        routed.push(`${topic} ${locale}: ${redactedText}`);
      }
    }
    expect(redacted).toBeGreaterThan(0);
    // A contact named like the one subject word of a short title leaves too little to match.
    expect(routed).toEqual([
      'Notes de: Was sind <CONTACT_1>?',
      'Notes en: What are <CONTACT_1>?',
      'Notes en_GB: What are <CONTACT_1>?',
      'Notes ja: <CONTACT_1>とは何ですか？',
      'Notes ko: <CONTACT_1>란 무엇인가요?',
      'Notes pl: Czym są <CONTACT_1>?',
      'Notes pt: O que são <CONTACT_1>?',
      'Notes ru: Что такое <CONTACT_1>?',
      'Notes tr: <CONTACT_1> nedir?',
      'Notes uk: Що таке <CONTACT_1>?',
      'Notes zh_CN: 什么是<CONTACT_1>？',
      'Notes zh_TW: 什麼是<CONTACT_1>？',
      'Notes 1.18.2: Was sind <CONTACT_1>?',
      'Notes 1.18.2: What are <CONTACT_1>?',
      'Notes 1.18.2: <CONTACT_1>とは何ですか？',
      'Notes 1.18.2: <CONTACT_1>란 무엇인가요?',
      'Notes 1.18.2: Czym są <CONTACT_1>?',
      'Notes 1.18.2: O que são <CONTACT_1>?',
      'Notes 1.18.2: Что такое <CONTACT_1>?',
      'Notes 1.18.2: <CONTACT_1> nedir?',
      'Notes 1.18.2: Що таке <CONTACT_1>?',
      'Notes 1.18.2: 什么是<CONTACT_1>？',
      'Notes 1.18.2: 什麼是<CONTACT_1>？',
      'Wallet zh_CN: 在 <CONTACT_1> 中我可以做什么？',
      'Wallet zh_TW: 在 <CONTACT_1> 中我可以做什麼？',
      'Wallet 1.18.2: 在 <CONTACT_1> 中我可以做什么？',
      'Wallet 1.18.2: 在 <CONTACT_1> 中我可以做什麼？'
    ]);
  });

  it('does not match a title under another topic', async () => {
    const { calls } = await press('Notes', shippedTitles.Recovery[0]!);
    expect(calls).toBe(1);
  });
});
