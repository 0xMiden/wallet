import type { TokenPriceInfo } from 'lib/prices/binance';
import { peekTokenPriceAssets } from 'lib/token-list/runtime';

import {
  applyChipSelection,
  applyPatchToDraft,
  carryForwardAmount,
  compileOutputToResolution,
  createClarificationSnapshot,
  resolveDraftToAction,
  type OrchestratorWalletContext
} from './orchestrator';
import { mergeRedactionMaps, redactPrompt } from './redactor';

jest.mock('lib/token-list/runtime', () => ({
  ...jest.requireActual('lib/token-list/runtime'),
  peekTokenPriceAssets: jest.fn()
}));

const VALID_MIDEN_ALICE = 'mtst1ap2t7nsjausqsgr57c58s2nqqg9f8m62';
const VALID_EVM_ALICE_WORK = '0x023230000000000000000000000000000000a9f1';

function createContext(): OrchestratorWalletContext {
  return {
    accountPublicKey: 'mtst1me00000000000000000000000000000',
    networkName: 'testnet',
    nativeFaucetId: 'faucet-miden',
    verificationBaseFee: 1000,
    balances: [
      {
        tokenId: 'faucet-miden',
        tokenSlug: 'MIDEN',
        balance: 20,
        balanceBaseUnits: '20000000',
        fiatPrice: 2,
        change24h: 0,
        metadata: { symbol: 'MIDEN', name: 'Miden', decimals: 6 }
      },
      {
        tokenId: 'faucet-eth',
        tokenSlug: 'ETH',
        balance: 2.4,
        balanceBaseUnits: '2400000000000000000',
        fiatPrice: 3000,
        change24h: 0,
        metadata: { symbol: 'ETH', name: 'Ethereum', decimals: 18 }
      },
      {
        tokenId: 'faucet-usdcx',
        tokenSlug: 'USDCx',
        balance: 1000,
        balanceBaseUnits: '1000000000',
        fiatPrice: 1,
        change24h: 0,
        metadata: { symbol: 'USDCx', name: 'USDCx', decimals: 6 }
      }
    ],
    tokenPrices: {},
    contacts: [
      { id: 'c-alice', name: 'Alice', address: VALID_MIDEN_ALICE },
      { id: 'c-alice-work', name: 'Alice Work', address: VALID_EVM_ALICE_WORK }
    ],
    swapTokens: [
      { symbol: 'MIDEN', faucetId: 'faucet-miden', decimals: 6 },
      { symbol: 'USDCx', faucetId: 'faucet-usdcx', decimals: 6 }
    ],
    bridgeRoutes: [
      {
        id: 'testnet:epoch:usdc:faucet-usdcx:receive',
        provider: 'epoch',
        mode: 'receive',
        sourceSymbol: 'USDC',
        sourceNetwork: 'sepolia',
        destinationSymbol: 'USDCx',
        destinationNetwork: 'miden-testnet',
        estimateFee: '$0.42',
        etaLabel: '~15s'
      },
      {
        id: 'testnet:agglayer:usdc:faucet-usdcx:receive',
        provider: 'agglayer',
        mode: 'receive',
        sourceSymbol: 'USDC',
        sourceNetwork: 'sepolia',
        destinationSymbol: 'USDCx',
        destinationNetwork: 'miden-testnet',
        estimateFee: '$0.25',
        etaLabel: '~2m'
      },
      {
        id: 'testnet:xreserve:usdc:faucet-usdcx:receive',
        provider: 'xreserve',
        mode: 'receive',
        sourceSymbol: 'USDC',
        sourceNetwork: 'sepolia',
        destinationSymbol: 'USDCx',
        destinationNetwork: 'miden-testnet',
        estimateFee: '$0.10',
        etaLabel: '~1m'
      }
    ],
    earnVaults: [{ id: 'vault-1', name: 'Epoch USDCx', symbol: 'USDCx', collateralFaucetId: 'faucet-usdcx' }],
    earnPositions: [],
    validateAddress: addr => {
      if (addr.startsWith('0x') && addr.length < 42) return { kind: 'incomplete-prefix', raw: addr };
      if (addr.startsWith('0x') && addr.length === 42) return { kind: 'valid', chain: 'ethereum' };
      if (addr.startsWith('mtst1') && addr.length > 20) return { kind: 'valid', chain: 'miden' };
      return { kind: 'invalid', raw: addr };
    },
    generateReviewId: () => 'rev-123'
  };
}

describe('command-ai orchestrator', () => {
  describe('dollar sends', () => {
    function resolveDollarSend(quote?: TokenPriceInfo) {
      const ctx = createContext();
      jest.mocked(peekTokenPriceAssets).mockReturnValueOnce(new Map([['faucet-eth', 'ETH']]));
      const { map } = redactPrompt('send $50 of ETH to Alice', { contacts: ctx.contacts });

      return compileOutputToResolution(
        {
          op: 'set_intent',
          action: 'send',
          amount: { kind: 'fiat_ref', ref: 'FIAT_AMT_1', currency: 'USD' },
          asset: 'ETH',
          to_asset: null,
          from_chain: null,
          to_chain: null,
          recipient_ref: 'CONTACT_1',
          provider: null,
          note_type: null,
          earn_op: null
        },
        map,
        { ...ctx, tokenPrices: quote ? { ETH: quote } : {} }
      );
    }

    const marketQuote: TokenPriceInfo = { price: 2500, change24h: 0, percentageChange24h: 0, kind: 'market' };

    it('returns a quote error when only the balance row has a price', () => {
      expect(resolveDollarSend()).toMatchObject({ kind: 'error', messageKey: 'commandAiFiatPriceUnavailable' });
    });

    it('returns a quote error when the verified market quote is more than ten minutes old', () => {
      expect(resolveDollarSend({ ...marketQuote, observedAt: Date.now() - 11 * 60_000 })).toMatchObject({
        kind: 'error',
        messageKey: 'commandAiFiatPriceUnavailable'
      });
    });

    it('drafts the amount using a fresh verified market quote', () => {
      expect(resolveDollarSend({ ...marketQuote, observedAt: Date.now() })).toMatchObject({
        kind: 'handoff',
        handoff: { action: 'send', draft: { amount: '0.02', tokenId: 'faucet-eth' } }
      });
    });
  });

  it('resolves "send 10 MIDEN to Alice" directly to /send/review with prefilled draft', () => {
    const ctx = createContext();
    const { map } = redactPrompt('send 10 MIDEN to Alice', { contacts: ctx.contacts });
    const res = compileOutputToResolution(
      {
        op: 'set_intent',
        action: 'send',
        amount: { kind: 'exact_ref', ref: 'AMT_1' },
        asset: 'MIDEN',
        to_asset: null,
        from_chain: null,
        to_chain: null,
        recipient_ref: 'CONTACT_1',
        provider: null,
        note_type: null,
        earn_op: null
      },
      map,
      ctx
    );

    expect(res.kind).toBe('handoff');
    if (res.kind !== 'handoff' || res.handoff.action !== 'send') return;
    expect(res.handoff.jumpToConfirm).toBe(true);
    expect(res.handoff.path).toContain('/send/review?');
    expect(res.handoff.draft).toEqual({
      amount: '10',
      recipientAddress: VALID_MIDEN_ALICE,
      tokenId: 'faucet-miden',
      privacy: 'private',
      reviewId: 'rev-123'
    });
  });

  it('never pads 0x02323 and offers saved address-book prefix chips or rejects cleanly', () => {
    const ctx = createContext();
    const { map } = redactPrompt('send 1 eth to 0x02323', { contacts: ctx.contacts });
    const res = compileOutputToResolution(
      {
        op: 'set_intent',
        action: 'send',
        amount: { kind: 'exact_ref', ref: 'AMT_1' },
        asset: 'ETH',
        to_asset: null,
        from_chain: null,
        to_chain: null,
        recipient_ref: 'ADDR_1',
        provider: null,
        note_type: null,
        earn_op: null
      },
      map,
      ctx
    );

    expect(res.kind).toBe('clarifying');
    if (res.kind !== 'clarifying') return;
    expect(res.chips).toHaveLength(1);
    expect(res.chips[0]?.label).toBe('Alice Work');

    const picked = applyChipSelection(res, res.chips[0]!, ctx);
    expect(picked.kind).toBe('handoff');
    if (picked.kind !== 'handoff' || picked.handoff.action !== 'send') return;
    expect(picked.handoff.draft.recipientAddress).toBe(VALID_EVM_ALICE_WORK);
  });

  it('rejects unknown partial hex prefix without guessing', () => {
    const ctx = createContext();
    const { map } = redactPrompt('send 1 eth to 0x99999', { contacts: ctx.contacts });
    const res = compileOutputToResolution(
      {
        op: 'set_intent',
        action: 'send',
        amount: { kind: 'exact_ref', ref: 'AMT_1' },
        asset: 'ETH',
        to_asset: null,
        from_chain: null,
        to_chain: null,
        recipient_ref: 'ADDR_1',
        provider: null,
        note_type: null,
        earn_op: null
      },
      map,
      ctx
    );

    expect(res).toEqual({
      kind: 'error',
      messageKey: 'commandAiIncompleteAddress',
      messageParams: { address: '0x99999' },
      fallbackAction: 'send'
    });
  });

  it('labels routes that differ only by asset so no two bridge chips read the same', () => {
    const base = createContext();
    const route = (symbol: string) => ({
      id: `mainnet:agglayer:${symbol.toLowerCase()}:faucet-${symbol.toLowerCase()}:receive`,
      provider: 'agglayer' as const,
      mode: 'receive' as const,
      sourceSymbol: symbol,
      sourceNetwork: 'ethereum',
      destinationSymbol: symbol,
      destinationNetwork: 'miden-mainnet'
    });
    const ctx = { ...base, bridgeRoutes: ['ETH', 'USDC', 'USDT', 'WBTC', 'LINK', 'DAI'].map(route) };
    const { map } = redactPrompt('bridge in 10 usdcx', { contacts: ctx.contacts });
    const clarifying = compileOutputToResolution(
      {
        op: 'set_intent',
        action: 'bridge',
        amount: { kind: 'exact_ref', ref: 'AMT_1' },
        asset: 'USDCX',
        to_asset: null,
        from_chain: null,
        to_chain: 'miden',
        recipient_ref: null,
        provider: null,
        note_type: null,
        earn_op: null
      },
      map,
      ctx
    );

    expect(clarifying.kind).toBe('clarifying');
    if (clarifying.kind !== 'clarifying') return;
    const labels = clarifying.chips.map(chip => chip.label);
    expect(labels).toHaveLength(6);
    expect(new Set(labels).size).toBe(6);
    expect(labels[1]).toBe('USDC → USDC · agglayer (ethereum → miden-mainnet)');
  });

  it('answers a one-option clarification with that option instead of asking', () => {
    const base = createContext();
    const ctx = { ...base, swapTokens: [{ symbol: 'USDCx', faucetId: 'faucet-usdcx', decimals: 6 }] };
    const { map } = redactPrompt('swap 10', { contacts: ctx.contacts });
    const res = compileOutputToResolution(
      {
        op: 'set_intent',
        action: 'swap',
        amount: { kind: 'exact_ref', ref: 'AMT_1' },
        asset: null,
        to_asset: null,
        from_chain: null,
        to_chain: null,
        recipient_ref: null,
        provider: null,
        note_type: null,
        earn_op: null
      },
      map,
      ctx
    );

    // The only swap token was picked as the asset; with no partner left the swap is unavailable, not asked.
    expect(res.kind).toBe('error');
    if (res.kind !== 'error') return;
    expect(res.messageKey).toBe('commandAiSwapUnavailable');
  });

  it('still asks for the recipient when a single saved contact could be offered', () => {
    const base = createContext();
    const ctx = { ...base, contacts: base.contacts.slice(0, 1) };
    const { map } = redactPrompt('send 10 MIDEN', { contacts: ctx.contacts });
    const res = compileOutputToResolution(
      {
        op: 'set_intent',
        action: 'send',
        amount: { kind: 'exact_ref', ref: 'AMT_1' },
        asset: 'MIDEN',
        to_asset: null,
        from_chain: null,
        to_chain: null,
        recipient_ref: null,
        provider: null,
        note_type: null,
        earn_op: null
      },
      map,
      ctx
    );

    expect(res.kind).toBe('clarifying');
    if (res.kind !== 'clarifying') return;
    expect(res.slot).toBe('recipient');
    expect(res.chips).toHaveLength(1);
  });

  it.each([
    ['a saved contact address', VALID_MIDEN_ALICE],
    ['an address that is not in the contacts', 'mtst1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqnew']
  ])('uses a complete typed address without asking: %s', (_label, address) => {
    const base = createContext();
    const ctx = { ...base, contacts: base.contacts.slice(0, 1) };
    const { map } = redactPrompt(`send 10 MIDEN to ${address}`, { contacts: ctx.contacts });
    const res = compileOutputToResolution(
      {
        op: 'set_intent',
        action: 'send',
        amount: { kind: 'exact_ref', ref: 'AMT_1' },
        asset: 'MIDEN',
        to_asset: null,
        from_chain: null,
        to_chain: null,
        recipient_ref: 'ADDR_1',
        provider: null,
        note_type: null,
        earn_op: null
      },
      map,
      ctx
    );

    expect(res.kind).toBe('handoff');
    if (res.kind !== 'handoff' || res.handoff.action !== 'send') return;
    expect(res.handoff.draft.recipientAddress).toBe(address);
  });

  it('surfaces bridge clarification chips and completes via chip click or patch_slots', () => {
    const ctx = createContext();
    const { map } = redactPrompt('bridge 500 usdc to miden', { contacts: ctx.contacts });
    const clarifying = compileOutputToResolution(
      {
        op: 'set_intent',
        action: 'bridge',
        amount: { kind: 'exact_ref', ref: 'AMT_1' },
        asset: 'USDC',
        to_asset: null,
        from_chain: null,
        to_chain: 'miden',
        recipient_ref: null,
        provider: null,
        note_type: null,
        earn_op: null
      },
      map,
      ctx
    );

    expect(clarifying.kind).toBe('clarifying');
    if (clarifying.kind !== 'clarifying') return;
    expect(clarifying.questionKey).toBe('commandAiChooseBridge');
    expect(clarifying.chips).toHaveLength(3);

    // Clicking a chip completes with 0 LLM calls.
    const byChip = applyChipSelection(clarifying, clarifying.chips[0]!, ctx);
    expect(byChip.kind).toBe('handoff');
    if (byChip.kind !== 'handoff' || byChip.handoff.action !== 'bridge') return;
    expect(byChip.handoff.draft.route).toBe('testnet:epoch:usdc:faucet-usdcx:receive');
    expect(byChip.handoff.draft.amount).toBe('500');
    expect(byChip.handoff.draft.autoReview).toBe(true);

    // Or typing a patch updates both provider and amount without losing earlier context.
    const followUp = redactPrompt('use agglayer and make it 400', { contacts: ctx.contacts });
    const mergedMap = mergeRedactionMaps(clarifying.map, followUp.map);
    const byPatch = compileOutputToResolution(
      {
        op: 'patch_slots',
        patch: {
          action: null,
          amount: { kind: 'exact_ref', ref: 'AMT_1' },
          asset: null,
          to_asset: null,
          from_chain: null,
          to_chain: null,
          recipient_ref: null,
          provider: 'agglayer',
          note_type: null,
          earn_op: null
        }
      },
      mergedMap,
      ctx,
      clarifying.draft
    );
    expect(byPatch.kind).toBe('handoff');
    if (byPatch.kind !== 'handoff' || byPatch.handoff.action !== 'bridge') return;
    expect(byPatch.handoff.draft.route).toBe('testnet:agglayer:usdc:faucet-usdcx:receive');
    expect(byPatch.handoff.draft.amount).toBe('400');
  });

  it('computes "half my ETH" locally using bigint arithmetic without exposing balance', () => {
    const ctx = createContext();
    const { map } = redactPrompt('send half my ETH to Alice', { contacts: ctx.contacts });
    const res = compileOutputToResolution(
      {
        op: 'set_intent',
        action: 'send',
        amount: { kind: 'fraction', numerator: 1, denominator: 2 },
        asset: 'ETH',
        to_asset: null,
        from_chain: null,
        to_chain: null,
        recipient_ref: 'CONTACT_1',
        provider: null,
        note_type: null,
        earn_op: null
      },
      map,
      ctx
    );

    expect(res.kind).toBe('handoff');
    if (res.kind !== 'handoff' || res.handoff.action !== 'send') return;
    expect(res.handoff.draft.amount).toBe('1.2');
    expect(res.handoff.draft.recipientAddress).toBe(VALID_MIDEN_ALICE);
  });

  it('disambiguates identical contact names and defaults cross-chain network for EVM contacts', () => {
    const baseCtx = createContext();
    const ctx: OrchestratorWalletContext = {
      ...baseCtx,
      contacts: [
        { id: 'c-1', name: 'Alice', address: VALID_MIDEN_ALICE },
        { id: 'c-2', name: 'Alice', address: VALID_EVM_ALICE_WORK, network: 'base-sepolia' }
      ]
    };
    const { map } = redactPrompt('send 2 USDCx to Alice', { contacts: ctx.contacts });
    const clarifying = compileOutputToResolution(
      {
        op: 'set_intent',
        action: 'send',
        amount: { kind: 'exact_ref', ref: 'AMT_1' },
        asset: 'USDCx',
        to_asset: null,
        from_chain: null,
        to_chain: null,
        recipient_ref: 'CONTACT_1',
        provider: null,
        note_type: null,
        earn_op: null
      },
      map,
      ctx
    );

    expect(clarifying.kind).toBe('clarifying');
    if (clarifying.kind !== 'clarifying') return;
    expect(clarifying.questionKey).toBe('commandAiDisambiguateContact');
    expect(clarifying.chips).toHaveLength(2);

    const handoff = applyChipSelection(clarifying, clarifying.chips[1]!, ctx);
    expect(handoff.kind).toBe('handoff');
    if (handoff.kind !== 'handoff' || handoff.handoff.action !== 'send') return;
    expect(handoff.handoff.draft.bridgeNetwork).toBe('base-sepolia');
    expect(handoff.handoff.path).toContain('network=base-sepolia');
  });

  it('disables bridge autoReview when outbound destination or balance is missing', () => {
    const baseCtx = createContext();
    const outRoute = {
      id: 'testnet:xreserve:usdcx:sepolia:send',
      provider: 'xreserve',
      mode: 'send' as const,
      sourceSymbol: 'USDCx',
      sourceNetwork: 'miden-testnet',
      destinationSymbol: 'USDC',
      destinationNetwork: 'sepolia'
    };
    const ctx: OrchestratorWalletContext = {
      ...baseCtx,
      bridgeRoutes: [outRoute],
      externalEvmAddress: undefined
    };
    const { map } = redactPrompt('bridge 5000 usdcx to sepolia', { contacts: ctx.contacts });
    const res = compileOutputToResolution(
      {
        op: 'set_intent',
        action: 'bridge',
        amount: { kind: 'exact_ref', ref: 'AMT_1' },
        asset: 'USDCx',
        to_asset: null,
        from_chain: 'miden',
        to_chain: 'sepolia',
        recipient_ref: null,
        provider: null,
        note_type: null,
        earn_op: null
      },
      map,
      ctx
    );

    expect(res.kind).toBe('handoff');
    if (res.kind !== 'handoff' || res.handoff.action !== 'bridge') return;
    expect(res.handoff.jumpToConfirm).toBe(false);
    expect(res.handoff.draft.autoReview).toBe(false);
  });

  it('keeps outbound direction when selecting a bridge-out clarification chip with miden-testnet sourceNetwork', () => {
    const baseCtx = createContext();
    const ctx: OrchestratorWalletContext = {
      ...baseCtx,
      externalEvmAddress: VALID_EVM_ALICE_WORK,
      bridgeRoutes: [
        ...baseCtx.bridgeRoutes,
        {
          id: 'testnet:agglayer:usdcx:sepolia:send',
          provider: 'agglayer',
          mode: 'send',
          sourceSymbol: 'USDCx',
          sourceNetwork: 'miden-testnet',
          destinationSymbol: 'USDC',
          destinationNetwork: 'sepolia',
          estimateFee: '$0.25',
          etaLabel: '~2m'
        },
        {
          id: 'testnet:xreserve:usdcx:sepolia:send',
          provider: 'xreserve',
          mode: 'send',
          sourceSymbol: 'USDCx',
          sourceNetwork: 'miden-testnet',
          destinationSymbol: 'USDC',
          destinationNetwork: 'sepolia',
          estimateFee: '$0.10',
          etaLabel: '~1m'
        }
      ]
    };

    const { map } = redactPrompt('bridge out 10 usdcx to sepolia', { contacts: ctx.contacts });
    const clarifying = compileOutputToResolution(
      {
        op: 'set_intent',
        action: 'bridge',
        amount: { kind: 'exact_ref', ref: 'AMT_1' },
        asset: 'usdcx',
        to_asset: null,
        from_chain: null,
        to_chain: 'sepolia',
        recipient_ref: null,
        provider: null,
        note_type: null,
        earn_op: null
      },
      map,
      ctx
    );

    expect(clarifying.kind).toBe('clarifying');
    if (clarifying.kind !== 'clarifying') return;
    expect(clarifying.chips.map(c => c.id)).toEqual([
      'testnet:agglayer:usdcx:sepolia:send',
      'testnet:xreserve:usdcx:sepolia:send'
    ]);

    const handoff = applyChipSelection(clarifying, clarifying.chips[1]!, ctx);
    expect(handoff.kind).toBe('handoff');
    if (handoff.kind !== 'handoff' || handoff.handoff.action !== 'bridge') return;
    expect(handoff.handoff.draft.direction).toBe('out');
    expect(handoff.handoff.draft.route).toBe('testnet:xreserve:usdcx:sepolia:send');
    expect(handoff.handoff.draft.amount).toBe('10');
  });

  it('compiles chained set_plan outputs and carries resolved output amount into the next step', () => {
    const baseCtx = createContext();
    const ctx: OrchestratorWalletContext = {
      ...baseCtx,
      balances: [
        ...baseCtx.balances,
        {
          tokenId: 'faucet-eth',
          tokenSlug: 'ETH',
          balance: 1,
          balanceBaseUnits: '1000000000000000000',
          fiatPrice: 2000,
          change24h: 0,
          metadata: { symbol: 'ETH', name: 'Ethereum', decimals: 18 }
        }
      ],
      tokenPrices: { ETH: { price: 2000, observedAt: Date.now(), kind: 'market' as const } as never },
      swapTokens: [
        { symbol: 'ETH', faucetId: 'faucet-eth', decimals: 18 },
        { symbol: 'USDCx', faucetId: 'faucet-usdcx', decimals: 6 }
      ],
      bridgeRoutes: [
        {
          id: 'testnet:agglayer:eth:faucet-eth:receive',
          provider: 'agglayer',
          mode: 'receive',
          sourceSymbol: 'ETH',
          sourceNetwork: 'sepolia',
          destinationSymbol: 'ETH',
          destinationNetwork: 'miden-testnet'
        }
      ]
    };

    const { map } = redactPrompt('bridge $10 ETH in, then swap it for USDCX', { contacts: ctx.contacts });
    const planRes = compileOutputToResolution(
      {
        op: 'set_plan',
        steps: [
          {
            action: 'bridge',
            amount: { kind: 'fiat_ref', ref: 'FIAT_AMT_1', currency: 'USD' },
            asset: 'ETH',
            to_asset: null,
            from_chain: null,
            to_chain: 'miden',
            recipient_ref: null,
            provider: null,
            note_type: null,
            earn_op: null
          },
          {
            action: 'swap',
            amount: { kind: 'previous_output' },
            asset: 'ETH',
            to_asset: 'USDCX',
            from_chain: null,
            to_chain: null,
            recipient_ref: null,
            provider: null,
            note_type: null,
            earn_op: null
          }
        ]
      },
      map,
      ctx
    );

    expect(planRes.kind).toBe('plan');
    if (planRes.kind !== 'plan') return;
    expect(planRes.steps).toHaveLength(2);

    const step1Handoff = resolveDraftToAction(planRes.steps[0]!, planRes.map, ctx);
    expect(step1Handoff.kind).toBe('handoff');
    if (step1Handoff.kind !== 'handoff' || step1Handoff.handoff.action !== 'bridge') return;
    expect(step1Handoff.handoff.draft.amount).toBe('0.005');

    const carriedStep2 = carryForwardAmount(planRes.steps[1]!, {
      ...planRes.steps[0]!,
      amount: step1Handoff.handoff.draft.amount
    });
    const step2Handoff = resolveDraftToAction(carriedStep2, planRes.map, ctx);
    expect(step2Handoff.kind).toBe('handoff');
    if (step2Handoff.kind !== 'handoff' || step2Handoff.handoff.action !== 'swap') return;
    expect(step2Handoff.handoff.draft.payAmount).toBe('0.005');
    expect(step2Handoff.handoff.draft.payTokenId).toBe('faucet-eth');
    expect(step2Handoff.handoff.draft.receiveTokenId).toBe('faucet-usdcx');
  });
});

describe('createClarificationSnapshot', () => {
  const ids = [
    `contact:${VALID_MIDEN_ALICE}`,
    `account:${VALID_EVM_ALICE_WORK}`,
    'faucet-of-a-held-token',
    'mtst1owner-1-lender-market'
  ];

  it('sends numbered option ids and only common-ticker symbols', () => {
    const snapshot = createClarificationSnapshot(
      { action: 'swap', assetQuery: 'PEPE', tokenId: 'faucet-of-a-held-token', toAssetQuery: 'usdcx' },
      'amount',
      ids
    );

    expect(snapshot.allowedOptionIds).toEqual(['option_1', 'option_2', 'option_3', 'option_4']);
    expect(snapshot.draft).toMatchObject({ asset: null, to_asset: 'usdcx' });
    const sent = JSON.stringify(snapshot);
    for (const localValue of [...ids, 'PEPE']) expect(sent).not.toContain(localValue);
  });

  it('applies the same rule to the target symbol', () => {
    const snapshot = createClarificationSnapshot({ action: 'swap', toAssetQuery: 'PEPE' }, 'amount', []);

    expect(snapshot.draft).toMatchObject({ asset: null, to_asset: null });
  });
});

describe('the token id behind a bridge route', () => {
  const empty = redactPrompt('', { contacts: [] }).map;
  const route = (provider: string) => ({
    id: `testnet:${provider}:usdcx:sepolia:send`,
    provider,
    mode: 'send' as const,
    sourceSymbol: 'USDCx',
    sourceNetwork: 'miden-testnet',
    destinationSymbol: 'USDC',
    destinationNetwork: 'sepolia'
  });
  const context = (...providers: string[]): OrchestratorWalletContext => {
    const base = createContext();
    return {
      ...base,
      balances: [
        ...base.balances,
        {
          tokenId: 'faucet-usdcx-other',
          tokenSlug: 'USDCx',
          balance: 5,
          balanceBaseUnits: '5000000',
          fiatPrice: 1,
          change24h: 0,
          metadata: { symbol: 'USDCx', name: 'Other USDCx', decimals: 6 }
        }
      ],
      externalEvmAddress: VALID_EVM_ALICE_WORK,
      bridgeRoutes: providers.map(route)
    };
  };
  const held = {
    action: 'bridge' as const,
    assetQuery: 'ETH',
    tokenId: 'faucet-eth',
    fromChain: 'miden',
    toChain: 'sepolia'
  };

  it('is dropped when a bridge chip names a different source symbol', () => {
    const ctx = context('agglayer', 'xreserve');
    const asked = resolveDraftToAction(held, empty, ctx);
    if (asked.kind !== 'clarifying') throw new Error(asked.kind);
    const picked = applyChipSelection(asked, asked.chips[1]!, ctx);

    expect(picked).toMatchObject({ kind: 'clarifying', slot: 'amount', draft: { assetQuery: 'USDCx' } });
    if (picked.kind !== 'clarifying') return;
    expect(picked.draft.tokenId).toBeUndefined();
  });

  it('does not pick the balance for a max amount when it holds a different asset', () => {
    const res = resolveDraftToAction({ ...held, amountIsMax: true }, empty, context('xreserve'));

    expect(res).toMatchObject({ kind: 'handoff', handoff: { draft: { amount: '1000' } } });
  });

  it('stays selected when the route source symbol is the same asset', () => {
    const ctx = context('agglayer', 'xreserve');
    const draft = { ...held, assetQuery: 'usdcx', tokenId: 'faucet-usdcx-other', amountIsMax: true };
    const asked = resolveDraftToAction(draft, empty, ctx);
    if (asked.kind !== 'clarifying') throw new Error(asked.kind);

    expect(applyChipSelection(asked, asked.chips[1]!, ctx)).toMatchObject({
      kind: 'handoff',
      handoff: { draft: { amount: '5' } }
    });
  });
});

describe('a follow-up that names an asset', () => {
  const noPatch = {
    action: null,
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
  const base = {
    action: 'swap' as const,
    assetQuery: 'PEPE',
    tokenId: 'faucet-pepe',
    toAssetQuery: 'ZORK',
    toTokenId: 'faucet-zork'
  };
  const empty = redactPrompt('', { contacts: [] }).map;

  it('drops the old token ids when the assets change', () => {
    const next = applyPatchToDraft(base, { ...noPatch, asset: 'USDC', to_asset: 'MIDEN' }, empty);

    expect(next).toMatchObject({ assetQuery: 'USDC', toAssetQuery: 'MIDEN' });
    expect(next.tokenId).toBeUndefined();
    expect(next.toTokenId).toBeUndefined();
  });

  it('compares and stores a padded symbol without its padding', () => {
    expect(applyPatchToDraft(base, { ...noPatch, asset: ' PEPE ', to_asset: ' ZORK ' }, empty)).toMatchObject({
      assetQuery: 'PEPE',
      tokenId: 'faucet-pepe',
      toAssetQuery: 'ZORK',
      toTokenId: 'faucet-zork'
    });
    const changed = applyPatchToDraft(base, { ...noPatch, asset: ' USDC ' }, empty);
    expect(changed).toMatchObject({ assetQuery: 'USDC', toTokenId: 'faucet-zork' });
    expect(changed.tokenId).toBeUndefined();
  });

  it('keeps the token id when the same symbol is repeated or no asset is named', () => {
    expect(applyPatchToDraft(base, { ...noPatch, asset: 'pepe' }, empty)).toMatchObject({
      tokenId: 'faucet-pepe',
      toTokenId: 'faucet-zork'
    });
    expect(applyPatchToDraft(base, noPatch, empty)).toMatchObject({ tokenId: 'faucet-pepe' });
  });
});
