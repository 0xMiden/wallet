/**
 * @jest-environment node
 */
// App 1.18.2 end to end: its snapshot request, the Worker, its reply parser and orchestrator, then the screen step.
import { describe, expect, it } from '@jest/globals';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { createService } from '../../services/command-ai/src/index';
import {
  type OrchestratorResolution,
  type OrchestratorWalletContext,
  applyChipSelection,
  compileOutputToResolution,
  createClarificationSnapshot
} from './app-1.18.2/orchestrator';
import { mergeRedactionMaps, redactPrompt } from './app-1.18.2/redactor';
import { type AiCompilerOutput, parseAiCompilerOutput } from './app-1.18.2/schema';

// The frozen copies are v1.18.2's own files: these are their git blob ids at that tag.
it.each([
  ['orchestrator.ts', '34a5889b4c0e1cb89b4aa17b256941bdc479d616'],
  ['redactor.ts', 'ad2c69e1847882a3f3b3d8bc932a9de8000e9a6f'],
  ['schema.ts', '4426408d008cb88190c8f87f8e020ef38510afb0'],
  ['help-facts.json', '334e0fd6604901283a6d354ab16b184006752f9e']
])('keeps %s as app 1.18.2 shipped it', (file, blob) => {
  const contents = readFileSync(path.join(__dirname, 'app-1.18.2', file));
  expect(createHash('sha1').update(`blob ${contents.length}\0`).update(contents).digest('hex')).toBe(blob);
});

const ALICE = 'mtst1ap2t7nsjausqsgr57c58s2nqqg9f8m62';
const row = (tokenId: string, symbol: string, units: string, balance: number) => ({
  tokenId,
  tokenSlug: symbol,
  balance,
  balanceBaseUnits: units,
  fiatPrice: 1,
  change24h: 0,
  metadata: { symbol, name: symbol, decimals: 6 }
});
const route = (id: string, symbol: string, network: string) => ({
  id,
  provider: 'agglayer',
  mode: 'send' as const,
  sourceSymbol: symbol,
  sourceNetwork: 'miden-testnet',
  destinationSymbol: symbol,
  destinationNetwork: network
});

const wallet: OrchestratorWalletContext = {
  accountPublicKey: 'mtst1me00000000000000000000000000000',
  networkName: 'testnet',
  nativeFaucetId: 'faucet-miden',
  verificationBaseFee: 1000,
  balances: [
    row('faucet-miden', 'MIDEN', '100000000', 100),
    row('faucet-usdcx', 'USDCx', '1000000000', 1000),
    row('faucet-foo', 'FOO', '50000000', 50)
  ],
  tokenPrices: {},
  contacts: [{ id: 'c-alice', name: 'Alice', address: ALICE }],
  swapTokens: [
    { symbol: 'MIDEN', faucetId: 'faucet-miden', decimals: 6 },
    { symbol: 'USDCx', faucetId: 'faucet-usdcx', decimals: 6 },
    { symbol: 'ETH', faucetId: 'faucet-eth', decimals: 8 }
  ],
  bridgeRoutes: [route('r-miden', 'MIDEN', 'sepolia'), route('r-usdcx', 'USDCx', 'sepolia')],
  earnVaults: [],
  earnPositions: []
};
const redact = (text: string) =>
  redactPrompt(text, { contacts: wallet.contacts, heldNicheTickers: [{ symbol: 'FOO', tokenId: 'faucet-foo' }] });

const empty = {
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
const amount = { kind: 'exact_ref', ref: 'AMT_1' };
const patch = (changed: object = {}) => ({ op: 'patch_slots', patch: { action: null, ...empty, ...changed } });

type Question = Extract<OrchestratorResolution, { kind: 'clarifying' }>;

function question(resolution: OrchestratorResolution): Question {
  if (resolution.kind !== 'clarifying') throw new Error(`expected a question, got ${JSON.stringify(resolution)}`);
  return resolution;
}

function parsed(reply: unknown): AiCompilerOutput {
  const output = parseAiCompilerOutput(reply);
  if (!output) throw new Error('the app parser rejects this reply');
  return output;
}

const first = (text: string, intent: object, context = wallet) =>
  question(compileOutputToResolution(parsed({ op: 'set_intent', ...empty, ...intent }), redact(text).map, context));

const amountQuestion = () =>
  first('send MIDEN to Alice', { action: 'send', asset: 'MIDEN', recipient_ref: 'CONTACT_1' });
const unlistedRecipientQuestion = () => first('send 5 FOO', { action: 'send', amount, asset: 'TOKEN_1' });
const listedRecipientQuestion = () => first('send 5 MIDEN', { action: 'send', amount, asset: 'MIDEN' });
const assetQuestion = () => first('send to Alice', { action: 'send', recipient_ref: 'CONTACT_1' });
const chip = (asked: Question, id: string) =>
  applyChipSelection(asked, asked.chips.find(each => each.id === id)!, wallet);
const pickedMiden = () => question(chip(assetQuestion(), 'faucet-miden'));
const swapAmountQuestion = (pay = 'MIDEN') =>
  first(`swap ${pay} to USDCx`, { action: 'swap', asset: pay, to_asset: 'USDCx' });
const bridgeAmountQuestion = () =>
  first('bridge MIDEN to sepolia', { action: 'bridge', asset: 'MIDEN', to_chain: 'sepolia' });
// One route only, so the draft holds its id but no asset.
const unnamedBridgeQuestion = () =>
  first(
    'bridge to sepolia',
    { action: 'bridge', to_chain: 'sepolia' },
    {
      ...wallet,
      bridgeRoutes: [route('r-miden', 'MIDEN', 'sepolia')]
    }
  );
const bridgeRouteQuestion = () => first('bridge to sepolia', { action: 'bridge', to_chain: 'sepolia' });

/** CommandAiBar.submitPrompt after the snapshot request: `unsupported` shows an error and applies nothing. */
function screen(asked: Question, text: string, output: AiCompilerOutput) {
  if (output.op === 'unsupported') {
    return { kind: 'error' as const, messageKey: 'commandAiUnsupported', stillAsked: asked };
  }
  const typed = redact(text).map;
  const isPatch = output.op === 'patch_slots';
  return compileOutputToResolution(
    output,
    isPatch ? mergeRedactionMaps(asked.map, typed) : typed,
    wallet,
    isPatch ? asked.draft : undefined
  );
}

async function throughWorker(asked: Question, text: string, reply: object) {
  const service = createService({
    fetchImpl: async () => Response.json({ choices: [{ message: { content: JSON.stringify({ result: reply }) } }] })
  });
  const response = await service.fetch(
    new Request('https://command-ai.test/v1/compile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        redactedText: redact(text).redactedText,
        snapshot: createClarificationSnapshot(asked.draft, asked.slot, asked.allowedOptionIds)
      })
    }),
    { ALLOWED_ORIGINS: '[]', GROQ_API_KEY: 'test', COMMAND_AI_RATE_LIMIT: { limit: async () => ({ success: true }) } }
  );
  expect(response.status).toBe(200);
  const { output } = (await response.json()) as { output: unknown };
  return screen(asked, text, parsed(output));
}

describe('what app 1.18.2 can be told instead', () => {
  it('closes the question without any error on cancel', () => {
    expect(screen(amountQuestion(), 'use USDCx', parsed({ op: 'cancel' }))).toEqual({ kind: 'cancelled' });
  });

  it('asks again with the old token on a patch that changes nothing', () => {
    const again = question(screen(amountQuestion(), 'use USDCx', parsed(patch())) as OrchestratorResolution);
    expect(again.draft.tokenId).toBe('faucet-miden');
  });

  it('sends no amount or recipient, so the Worker cannot rebuild the intent', () => {
    const asked = amountQuestion();
    expect(createClarificationSnapshot(asked.draft, asked.slot, asked.allowedOptionIds).draft).toEqual({
      action: 'send',
      asset: 'MIDEN',
      to_asset: null,
      from_chain: null,
      to_chain: null,
      hasAmount: false,
      hasRecipient: true,
      provider: null,
      note_type: null,
      earn_op: null
    });
  });
});

describe('a follow-up that would leave app 1.18.2 on the old token or route', () => {
  it.each<[string, () => Question, string, object, string]>([
    ['A: new token and amount', amountQuestion, 'send 10 USDCx instead', { amount, asset: 'USDCx' }, 'faucet-miden'],
    ['B: new token only, before the 50% chip', amountQuestion, 'use USDCx', { asset: 'USDCx' }, 'faucet-miden'],
    ['B: the model changes nothing', amountQuestion, 'use USDCx', {}, 'faucet-miden'],
    ['A: the model keeps only the amount', amountQuestion, 'send 10 USDCx instead', { amount }, 'faucet-miden'],
    ['A: the model echoes the old token', amountQuestion, '10 USDCx', { amount, asset: 'MIDEN' }, 'faucet-miden'],
    [
      'C: a token the wallet does not hold',
      amountQuestion,
      'send 5 DAI instead',
      { amount, asset: 'DAI' },
      'faucet-miden'
    ],
    ['D: after a token chip', pickedMiden, '10 USDCx', { amount, asset: 'USDCx' }, 'faucet-miden'],
    [
      'E: after an unlisted token',
      unlistedRecipientQuestion,
      'USDCx to Alice',
      { asset: 'USDCx', recipient_ref: 'CONTACT_1' },
      'faucet-foo'
    ],
    [
      'E: a token reference the reply did not type',
      unlistedRecipientQuestion,
      'to Alice',
      { asset: 'TOKEN_1', to_asset: null, recipient_ref: 'CONTACT_1' },
      'faucet-foo'
    ],
    ['an unlisted token the model ignores', amountQuestion, 'send 10 FOO instead', { amount }, 'faucet-miden'],
    [
      'a dollar amount of another token',
      amountQuestion,
      'send $10 of USDCx instead',
      { amount: { kind: 'fiat_ref', ref: 'FIAT_AMT_1', currency: 'USD' }, asset: 'USDCx' },
      'faucet-miden'
    ],
    [
      'a dollar amount, the token ignored',
      amountQuestion,
      'send $10 of USDCx instead',
      { amount: { kind: 'fiat_ref', ref: 'FIAT_AMT_1', currency: 'USD' } },
      'faucet-miden'
    ],
    ['S1: new pay token', swapAmountQuestion, 'swap 10 ETH instead', { amount, asset: 'ETH' }, 'faucet-miden'],
    ['S2: new receive token', swapAmountQuestion, '10, and receive ETH', { amount, to_asset: 'ETH' }, 'faucet-usdcx'],
    [
      'a full name for the held symbol',
      () => swapAmountQuestion('ETH'),
      '10',
      { amount, asset: 'Ethereum' },
      'faucet-eth'
    ],
    ['R1: new bridge asset', bridgeAmountQuestion, '10 USDCx instead', { amount, asset: 'USDCx' }, 'r-miden'],
    ['a bridge asset the draft never named', unnamedBridgeQuestion, '10 USDCx', { amount, asset: 'USDCx' }, 'r-miden'],
    ['a new bridge destination', bridgeAmountQuestion, '10, to base', { amount, to_chain: 'base' }, 'r-miden'],
    ['a new bridge source', bridgeAmountQuestion, '10, from ethereum', { amount, from_chain: 'ethereum' }, 'r-miden']
  ])('%s: 1.18.2 shows an error and applies nothing', async (_name, ask, text, changed, old) => {
    // Without the Worker's refusal, 1.18.2 goes on with the old id.
    expect(JSON.stringify(screen(ask(), text, parsed(patch(changed))))).toContain(old);

    const asked = ask();
    const draft = { ...asked.draft };
    const shown = await throughWorker(asked, text, patch(changed));
    expect(shown).toMatchObject({ kind: 'error', messageKey: 'commandAiUnsupported' });
    expect(asked.draft).toEqual(draft);
  });

  // A send's token id would follow it into the bridge's balance check.
  it('a change of action: 1.18.2 shows an error and applies nothing', async () => {
    const shown = await throughWorker(amountQuestion(), 'bridge it instead', patch({ action: 'bridge' }));
    expect(shown).toMatchObject({ kind: 'error', messageKey: 'commandAiUnsupported' });
  });

  // The snapshot cannot say whether the draft holds an id, so a change that would have been safe is declined too.
  it('F: a listed token changed before any id was set is declined as well', async () => {
    const shown = await throughWorker(
      listedRecipientQuestion(),
      'USDCx to Alice',
      patch({ asset: 'USDCx', recipient_ref: 'CONTACT_1' })
    );
    expect(shown).toMatchObject({ kind: 'error', messageKey: 'commandAiUnsupported' });
  });
});

describe('a follow-up app 1.18.2 applies correctly still goes through', () => {
  const send = (tokenId: string, value: string) => ({
    kind: 'handoff',
    handoff: { action: 'send', draft: { tokenId, amount: value } }
  });

  it.each<[string, () => Question, string, object, object]>([
    ['an amount alone', amountQuestion, '10', { amount }, send('faucet-miden', '10')],
    ['an unchanged token', amountQuestion, '10 MIDEN', { amount, asset: 'MIDEN' }, send('faucet-miden', '10')],
    [
      'an unchanged token in another case',
      amountQuestion,
      '10',
      { amount, asset: 'miden' },
      send('faucet-miden', '10')
    ],
    [
      'G: a typed unlisted token',
      amountQuestion,
      'send 10 FOO instead',
      { amount, asset: 'TOKEN_1' },
      send('faucet-foo', '10')
    ],
    ['a token where none was set', assetQuestion, '10 USDCx', { amount, asset: 'USDCx' }, send('faucet-usdcx', '10')],
    [
      'an unchanged swap pair',
      swapAmountQuestion,
      '10',
      { amount, asset: 'MIDEN', to_asset: 'USDCx' },
      { kind: 'handoff', handoff: { draft: { payTokenId: 'faucet-miden', receiveTokenId: 'faucet-usdcx' } } }
    ],
    [
      'an unchanged bridge asset',
      bridgeAmountQuestion,
      '10',
      { amount, asset: 'MIDEN', to_chain: 'Sepolia' },
      { kind: 'handoff', handoff: { draft: { route: 'r-miden', amount: '10' } } }
    ],
    [
      'a bridge provider choice',
      bridgeRouteQuestion,
      'agglayer',
      { provider: 'agglayer' },
      { kind: 'clarifying', slot: 'provider' }
    ]
  ])('%s', async (_name, ask, text, changed, expected) => {
    expect(await throughWorker(ask(), text, patch(changed))).toMatchObject(expected);
  });

  it('passes a cancel through', async () => {
    expect(await throughWorker(amountQuestion(), 'cancel', { op: 'cancel' })).toEqual({ kind: 'cancelled' });
  });

  // A full intent is rebuilt from this reply alone, so no old id can follow it.
  it('passes a full intent through', async () => {
    const intent = { op: 'set_intent', ...empty, action: 'send', amount, asset: 'USDCx', recipient_ref: 'CONTACT_1' };
    expect(await throughWorker(amountQuestion(), 'send 10 USDCx to Alice', intent)).toMatchObject(
      send('faucet-usdcx', '10')
    );
  });

  it('H: a chip sends no request', () => {
    expect(chip(amountQuestion(), '50pct')).toMatchObject({ handoff: { draft: { tokenId: 'faucet-miden' } } });
  });
});
