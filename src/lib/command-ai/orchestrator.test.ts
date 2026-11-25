import { applyChipSelection, compileOutputToResolution, type OrchestratorWalletContext } from './orchestrator';
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
});
