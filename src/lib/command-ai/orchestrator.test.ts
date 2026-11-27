import {
  applyChipSelection,
  carryForwardAmount,
  compileOutputToResolution,
  resolveDraftToAction,
  type OrchestratorWalletContext
} from './orchestrator';
import { mergeRedactionMaps, redactPrompt } from './redactor';

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

  describe('bridge request with no matching route', () => {
    const inRoute = (id: string, symbol: string, network: string, provider = 'agglayer') => ({
      id,
      provider,
      mode: 'receive' as const,
      sourceSymbol: symbol,
      sourceNetwork: network,
      destinationSymbol: symbol === 'USDC' ? 'USDCx' : symbol,
      destinationNetwork: 'miden-testnet'
    });
    const usdc = inRoute('in-usdc', 'USDC', 'sepolia', 'xreserve');
    const eth = inRoute('in-eth', 'ETH', 'base-sepolia');
    const out = {
      id: 'out-usdcx',
      provider: 'xreserve',
      mode: 'send' as const,
      sourceSymbol: 'USDCx',
      sourceNetwork: 'miden-testnet',
      destinationSymbol: 'USDC',
      destinationNetwork: 'sepolia'
    };
    const context = () => ({ ...createContext(), bridgeRoutes: [usdc, eth, out] });
    const request = (draft: Partial<Parameters<typeof resolveDraftToAction>[0]>) =>
      resolveDraftToAction(
        { action: 'bridge', amount: '5', ...draft },
        redactPrompt('bridge', { contacts: [] }).map,
        context()
      );
    const expectNoRoute = (res: ReturnType<typeof request>, offered: string[]) => {
      if (res.kind !== 'clarifying') throw new Error(`expected a clarification, got ${res.kind}`);
      expect(res.questionKey).toBe('commandAiBridgeNoRoute');
      expect(res.chips.map(chip => chip.id)).toEqual(offered);
      return res;
    };

    it.each([
      ['an unlisted asset', { assetQuery: 'WBTC', toChain: 'miden' }, ['in-usdc', 'in-eth']],
      ['an asset and network that never meet', { assetQuery: 'ETH', fromChain: 'sepolia' }, ['in-usdc', 'in-eth']],
      ['an unlisted source network', { fromChain: 'solana', toChain: 'miden' }, ['in-usdc', 'in-eth']],
      [
        'an unlisted destination pair',
        { assetQuery: 'USDC', toAssetQuery: 'ETH', toChain: 'miden' },
        ['in-usdc', 'in-eth']
      ],
      [
        'a provider that does not serve it',
        { assetQuery: 'ETH', provider: 'epoch', toChain: 'miden' },
        ['in-usdc', 'in-eth']
      ],
      // One other route must still be offered, never picked for the user.
      [
        'an asset with a single other route',
        { assetQuery: 'USDCx', fromChain: 'miden', toChain: 'solana' },
        ['out-usdcx']
      ],
      ['a route that left the catalog', { routeId: 'gone' }, ['in-usdc', 'in-eth', 'out-usdcx']]
    ])('says there is no route for %s and offers the others', (_label, draft, offered) => {
      expect(expectNoRoute(request(draft), offered).slot).toBe('route');
    });

    it('does not carry an amount over to a different asset', () => {
      const res = expectNoRoute(request({ assetQuery: 'WBTC', tokenId: 'faucet-wbtc', toChain: 'miden' }), [
        'in-usdc',
        'in-eth'
      ]);
      const next = applyChipSelection(res, res.chips[1]!, context());
      if (next.kind !== 'clarifying') throw new Error(`expected a clarification, got ${next.kind}`);
      expect(next.slot).toBe('amount');
      expect(next.draft.amount).toBeUndefined();
      expect(next.draft.tokenId).toBeUndefined();
    });

    it('keeps the amount when the chosen route moves the requested asset', () => {
      const res = expectNoRoute(request({ assetQuery: 'ETH', fromChain: 'sepolia' }), ['in-usdc', 'in-eth']);
      const next = applyChipSelection(res, res.chips[1]!, context());
      if (next.kind !== 'handoff' || next.handoff.action !== 'bridge') throw new Error('expected a bridge handoff');
      expect(next.handoff.draft).toMatchObject({ route: 'in-eth', amount: '5' });
    });

    it('still reports unavailable when there is no route at all', () => {
      const res = resolveDraftToAction(
        { action: 'bridge', amount: '5' },
        redactPrompt('bridge', { contacts: [] }).map,
        { ...createContext(), bridgeRoutes: [] }
      );
      expect(res).toMatchObject({ kind: 'error', messageKey: 'commandAiBridgeUnavailable' });
    });

    const patch = (fields: Partial<Record<'asset' | 'to_asset' | 'from_chain' | 'to_chain', string>>) => ({
      op: 'patch_slots' as const,
      patch: {
        action: null,
        amount: null,
        asset: null,
        to_asset: null,
        from_chain: null,
        to_chain: null,
        recipient_ref: null,
        provider: null,
        note_type: null,
        earn_op: null,
        ...fields
      }
    });

    it.each([{ asset: 'WBTC' }, { to_asset: 'WBTC' }, { from_chain: 'solana' }, { to_chain: 'solana' }])(
      'drops the chosen route when a follow-up changes it to %o',
      fields => {
        const res = compileOutputToResolution(patch(fields), redactPrompt('x', { contacts: [] }).map, context(), {
          action: 'bridge',
          routeId: 'in-eth',
          assetQuery: 'ETH',
          fromChain: 'base-sepolia',
          toChain: 'miden-testnet'
        });
        expect(res).toMatchObject({ kind: 'clarifying', questionKey: 'commandAiBridgeNoRoute' });
      }
    );

    it('reads a network written with spaces or a mainnet suffix', () => {
      const intent = (from_chain: string) =>
        compileOutputToResolution(
          { ...patch({}).patch, op: 'set_intent', action: 'bridge', from_chain, to_chain: 'Miden Testnet' },
          redactPrompt('x', { contacts: [] }).map,
          context()
        );
      expect(intent('Base Sepolia')).toMatchObject({
        kind: 'clarifying',
        slot: 'amount',
        draft: { routeId: 'in-eth' }
      });
      expect(
        compileOutputToResolution(
          { ...patch({}).patch, op: 'set_intent', action: 'bridge', from_chain: 'Ethereum Mainnet', to_chain: null },
          redactPrompt('x', { contacts: [] }).map,
          { ...createContext(), bridgeRoutes: [inRoute('main-eth', 'ETH', 'ethereum'), usdc] }
        )
      ).toMatchObject({ kind: 'clarifying', slot: 'amount', draft: { routeId: 'main-eth' } });
    });

    const intent = (from_chain: string, bridgeRoutes: ReturnType<typeof context>['bridgeRoutes']) =>
      compileOutputToResolution(
        { ...patch({}).patch, op: 'set_intent', action: 'bridge', from_chain, to_chain: 'Miden Testnet' },
        redactPrompt('x', { contacts: [] }).map,
        { ...createContext(), bridgeRoutes }
      );

    it.each([
      ['a Miden network no route is on', { toChain: 'miden-devnet' }],
      ['a bridge from Miden to Miden', { fromChain: 'miden', toChain: 'miden' }]
    ])('says there is no route for %s', (_label, draft) => {
      expectNoRoute(request(draft), ['in-usdc', 'in-eth']);
    });

    it('does not take a testnet route for a stated mainnet', () => {
      const res = intent('Base Mainnet', [usdc, eth]);
      expect(res).toMatchObject({ kind: 'clarifying', slot: 'route', questionKey: 'commandAiBridgeNoRoute' });
    });

    it('does not take a testnet route when a follow-up states mainnet', () => {
      const res = compileOutputToResolution(
        patch({ from_chain: 'Base Mainnet' }),
        redactPrompt('x', { contacts: [] }).map,
        context(),
        { action: 'bridge', routeId: 'in-eth', fromChain: 'base-sepolia', toChain: 'miden-testnet' }
      );
      expect(res).toMatchObject({ kind: 'clarifying', slot: 'route', questionKey: 'commandAiBridgeNoRoute' });
    });

    it('selects the mainnet route for a stated mainnet and keeps the testnet variant for a bare name', () => {
      const base = inRoute('main-base', 'ETH', 'base');
      expect(intent('Base Mainnet', [base, eth])).toMatchObject({ draft: { routeId: 'main-base' } });
      expect(intent('base', [usdc, eth])).toMatchObject({ draft: { routeId: 'in-eth' } });
      const miden = { ...usdc, id: 'main-miden', destinationNetwork: 'miden-mainnet' };
      expect(
        resolveDraftToAction(
          { action: 'bridge', amount: '5', toChain: 'miden-mainnet' },
          redactPrompt('bridge', { contacts: [] }).map,
          { ...createContext(), bridgeRoutes: [miden, eth] }
        )
      ).toMatchObject({ handoff: { draft: { route: 'main-miden' } } });
    });

    it('names a send network without the mainnet suffix', () => {
      const res = compileOutputToResolution(
        {
          ...patch({}).patch,
          op: 'set_intent',
          action: 'send',
          amount: { kind: 'exact_ref', ref: 'AMT_1' },
          asset: 'USDCx',
          to_chain: 'Ethereum Mainnet',
          recipient_ref: 'CONTACT_1'
        },
        redactPrompt('send 2 USDCx to Alice Work', { contacts: createContext().contacts }).map,
        createContext()
      );
      expect(res).toMatchObject({ handoff: { draft: { bridgeNetwork: 'ethereum' } } });
    });
  });
});
