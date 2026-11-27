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
import { type HelpDataset, buildHelpPrompt, explainReply } from '../../services/command-ai/src/help';
import { CHECKER_RULES, CHECKER_SCHEMA, WRITER_SCHEMA, writerInput } from '../../services/command-ai/src/help-write';
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

describe('clarification follow-ups', () => {
  const draft = { missingSlot: 'note_type', allowedOptionIds: ['private', 'public'], draft: { action: 'send' } };
  const patch = { op: 'patch_slots', patch: { note_type: 'public' } };
  const system = (fetchMock: ReturnType<typeof setup>['fetchMock']): string =>
    JSON.parse(upstream(fetchMock)).messages[0].content;

  // The provider refused every follow-up: the model returned the bare patch, which the schema's root does not allow.
  it('tells the model to wrap its reply and to list every patch key', async () => {
    const { fetchMock, service } = setup({ result: patch });
    await compile(service, { redactedText: SECRET, snapshot: draft });
    expect(system(fetchMock)).toBe(
      `${SYSTEM_PROMPT}\n\nAlways reply as {"result": <command>}, never the bare command. A patch_slots patch lists all of these keys, each unchanged one set to null: action, amount, asset, to_asset, from_chain, to_chain, recipient_ref, provider, note_type, earn_op.`
    );
    expect(JSON.parse(upstream(fetchMock)).max_completion_tokens).toBe(512);
  });

  it('fails the request when the provider refuses a bare reply', async () => {
    const { fetchMock, service } = setup({});
    fetchMock.mockImplementation(async () =>
      Response.json(
        { error: { code: 'json_validate_failed', failed_generation: JSON.stringify(patch) } },
        { status: 400 }
      )
    );
    expect((await compile(service, { redactedText: SECRET, snapshot: draft })).status).toBe(502);
  });

  it.each([
    [{}, SYSTEM_PROMPT],
    [{ helpContext: null }, buildHelpPrompt(SYSTEM_PROMPT, data)],
    [{ helpContext: 'Privacy' }, buildHelpPrompt(SYSTEM_PROMPT, data)]
  ])('adds nothing to a request without a snapshot: %j', async (context, expected) => {
    const { fetchMock, service } = setup({ result: { op: 'cancel' } });
    await compile(service, { redactedText: 'cancel', ...context });
    expect(system(fetchMock)).toBe(expected);
  });
});

describe('a first request the provider cannot shape', () => {
  // A bare "public" made the model return set_intent with a null action, which the schema refuses.
  const refused = { result: { op: 'set_intent', action: null, note_type: 'public' } };
  const refusal =
    (status: number, body: string = JSON.stringify({ error: { code: 'json_validate_failed' } })) =>
    async () =>
      new Response(body, { status });

  beforeEach(() => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it.each([{}, { helpContext: null }, { helpContext: 'Privacy' }])(
    'answers that it has no command, so the app goes on to its follow-up: %j',
    async context => {
      const { fetchMock, service, traces } = setup({});
      fetchMock.mockImplementation(
        refusal(
          400,
          JSON.stringify({ error: { code: 'json_validate_failed', failed_generation: JSON.stringify(refused) } })
        )
      );
      const response = await compile(service, { redactedText: 'public', ...context });
      const output = { op: 'unsupported', reason: '', suggested_route: null };
      expect(response).toMatchObject({ status: 200, body: { output } });
      expect(parseAiCompilerOutput(response.body.output)).toEqual(output);
      expect(traces).toEqual([{ path: 'refused', picked: [], unknownIds: [], served: null }]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(JSON.stringify((console.warn as jest.Mock).mock.calls)).toBe(
        JSON.stringify([[JSON.stringify({ event: 'compile_refused', model: 'openai/gpt-oss-120b' })]])
      );
    }
  );

  it.each([
    ['another provider code', refusal(400, JSON.stringify({ error: { code: 'invalid_request_error' } }))],
    ['a body that is not JSON', refusal(400, 'json_validate_failed')],
    ['no body', refusal(400, '')],
    ['a null body', refusal(400, 'null')],
    ['another status', refusal(500)]
  ])('still fails on %s', async (_name, fetchImpl) => {
    const response = await compile(createService({ fetchImpl }), { redactedText: 'public', helpContext: null });
    expect(response.status).toBe(502);
  });
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

  // The router answered a bare "epoch" with a help card in 3 of 3 live runs, and the app stops at a help card.
  it.each([
    'public',
    'Private.',
    'epoch',
    'ethereum',
    'agglayer',
    'the first one',
    'usdcx',
    'use epoch and make it <AMT_1>',
    'actually change the amount to <AMT_1>'
  ])('leaves a pending question alone for the typed reply %j', async text => {
    const { response, traces } = await ask({ result: { op: 'help', cards: ['bridge_what'] } }, text);
    expect(response.body).toEqual({ output: { op: 'unsupported', reason: '', suggested_route: null } });
    expect(traces[0]).toMatchObject({ path: 'placeholder', served: null });
  });

  it.each([
    'epoch?',
    'is it public',
    'what is epoch',
    'change my password',
    'reset my wallet',
    'make it',
    'change the amount',
    'the first payment'
  ])('still answers %j with its card', async text => {
    const { response } = await ask({ result: { op: 'help', cards: ['bridge_what'] } }, text);
    expect(response.body).toEqual({ output: explainReply(card('bridge_what')) });
  });

  it('passes a command for a typed reply through', async () => {
    const result = { op: 'cancel' };
    const { response } = await ask({ result }, 'epoch');
    expect(response.body).toEqual({ output: { result } });
  });

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

describe('written answers', () => {
  const ROUTER = 'openai/gpt-oss-120b';
  const SMALL = 'openai/gpt-oss-20b';
  const listed = (...cards: string[]): HelpDataset => ({ ...data, writing: { ...data.writing, cards } });
  const on = listed('guardian_what', 'guardian_why', 'guardian_down');

  const sentence = (id: string) => ({ facts: [id], text: data.facts[id]!.text });
  const draft = { answerable: true, sentences: [sentence('g.service')] };
  const written = {
    op: 'explain',
    topic: card('guardian_what').topic,
    answer: `${data.facts['g.service']!.text} ${data.facts['g.see']!.text}`
  };
  const yes = { supported: true, answers: true };

  const completion = (value: unknown, finish = 'stop') =>
    Response.json({ choices: [{ finish_reason: finish, message: { content: JSON.stringify(value) } }] });
  type Step = () => Promise<Response>;
  const says =
    (value: unknown, finish?: string): Step =>
    async () =>
      completion(value, finish);
  const router = (...cards: string[]) => says({ result: { op: 'help', cards } });

  async function run(steps: Step[], { dataset = on, now }: { dataset?: HelpDataset; now?: () => number } = {}) {
    const fetchMock = jest.fn<typeof fetch>(async () => {
      const step = steps[fetchMock.mock.calls.length - 1];
      if (!step) throw new Error('unscripted call');
      return step();
    });
    const traces: HelpTrace[] = [];
    const service = createService({
      fetchImpl: fetchMock,
      dataset,
      onTrace: trace => traces.push(trace),
      ...(now ? { now } : {})
    });
    const response = await compile(service, { redactedText: SECRET, helpContext: null });
    const bodies = fetchMock.mock.calls.map(call => JSON.parse(String((call[1] as RequestInit).body)));
    return { response, bodies, trace: traces[0], calls: fetchMock.mock.calls.length, fetchMock };
  }

  const clock = (...times: number[]) => {
    let call = 0;
    return () => times[Math.min(call++, times.length - 1)]!;
  };

  it('writes, checks and replies with three calls', async () => {
    const { response, bodies, trace, fetchMock } = await run([router('guardian_what'), says(draft), says(yes)]);
    expect(response).toEqual({ status: 200, body: { output: written } });
    expect(parseAiCompilerOutput(written)).toEqual(written);
    expect(bodies.map(body => body.model)).toEqual([ROUTER, SMALL, SMALL]);
    const input = writerInput([card('guardian_what')], on, SECRET, null);
    const strict = (name: string, schema: object) => ({
      type: 'json_schema',
      json_schema: { name, strict: true, schema }
    });
    const small = { model: SMALL, temperature: 0.1, reasoning_effort: 'low', include_reasoning: false, stream: false };
    expect(bodies[1]).toEqual({
      ...small,
      messages: [
        { role: 'system', content: input.system },
        { role: 'user', content: input.user }
      ],
      max_completion_tokens: 800,
      response_format: strict('bread_help_answer', WRITER_SCHEMA)
    });
    expect(bodies[2]).toEqual({
      ...small,
      messages: [
        { role: 'system', content: CHECKER_RULES },
        { role: 'user', content: expect.any(String) }
      ],
      max_completion_tokens: 600,
      response_format: strict('bread_help_check', CHECKER_SCHEMA)
    });
    expect(JSON.parse(bodies[2].messages[1].content)).toMatchObject({ ANSWER: written.answer, QUESTION: SECRET });
    for (const call of fetchMock.mock.calls.slice(1)) {
      expect(call[0]).toBe(fetchMock.mock.calls[0]![0]);
      expect((call[1] as RequestInit).headers).toEqual((fetchMock.mock.calls[0]![1] as RequestInit).headers);
    }
    expect(trace).toEqual({
      path: 'written',
      picked: ['guardian_what'],
      unknownIds: [],
      served: 'guardian_what',
      writing: { cards: ['guardian_what'], given: ['guardian_what'], outcome: 'written' }
    });
  });

  it('writes from two cards and reports only the cited one', async () => {
    const { trace } = await run([router('guardian_what', 'guardian_why'), says(draft), says(yes)]);
    expect(trace).toMatchObject({ path: 'written', writing: { cards: ['guardian_what'] } });
  });

  const failures: [string, Step][] = [
    ['a 429', async () => new Response(null, { status: 429 })],
    ['a 500', async () => new Response(null, { status: 500 })],
    [
      'a thrown fetch',
      async () => {
        throw new Error('fetch failed');
      }
    ],
    [
      'an abort',
      async () => {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }
    ],
    ['bad JSON', async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: '{no' } }] })],
    ['no content', async () => Response.json({ choices: [] })],
    ['a cut-off reply', says(yes, 'length')],
    ['a wrong shape', says({ zebra: true })]
  ];

  const expectCard = (result: Awaited<ReturnType<typeof run>>, id: string, outcome: string, calls: number) => {
    expect(result.response).toEqual({ status: 200, body: { output: explainReply(card(id)) } });
    expect(result.trace).toMatchObject({ served: id, writing: { cards: expect.any(Array), outcome } });
    expect(result.calls).toBe(calls);
  };

  it.each(failures)('serves the checked answer when the writer returns %s', async (_, step) => {
    const result = await run([router('guardian_what'), step]);
    expectCard(result, 'guardian_what', 'writer_technical', 2);
    expect(result.trace?.path).toBe('card');
  });

  it.each(failures)('serves the checked answer when the checker returns %s', async (_, step) => {
    const result = await run([router('guardian_what'), says(draft), step]);
    expectCard(result, 'guardian_what', 'checker_technical', 3);
    expect(result.trace?.path).toBe('card');
  });

  it('falls back to the card the draft drew most on', async () => {
    const own = card('guardian_why').facts.filter(id => !card('guardian_what').facts.includes(id));
    const second = { answerable: true, sentences: [sentence(own[0]!)] };
    const result = await run([router('guardian_what', 'guardian_why'), says(second), failures[0]![1]]);
    expectCard(result, 'guardian_why', 'checker_technical', 3);
  });

  it('serves the checked answer for a format failure without asking the checker', async () => {
    const opener = { answerable: true, sentences: [{ facts: ['g.service'], text: 'Yes, in Bread.' }] };
    expectCard(await run([router('guardian_what'), says(opener)]), 'guardian_what', 'format', 2);
  });

  const invented = { answerable: true, sentences: [{ facts: ['g.service'], text: 'Zebra Labs runs it.' }] };

  it.each<[string, Step[], string]>([
    ['the writer cannot answer', [says({ answerable: false, sentences: [] })], 'unanswerable'],
    ['the draft reaches past its cards', [says(invented)], 'content'],
    ['the checker finds it unsupported', [says(draft), says({ supported: false, answers: true })], 'not_supported'],
    ['the checker finds it off the question', [says(draft), says({ supported: true, answers: false })], 'not_answers']
  ])('says it does not know when %s', async (_, steps, outcome) => {
    const result = await run([router('guardian_what'), ...steps]);
    expectCard(result, 'not_covered', outcome, steps.length + 1);
    expect(result.trace).toMatchObject({ path: 'unknown', writing: { cards: ['guardian_what'] } });
    expect(JSON.stringify(result.response)).not.toContain('Zebra Labs');
    expect(logs.flatMap(spy => spy.mock.calls)).toEqual([[JSON.stringify({ event: 'compile_ok', model: ROUTER })]]);
  });

  it('says it cannot diagnose when the first card is a problem card', async () => {
    const result = await run([router('guardian_down'), says({ answerable: false, sentences: [] })]);
    expectCard(result, 'cannot_diagnose', 'unanswerable', 2);
  });

  const hung: Step = async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }) as Response;

  it('gives up on a writer whose body never arrives', async () => {
    const result = await run([router('guardian_what'), hung], { now: clock(0, 7000) });
    expectCard(result, 'guardian_what', 'writer_technical', 2);
  });

  it('gives up on a checker whose body never arrives', async () => {
    const result = await run([router('guardian_what'), says(draft), hung], { now: clock(0, 0, 8000) });
    expectCard(result, 'guardian_what', 'checker_technical', 3);
  });

  it('aborts the call it gives up on', async () => {
    const result = await run([router('guardian_what'), hung], { now: clock(0, 7000) });
    expect(result.calls).toBe(2);
    expect((result.fetchMock.mock.calls[1]![1] as RequestInit).signal?.aborted).toBe(true);
  });

  it('skips the writer with under 2 seconds left', async () => {
    const result = await run([router('guardian_what')], { now: clock(0, 7001) });
    expectCard(result, 'guardian_what', 'writer_technical', 1);
  });

  it('skips the checker with under 1 second left', async () => {
    const result = await run([router('guardian_what'), says(draft)], { now: clock(0, 0, 8001) });
    expectCard(result, 'guardian_what', 'checker_technical', 2);
  });

  it.each<[number[], number[]]>([
    [
      [0, 0, 0],
      [15000, 4000, 3000]
    ],
    [
      [0, 6500, 7500],
      [15000, 1500, 1500]
    ]
  ])('times the calls from the start of the request at %j', async (times, expected) => {
    const timers = jest.spyOn(globalThis, 'setTimeout');
    await run([router('guardian_what'), says(draft), says(yes)], { now: clock(...times) });
    expect(timers.mock.calls.map(call => call[1]).filter(ms => Number(ms) >= 1000)).toEqual(expected);
  });

  it.each<[string, string[]]>([
    ['a fixed card', ['phrase_exposed']],
    ['a checked card', ['guardian_see']],
    ['an unknown pick', ['not_covered']],
    ['no pick', []],
    ['an unlisted card', ['usdcx']],
    ['an unlisted first card', ['usdcx', 'guardian_what']],
    ['a fixed second card', ['guardian_what', 'phrase_exposed']]
  ])('makes no second call for %s', async (_, cards) => {
    expect((await run([router(...cards)])).calls).toBe(1);
  });

  it('makes no second call for a command, a button or a bare number', async () => {
    expect((await run([says({ result: { op: 'cancel' } })])).calls).toBe(1);
    const fetchImpl = jest.fn<typeof fetch>(async () =>
      completion({ result: { op: 'help', cards: ['guardian_what'] } })
    );
    const service = createService({ fetchImpl, dataset: on });
    await compile(service, { redactedText: shippedTitles.Recovery[0]!, helpContext: 'Recovery' });
    expect(fetchImpl).toHaveBeenCalledTimes(0);
    await compile(service, { redactedText: '<AMT_1>', helpContext: null });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(['writer', 'checker'] as const)('writes nothing when the %s is the router model', async role => {
    const dataset = { ...on, writing: { ...on.writing, [role]: ROUTER } };
    expect((await run([router('guardian_what')], { dataset })).calls).toBe(1);
  });

  it('writes nothing with the shipped dataset, whatever the router picks', async () => {
    const extra: string[] = [];
    for (const { id } of data.cards) {
      if ((await run([router(id)], { dataset: data })).calls !== 1) extra.push(id);
    }
    expect(extra).toEqual([]);
  });

  it('sends the router the same request with writing on and off', async () => {
    const off = await run([router('guardian_what')], { dataset: data });
    const enabled = await run([router('guardian_what'), says(draft), says(yes)]);
    expect(enabled.bodies[0]).toEqual(off.bodies[0]);
    expect(enabled.calls).toBe(3);
  });
});
