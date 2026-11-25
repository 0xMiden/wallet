import { formatBigInt, stringToBigInt, typedAmountExceedsBalance } from 'lib/i18n/numbers';
import { maxSendableNativeBaseUnits } from 'lib/miden/fees/spendable';
import type { TokenBalanceData } from 'lib/miden/front/balance';
import { hasKnownScale } from 'lib/miden/metadata/scale';
import { DEFAULT_SWAP_SLIPPAGE_BPS } from 'lib/miden/swap/quote';
import { getSwapPartners, tokenQuote, type SwapToken } from 'lib/miden/swap/tokens';
import type { TokenPrices } from 'lib/prices';
import type { CommandDrafts } from 'screens/command/command-drafts';
import type { CommandAction } from 'screens/command/command-routes';
import { detectAddressChain, isValidEthereumAddress, isValidMidenAddress, MidenAddressError } from 'utils/miden';

import type { RedactedClarificationSnapshot } from './client';
import type { LocalQueryResult } from './local-query';
import {
  resolveAmountRef,
  resolveAssetRef,
  resolveNicheTokenId,
  resolveRecipientRef,
  verifyProvenance,
  type RedactionContact,
  type RedactionMap
} from './redactor';
import type { AiCompilerOutput, AmountExpr, CommandAiAction, IntentSlots, PatchIntentSlots } from './schema';

export interface BridgeRouteSummary {
  id: string;
  provider: string;
  mode: 'receive' | 'send';
  sourceSymbol: string;
  sourceNetwork: string;
  destinationSymbol: string;
  destinationNetwork: string;
  estimateFee?: string;
  etaLabel?: string;
}

export interface EarnSubjectSummary {
  id: string;
  name: string;
  symbol: string;
  collateralFaucetId?: string;
  withdrawable?: string;
  decimals?: number;
}

export type AddressValidationOutcome =
  | { kind: 'valid'; chain: 'miden' | 'ethereum' | 'solana' | 'bitcoin' | 'near' }
  | { kind: 'wrong-network' }
  | { kind: 'ens'; raw: string }
  | { kind: 'incomplete-prefix'; raw: string }
  | { kind: 'invalid'; raw: string };

export interface OrchestratorWalletContext {
  accountPublicKey: string;
  networkName: string;
  balances: readonly TokenBalanceData[];
  tokenPrices: TokenPrices;
  contacts: readonly RedactionContact[];
  swapTokens: readonly SwapToken[];
  bridgeRoutes: readonly BridgeRouteSummary[];
  earnVaults: readonly EarnSubjectSummary[];
  earnPositions: readonly EarnSubjectSummary[];
  nativeFaucetId: string | null;
  verificationBaseFee: number | null;
  externalEvmAddress?: string;
  validateAddress?: (addr: string) => AddressValidationOutcome;
  generateReviewId?: () => string;
}

export interface HydratedIntentDraft {
  action: CommandAiAction;
  amount?: string;
  fiatUsdAmount?: string;
  amountFraction?: { numerator: number; denominator: number };
  amountIsMax?: boolean;
  assetQuery?: string;
  tokenId?: string;
  toAssetQuery?: string;
  toTokenId?: string;
  fromChain?: string;
  toChain?: string;
  recipient?: string;
  recipientLabel?: string;
  recipientNetwork?: string;
  recipientExplicitlySelected?: boolean;
  provider?: string;
  routeId?: string;
  noteType?: 'private' | 'public';
  earnOp?: 'deposit' | 'withdraw';
  earnSubjectId?: string;
}

export interface ClarificationChip {
  id: string;
  label: string;
  subtitle?: string;
  patch: Partial<HydratedIntentDraft>;
}

export type CommandPrefillHandoff =
  | {
      action: 'send';
      path: string;
      jumpToConfirm: boolean;
      draft: CommandDrafts['send'];
    }
  | {
      action: 'swap';
      path: '/swap';
      jumpToConfirm: boolean;
      draft: CommandDrafts['swap'];
    }
  | {
      action: 'bridge';
      path: '/bridge/deposit';
      jumpToConfirm: boolean;
      draft: CommandDrafts['bridge'];
    }
  | {
      action: 'earn';
      path: string;
      jumpToConfirm: boolean;
      draft: CommandDrafts['earn'];
    }
  | {
      action: 'receive';
      path: '/receive';
      jumpToConfirm: false;
      draft?: CommandDrafts['receive'];
    };

export type OrchestratorResolution =
  | { kind: 'handoff'; handoff: CommandPrefillHandoff }
  | {
      kind: 'clarifying';
      slot: string;
      questionKey: string;
      questionParams?: Record<string, string>;
      chips: ClarificationChip[];
      draft: HydratedIntentDraft;
      map: RedactionMap;
      allowedOptionIds: string[];
    }
  | { kind: 'query_result'; result: LocalQueryResult }
  | { kind: 'cancelled' }
  | {
      kind: 'error';
      messageKey: string;
      messageParams?: Record<string, string>;
      fallbackAction?: CommandAction;
    };

const PROVIDER_SYNONYMS: Record<string, string> = {
  epoch: 'epoch',
  fast: 'epoch',
  agglayer: 'agglayer',
  agg: 'agglayer',
  slow: 'agglayer',
  xreserve: 'xreserve',
  circle: 'xreserve',
  cctp: 'xreserve'
};

export function defaultValidateAddress(addr: string): AddressValidationOutcome {
  const trimmed = addr.trim();
  if (/\.eth$/i.test(trimmed)) return { kind: 'ens', raw: trimmed };
  if (/^0x[0-9a-fA-F]*$/i.test(trimmed) && trimmed.length < 42) {
    return { kind: 'incomplete-prefix', raw: trimmed };
  }
  if (/^(?:mm1|mtst1|mdev1|mlcl1)[0-9a-zA-Z_]*$/i.test(trimmed) && trimmed.length < 20) {
    return { kind: 'incomplete-prefix', raw: trimmed };
  }
  const chain = detectAddressChain(trimmed);
  if (chain === 'ethereum') {
    return isValidEthereumAddress(trimmed) ? { kind: 'valid', chain: 'ethereum' } : { kind: 'invalid', raw: trimmed };
  }
  if (chain === 'solana' || chain === 'bitcoin' || chain === 'near') {
    return { kind: 'valid', chain };
  }
  try {
    isValidMidenAddress(trimmed);
    return { kind: 'valid', chain: 'miden' };
  } catch (error) {
    if (error instanceof MidenAddressError && error.reason === 'wrong-network') {
      return { kind: 'wrong-network' };
    }
    return { kind: 'invalid', raw: trimmed };
  }
}

function normalizeProvider(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const lower = value.trim().toLowerCase();
  return PROVIDER_SYNONYMS[lower] ?? lower;
}

function normalizeChain(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const lower = value.trim().toLowerCase();
  if (lower === 'eth' || lower === 'mainnet') return 'ethereum';
  if (lower === 'arb') return 'arbitrum';
  if (lower === 'poly') return 'polygon';
  return lower;
}

function resolveBalanceAsset(
  query: string | undefined,
  tokenId: string | undefined,
  balances: readonly TokenBalanceData[]
): TokenBalanceData | undefined {
  if (tokenId) {
    const byId = balances.find(b => b.tokenId === tokenId);
    if (byId) return byId;
  }
  if (!query) return undefined;
  const q = query.trim().toLowerCase();
  return (
    balances.find(b => b.metadata.symbol.trim().toLowerCase() === q) ??
    balances.find(b => b.metadata.name.trim().toLowerCase() === q) ??
    balances.find(b => b.tokenId.toLowerCase() === q)
  );
}

function resolveSwapAsset(
  query: string | undefined,
  tokenId: string | undefined,
  tokens: readonly SwapToken[]
): SwapToken | undefined {
  if (tokenId) {
    const byId = tokens.find(t => t.faucetId === tokenId);
    if (byId) return byId;
  }
  if (!query) return undefined;
  const q = query.trim().toLowerCase();
  return tokens.find(t => t.symbol.trim().toLowerCase() === q || t.faucetId.toLowerCase() === q);
}

function spendableBaseUnits(
  balance: TokenBalanceData,
  nativeFaucetId: string | null,
  verificationBaseFee: number | null
): bigint {
  if (!hasKnownScale(balance.metadata)) return 0n;
  let baseUnits: bigint;
  if (balance.balanceBaseUnits && /^\d+$/.test(balance.balanceBaseUnits)) {
    baseUnits = BigInt(balance.balanceBaseUnits);
  } else {
    try {
      baseUnits = stringToBigInt(String(balance.balance), balance.metadata.decimals);
    } catch {
      return 0n;
    }
  }
  if (nativeFaucetId && balance.tokenId === nativeFaucetId) {
    return maxSendableNativeBaseUnits(baseUnits, verificationBaseFee);
  }
  return baseUnits;
}

function resolveSymbolicAmount(
  draft: HydratedIntentDraft,
  balance: TokenBalanceData | undefined,
  ctx: OrchestratorWalletContext
): { amount?: string; errorKey?: string } {
  if (draft.amount !== undefined) return { amount: draft.amount };
  if (!balance || !hasKnownScale(balance.metadata)) return {};

  const decimals = balance.metadata.decimals;
  const spendable = spendableBaseUnits(balance, ctx.nativeFaucetId, ctx.verificationBaseFee);

  if (draft.amountIsMax) {
    if (spendable <= 0n) return { errorKey: 'amountMustBeLessThanBalance' };
    return { amount: formatBigInt(spendable, decimals) };
  }
  if (draft.amountFraction) {
    if (spendable <= 0n) return { errorKey: 'amountMustBeLessThanBalance' };
    const { numerator, denominator } = draft.amountFraction;
    const part = (spendable * BigInt(Math.round(numerator))) / BigInt(Math.round(denominator));
    if (part <= 0n) return { errorKey: 'amountMustBeLessThanBalance' };
    return { amount: formatBigInt(part, decimals) };
  }
  if (draft.fiatUsdAmount) {
    const quote = tokenQuote(ctx.tokenPrices, balance.tokenId, balance.metadata.symbol);
    if (!quote || quote.kind === 'nominal' || !Number.isFinite(quote.price) || quote.price <= 0) {
      return { errorKey: 'commandAiFiatPriceUnavailable' };
    }
    const usd = Number(draft.fiatUsdAmount);
    if (!Number.isFinite(usd) || usd <= 0) return {};
    const tokenQty = usd / quote.price;
    const scale = Math.min(decimals, 6);
    const rounded = tokenQty.toFixed(scale).replace(/\.?0+$/, '');
    return { amount: rounded || '0' };
  }
  return {};
}

function applyAmountExpr(amount: AmountExpr | null, map: RedactionMap, target: HydratedIntentDraft): void {
  if (!amount) return;
  target.amount = undefined;
  target.fiatUsdAmount = undefined;
  target.amountFraction = undefined;
  target.amountIsMax = undefined;

  switch (amount.kind) {
    case 'exact_ref': {
      const resolved = resolveAmountRef(amount.ref, map);
      if (resolved !== undefined) target.amount = resolved;
      break;
    }
    case 'fiat_ref': {
      const resolved = resolveAmountRef(amount.ref, map);
      if (resolved !== undefined) target.fiatUsdAmount = resolved;
      break;
    }
    case 'fraction':
      target.amountFraction = { numerator: amount.numerator, denominator: amount.denominator };
      break;
    case 'max':
      target.amountIsMax = true;
      break;
  }
}

function applyAssetSlot(
  value: string | null,
  map: RedactionMap,
  target: HydratedIntentDraft,
  field: 'asset' | 'to_asset'
): void {
  if (!value) return;
  const nicheId = resolveNicheTokenId(value, map);
  const symbol = resolveAssetRef(value, map);
  if (field === 'asset') {
    target.assetQuery = symbol;
    if (nicheId) target.tokenId = nicheId;
  } else {
    target.toAssetQuery = symbol;
    if (nicheId) target.toTokenId = nicheId;
  }
}

function hydrateSlots(slots: IntentSlots, map: RedactionMap): HydratedIntentDraft {
  const draft: HydratedIntentDraft = {
    action: slots.action,
    fromChain: normalizeChain(slots.from_chain),
    toChain: normalizeChain(slots.to_chain),
    provider: normalizeProvider(slots.provider),
    noteType: slots.note_type ?? undefined,
    earnOp: slots.earn_op ?? undefined
  };
  applyAmountExpr(slots.amount, map, draft);
  applyAssetSlot(slots.asset, map, draft, 'asset');
  applyAssetSlot(slots.to_asset, map, draft, 'to_asset');

  if (slots.recipient_ref) {
    const resolved = resolveRecipientRef(slots.recipient_ref, map);
    if (resolved?.kind === 'contact') {
      draft.recipient = resolved.contact.address;
      draft.recipientLabel = resolved.contact.name;
      draft.recipientNetwork = resolved.contact.network;
      draft.recipientExplicitlySelected = false;
    } else if (resolved?.kind === 'addr') {
      draft.recipient = resolved.raw;
    }
  }
  return draft;
}

export function applyPatchToDraft(
  base: HydratedIntentDraft,
  patch: PatchIntentSlots,
  map: RedactionMap
): HydratedIntentDraft {
  const next: HydratedIntentDraft = { ...base };
  if (patch.action) next.action = patch.action;
  if (patch.amount !== null) applyAmountExpr(patch.amount, map, next);
  if (patch.asset !== null) applyAssetSlot(patch.asset, map, next, 'asset');
  if (patch.to_asset !== null) applyAssetSlot(patch.to_asset, map, next, 'to_asset');
  if (patch.from_chain !== null) next.fromChain = normalizeChain(patch.from_chain);
  if (patch.to_chain !== null) next.toChain = normalizeChain(patch.to_chain);
  if (patch.provider !== null) {
    next.provider = normalizeProvider(patch.provider);
    next.routeId = undefined;
  }
  if (patch.note_type !== null) next.noteType = patch.note_type;
  if (patch.earn_op !== null) next.earnOp = patch.earn_op;
  if (patch.recipient_ref !== null) {
    const resolved = resolveRecipientRef(patch.recipient_ref, map);
    if (resolved?.kind === 'contact') {
      next.recipient = resolved.contact.address;
      next.recipientLabel = resolved.contact.name;
      next.recipientNetwork = resolved.contact.network;
      next.recipientExplicitlySelected = false;
    } else if (resolved?.kind === 'addr') {
      next.recipient = resolved.raw;
      next.recipientLabel = undefined;
      next.recipientNetwork = undefined;
      next.recipientExplicitlySelected = false;
    }
  }
  return next;
}

export function createClarificationSnapshot(
  draft: HydratedIntentDraft,
  missingSlot: string,
  allowedOptionIds: string[]
): RedactedClarificationSnapshot {
  return {
    missingSlot,
    allowedOptionIds,
    draft: {
      action: draft.action,
      asset: draft.assetQuery ?? null,
      to_asset: draft.toAssetQuery ?? null,
      from_chain: draft.fromChain ?? null,
      to_chain: draft.toChain ?? null,
      hasAmount: Boolean(draft.amount || draft.amountFraction || draft.amountIsMax || draft.fiatUsdAmount),
      hasRecipient: Boolean(draft.recipient),
      provider: draft.provider ?? null,
      note_type: draft.noteType ?? null,
      earn_op: draft.earnOp ?? null
    }
  };
}

function makeReviewId(ctx: OrchestratorWalletContext): string {
  if (ctx.generateReviewId) return ctx.generateReviewId();
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `ai-${Date.now()}`;
}

function shortAddr(addr: string): string {
  return addr.length > 14 ? `${addr.slice(0, 7)}…${addr.slice(-4)}` : addr;
}

function resolveSendFlow(
  draft: HydratedIntentDraft,
  map: RedactionMap,
  ctx: OrchestratorWalletContext
): OrchestratorResolution {
  const validate = ctx.validateAddress ?? defaultValidateAddress;

  // 1. Validate / disambiguate recipient (including partial hex like `0x02323`).
  if (!draft.recipient) {
    const contactChips: ClarificationChip[] = ctx.contacts.slice(0, 5).map(contact => ({
      id: contact.id,
      label: contact.name,
      subtitle: shortAddr(contact.address),
      patch: {
        recipient: contact.address,
        recipientLabel: contact.name,
        recipientNetwork: contact.network,
        recipientExplicitlySelected: true
      }
    }));
    if (contactChips.length > 0) {
      return {
        kind: 'clarifying',
        slot: 'recipient',
        questionKey: 'commandAiChooseRecipient',
        chips: contactChips,
        draft,
        map,
        allowedOptionIds: contactChips.map(c => c.id)
      };
    }
    return {
      kind: 'error',
      messageKey: 'commandAiMissingRecipient',
      fallbackAction: 'send'
    };
  }

  // Handle ambiguous contact name matches (when user has multiple contacts with identical names).
  if (draft.recipientLabel && !draft.recipientExplicitlySelected) {
    const sameName = ctx.contacts.filter(
      c => c.name.trim().toLowerCase() === draft.recipientLabel!.trim().toLowerCase()
    );
    if (sameName.length > 1) {
      const chips: ClarificationChip[] = sameName.map(c => ({
        id: c.id,
        label: c.name,
        subtitle: shortAddr(c.address),
        patch: {
          recipient: c.address,
          recipientLabel: c.name,
          recipientNetwork: c.network,
          recipientExplicitlySelected: true
        }
      }));
      return {
        kind: 'clarifying',
        slot: 'recipient',
        questionKey: 'commandAiDisambiguateContact',
        chips,
        draft,
        map,
        allowedOptionIds: chips.map(c => c.id)
      };
    }
  }

  const addrStatus = validate(draft.recipient);
  if (addrStatus.kind === 'incomplete-prefix') {
    const prefix = addrStatus.raw.toLowerCase();
    // Address-poisoning defense: search saved contacts / own accounts ONLY, never unsolicited incoming history.
    const prefixMatches = ctx.contacts.filter(c => c.address.toLowerCase().startsWith(prefix));
    if (prefixMatches.length > 0) {
      const chips: ClarificationChip[] = prefixMatches.slice(0, 5).map(c => ({
        id: c.id,
        label: c.name,
        subtitle: shortAddr(c.address),
        patch: {
          recipient: c.address,
          recipientLabel: c.name,
          recipientNetwork: c.network,
          recipientExplicitlySelected: true
        }
      }));
      return {
        kind: 'clarifying',
        slot: 'recipient',
        questionKey: 'commandAiIncompleteAddressMatches',
        questionParams: { prefix: addrStatus.raw },
        chips,
        draft,
        map,
        allowedOptionIds: chips.map(c => c.id)
      };
    }
    return {
      kind: 'error',
      messageKey: 'commandAiIncompleteAddress',
      messageParams: { address: addrStatus.raw },
      fallbackAction: 'send'
    };
  }
  if (addrStatus.kind === 'ens') {
    const contactAlias = ctx.contacts.find(c => c.name.trim().toLowerCase() === addrStatus.raw.toLowerCase());
    if (!contactAlias) {
      return {
        kind: 'error',
        messageKey: 'commandAiEnsUnsupported',
        messageParams: { name: addrStatus.raw },
        fallbackAction: 'send'
      };
    }
  }
  if (addrStatus.kind === 'wrong-network' || addrStatus.kind === 'invalid') {
    return {
      kind: 'error',
      messageKey: addrStatus.kind === 'wrong-network' ? 'commandAiWrongNetworkAddress' : 'commandAiInvalidAddress',
      fallbackAction: 'send'
    };
  }

  // 2. Resolve asset.
  let balance = resolveBalanceAsset(draft.assetQuery, draft.tokenId, ctx.balances);
  if (!balance && !draft.assetQuery) {
    const spendableRows = ctx.balances.filter(b => b.balance > 0 && hasKnownScale(b.metadata));
    if (spendableRows.length === 1) {
      balance = spendableRows[0];
    } else if (spendableRows.length > 1) {
      const chips: ClarificationChip[] = spendableRows.slice(0, 5).map(row => ({
        id: row.tokenId,
        label: row.metadata.symbol,
        subtitle: String(row.balance),
        patch: { assetQuery: row.metadata.symbol, tokenId: row.tokenId }
      }));
      return {
        kind: 'clarifying',
        slot: 'asset',
        questionKey: 'commandAiChooseAsset',
        chips,
        draft,
        map,
        allowedOptionIds: chips.map(c => c.id)
      };
    }
  }

  if (!balance) {
    return {
      kind: 'error',
      messageKey: 'commandAiAssetNotFound',
      messageParams: { asset: draft.assetQuery ?? '' },
      fallbackAction: 'send'
    };
  }

  // 3. Resolve amount.
  const { amount, errorKey } = resolveSymbolicAmount(draft, balance, ctx);
  if (errorKey) {
    return {
      kind: 'handoff',
      handoff: {
        action: 'send',
        path: '/send',
        jumpToConfirm: false,
        draft: {
          amount: '',
          recipientAddress: draft.recipient,
          tokenId: balance.tokenId,
          privacy: draft.noteType ?? 'private'
        }
      }
    };
  }
  if (!amount) {
    const chips: ClarificationChip[] = [
      { id: '25pct', label: '25%', patch: { amountFraction: { numerator: 1, denominator: 4 } } },
      { id: '50pct', label: '50%', patch: { amountFraction: { numerator: 1, denominator: 2 } } },
      { id: 'max', label: 'Max', patch: { amountIsMax: true } }
    ];
    return {
      kind: 'clarifying',
      slot: 'amount',
      questionKey: 'commandAiChooseAmount',
      chips,
      draft: { ...draft, tokenId: balance.tokenId, assetQuery: balance.metadata.symbol },
      map,
      allowedOptionIds: chips.map(c => c.id)
    };
  }

  // 4. Preflight balance check: if balance is insufficient, land on prefilled Edit (/send) instead of /send/review.
  const hasKnown = hasKnownScale(balance.metadata);
  const spendable = spendableBaseUnits(balance, ctx.nativeFaucetId, ctx.verificationBaseFee);
  const spendableHuman = hasKnown ? Number(formatBigInt(spendable, balance.metadata.decimals)) : 0;
  const exceedsBalance =
    !hasKnown || Number(amount) <= 0 || typedAmountExceedsBalance(amount, spendableHuman, balance.metadata.decimals);

  const noteType = draft.noteType ?? 'private';
  if (exceedsBalance) {
    return {
      kind: 'handoff',
      handoff: {
        action: 'send',
        path: '/send',
        jumpToConfirm: false,
        draft: {
          amount,
          recipientAddress: draft.recipient,
          tokenId: balance.tokenId,
          privacy: noteType
        }
      }
    };
  }

  const addrChain = addrStatus.kind === 'valid' ? addrStatus.chain : detectAddressChain(draft.recipient);
  const reviewId = makeReviewId(ctx);
  const params = new URLSearchParams({
    amount,
    to: draft.recipient,
    tokenId: balance.tokenId,
    commandReviewId: reviewId
  });
  const isCrossChain = addrChain !== 'miden';
  const crossChainNetwork = isCrossChain
    ? (draft.toChain ??
      draft.recipientNetwork ??
      (addrChain === 'ethereum' ? (ctx.networkName === 'mainnet' ? 'ethereum' : 'sepolia') : addrChain))
    : undefined;
  const crossChainRoute =
    isCrossChain &&
    draft.provider &&
    (draft.provider === 'epoch' ||
      draft.provider === 'agglayer' ||
      draft.provider === 'usdcx' ||
      draft.provider === 'near-intents')
      ? draft.provider
      : isCrossChain && (addrChain === 'solana' || addrChain === 'bitcoin' || addrChain === 'near')
        ? 'near-intents'
        : undefined;
  if (crossChainNetwork) params.set('network', crossChainNetwork);
  if (crossChainRoute) params.set('route', crossChainRoute);

  return {
    kind: 'handoff',
    handoff: {
      action: 'send',
      path: `/send/review?${params.toString()}`,
      jumpToConfirm: true,
      draft: {
        amount,
        recipientAddress: draft.recipient,
        tokenId: balance.tokenId,
        privacy: noteType,
        reviewId,
        ...(crossChainNetwork ? { bridgeNetwork: crossChainNetwork } : {}),
        ...(crossChainRoute ? { bridgeRoute: crossChainRoute } : {})
      }
    }
  };
}

function isMidenChain(value: string | undefined): boolean {
  if (!value) return false;
  const lower = value.trim().toLowerCase();
  return lower === 'miden' || lower.startsWith('miden-');
}

function resolveBridgeFlow(
  draft: HydratedIntentDraft,
  map: RedactionMap,
  ctx: OrchestratorWalletContext
): OrchestratorResolution {
  let candidates: readonly BridgeRouteSummary[];
  if (draft.routeId) {
    const exactRoute = ctx.bridgeRoutes.find(r => r.id === draft.routeId);
    candidates = exactRoute ? [exactRoute] : [];
  } else {
    const fromChain = draft.fromChain;
    const toChain = draft.toChain;
    const direction: 'in' | 'out' | undefined =
      isMidenChain(toChain) || (fromChain && !isMidenChain(fromChain))
        ? 'in'
        : isMidenChain(fromChain) || (toChain && !isMidenChain(toChain))
          ? 'out'
          : undefined;

    candidates = ctx.bridgeRoutes;
    if (direction) {
      candidates = candidates.filter(r => r.mode === (direction === 'in' ? 'receive' : 'send'));
    }
    if (draft.assetQuery) {
      const assetLower = draft.assetQuery.trim().toLowerCase();
      const assetMatches = candidates.filter(
        r =>
          r.sourceSymbol.toLowerCase() === assetLower ||
          r.destinationSymbol.toLowerCase() === assetLower ||
          (assetLower === 'usdc' &&
            (r.sourceSymbol.toLowerCase() === 'usdcx' || r.destinationSymbol.toLowerCase() === 'usdcx'))
      );
      if (assetMatches.length > 0) candidates = assetMatches;
    }
    if (fromChain && !isMidenChain(fromChain)) {
      const chainMatches = candidates.filter(r => r.sourceNetwork.toLowerCase().includes(fromChain));
      if (chainMatches.length > 0) candidates = chainMatches;
    }
    if (toChain && !isMidenChain(toChain)) {
      const chainMatches = candidates.filter(r => r.destinationNetwork.toLowerCase().includes(toChain));
      if (chainMatches.length > 0) candidates = chainMatches;
    }
    if (draft.provider) {
      const byProvider = candidates.filter(r => r.provider.toLowerCase() === draft.provider);
      if (byProvider.length > 0) candidates = byProvider;
    }
  }

  if (candidates.length === 0) {
    return {
      kind: 'error',
      messageKey: 'commandAiBridgeUnavailable',
      fallbackAction: 'bridge'
    };
  }

  // Clarification needed when multiple bridge routes/providers remain eligible.
  if (candidates.length > 1) {
    const chips: ClarificationChip[] = candidates.slice(0, 6).map(route => ({
      id: route.id,
      label: `${route.provider} (${route.sourceNetwork} → ${route.destinationNetwork})`,
      subtitle: [route.estimateFee, route.etaLabel].filter(Boolean).join(' · ') || undefined,
      patch: {
        routeId: route.id,
        provider: route.provider,
        fromChain: route.sourceNetwork,
        toChain: route.destinationNetwork,
        assetQuery: route.sourceSymbol
      }
    }));
    return {
      kind: 'clarifying',
      slot: 'provider',
      questionKey: 'commandAiChooseBridge',
      chips,
      draft,
      map,
      allowedOptionIds: chips.map(c => c.id)
    };
  }

  const chosen = candidates[0]!;
  const routeDirection: 'in' | 'out' = chosen.mode === 'receive' ? 'in' : 'out';
  const sourceBalance = resolveBalanceAsset(chosen.sourceSymbol, draft.tokenId, ctx.balances);
  const { amount } = resolveSymbolicAmount(draft, sourceBalance, ctx);

  if (!amount) {
    const chips: ClarificationChip[] = [
      { id: '100', label: `100 ${chosen.sourceSymbol}`, patch: { amount: '100', routeId: chosen.id } },
      { id: '500', label: `500 ${chosen.sourceSymbol}`, patch: { amount: '500', routeId: chosen.id } },
      { id: 'max', label: 'Max', patch: { amountIsMax: true, routeId: chosen.id } }
    ];
    return {
      kind: 'clarifying',
      slot: 'amount',
      questionKey: 'commandAiChooseAmount',
      chips,
      draft: { ...draft, routeId: chosen.id, provider: chosen.provider },
      map,
      allowedOptionIds: chips.map(c => c.id)
    };
  }

  const externalAccountId =
    routeDirection === 'out' ? (draft.recipient ?? ctx.externalEvmAddress ?? '') : (ctx.externalEvmAddress ?? '');
  let exceedsOutBalance = false;
  if (routeDirection === 'out') {
    const hasKnown = Boolean(sourceBalance && hasKnownScale(sourceBalance.metadata));
    const spendable =
      sourceBalance && hasKnown ? spendableBaseUnits(sourceBalance, ctx.nativeFaucetId, ctx.verificationBaseFee) : 0n;
    const spendableHuman =
      sourceBalance && hasKnown ? Number(formatBigInt(spendable, sourceBalance.metadata.decimals)) : 0;
    exceedsOutBalance =
      !sourceBalance ||
      !hasKnown ||
      Number(amount) <= 0 ||
      typedAmountExceedsBalance(amount, spendableHuman, sourceBalance.metadata.decimals);
  }
  const canAutoReview = !exceedsOutBalance && (routeDirection === 'in' || Boolean(externalAccountId));

  return {
    kind: 'handoff',
    handoff: {
      action: 'bridge',
      path: '/bridge/deposit',
      jumpToConfirm: canAutoReview,
      draft: {
        direction: routeDirection,
        route: chosen.id,
        amount,
        externalAccountId,
        autoReview: canAutoReview
      }
    }
  };
}

function resolveSwapFlow(
  draft: HydratedIntentDraft,
  map: RedactionMap,
  ctx: OrchestratorWalletContext
): OrchestratorResolution {
  const offer = resolveSwapAsset(draft.assetQuery, draft.tokenId, ctx.swapTokens);
  if (!offer) {
    if (ctx.swapTokens.length === 0) {
      return { kind: 'error', messageKey: 'commandAiSwapUnavailable', fallbackAction: 'swap' };
    }
    const chips: ClarificationChip[] = ctx.swapTokens.slice(0, 5).map(tok => ({
      id: tok.faucetId,
      label: tok.symbol,
      patch: { assetQuery: tok.symbol, tokenId: tok.faucetId }
    }));
    return {
      kind: 'clarifying',
      slot: 'asset',
      questionKey: 'commandAiChooseAsset',
      chips,
      draft,
      map,
      allowedOptionIds: chips.map(c => c.id)
    };
  }

  let receive = resolveSwapAsset(draft.toAssetQuery, draft.toTokenId, ctx.swapTokens);
  if (!receive) {
    const partners = getSwapPartners(offer.faucetId);
    const choices = partners.length > 0 ? partners : ctx.swapTokens.filter(t => t.faucetId !== offer.faucetId);
    if (choices.length === 1) {
      receive = choices[0];
    } else if (choices.length > 1) {
      const chips: ClarificationChip[] = choices.slice(0, 5).map(tok => ({
        id: tok.faucetId,
        label: tok.symbol,
        patch: { toAssetQuery: tok.symbol, toTokenId: tok.faucetId }
      }));
      return {
        kind: 'clarifying',
        slot: 'to_asset',
        questionKey: 'commandAiChooseSwapTarget',
        chips,
        draft: { ...draft, assetQuery: offer.symbol, tokenId: offer.faucetId },
        map,
        allowedOptionIds: chips.map(c => c.id)
      };
    }
  }

  if (!receive || receive.faucetId === offer.faucetId) {
    return { kind: 'error', messageKey: 'commandAiSwapUnavailable', fallbackAction: 'swap' };
  }

  const offerBalance = resolveBalanceAsset(offer.symbol, offer.faucetId, ctx.balances);
  const { amount } = resolveSymbolicAmount(draft, offerBalance, ctx);
  if (!amount) {
    const chips: ClarificationChip[] = [
      { id: '25pct', label: '25%', patch: { amountFraction: { numerator: 1, denominator: 4 } } },
      { id: '50pct', label: '50%', patch: { amountFraction: { numerator: 1, denominator: 2 } } },
      { id: 'max', label: 'Max', patch: { amountIsMax: true } }
    ];
    return {
      kind: 'clarifying',
      slot: 'amount',
      questionKey: 'commandAiChooseAmount',
      chips,
      draft: {
        ...draft,
        assetQuery: offer.symbol,
        tokenId: offer.faucetId,
        toAssetQuery: receive.symbol,
        toTokenId: receive.faucetId
      },
      map,
      allowedOptionIds: chips.map(c => c.id)
    };
  }

  const spendable = offerBalance ? spendableBaseUnits(offerBalance, ctx.nativeFaucetId, ctx.verificationBaseFee) : 0n;
  const spendableHuman = Number(formatBigInt(spendable, offer.decimals));
  const canConfirm =
    Boolean(offerBalance) && Number(amount) > 0 && !typedAmountExceedsBalance(amount, spendableHuman, offer.decimals);

  return {
    kind: 'handoff',
    handoff: {
      action: 'swap',
      path: '/swap',
      jumpToConfirm: canConfirm,
      draft: {
        engine: 'swap',
        payTokenId: offer.faucetId,
        receiveTokenId: receive.faucetId,
        payAmount: amount,
        expirySeconds: '120',
        slippageBps: DEFAULT_SWAP_SLIPPAGE_BPS,
        autoAccept: true,
        autoReview: canConfirm
      }
    }
  };
}

function resolveEarnFlow(
  draft: HydratedIntentDraft,
  map: RedactionMap,
  ctx: OrchestratorWalletContext
): OrchestratorResolution {
  const mode = draft.earnOp ?? 'deposit';
  const subjects = mode === 'deposit' ? ctx.earnVaults : ctx.earnPositions;
  if (subjects.length === 0) {
    return { kind: 'error', messageKey: 'commandAiEarnUnavailable', fallbackAction: 'earn' };
  }

  let subject = draft.earnSubjectId ? subjects.find(s => s.id === draft.earnSubjectId) : undefined;
  if (!subject && subjects.length === 1) {
    subject = subjects[0];
  } else if (!subject && draft.assetQuery) {
    const q = draft.assetQuery.trim().toLowerCase();
    const matches = subjects.filter(s => s.symbol.toLowerCase() === q || s.name.toLowerCase().includes(q));
    if (matches.length === 1) subject = matches[0];
  }

  if (!subject) {
    const chips: ClarificationChip[] = subjects.slice(0, 5).map(item => ({
      id: item.id,
      label: item.name,
      subtitle: item.symbol,
      patch: { earnSubjectId: item.id, earnOp: mode }
    }));
    return {
      kind: 'clarifying',
      slot: 'earn_subject',
      questionKey: mode === 'deposit' ? 'commandAiChooseEarnVault' : 'commandAiChooseEarnPosition',
      chips,
      draft: { ...draft, earnOp: mode },
      map,
      allowedOptionIds: chips.map(c => c.id)
    };
  }

  const balance = resolveBalanceAsset(subject.symbol, subject.collateralFaucetId, ctx.balances);
  const { amount } = resolveSymbolicAmount(draft, balance, ctx);
  if (!amount) {
    return {
      kind: 'handoff',
      handoff: {
        action: 'earn',
        path:
          mode === 'deposit'
            ? `/earn/vaults/${encodeURIComponent(subject.id)}/deposit`
            : `/earn/positions/${encodeURIComponent(subject.id)}/withdraw`,
        jumpToConfirm: false,
        draft: { mode, subjectId: subject.id, amount: '' }
      }
    };
  }

  const reviewPath =
    mode === 'deposit' && subject.collateralFaucetId
      ? `/earn/vaults/${encodeURIComponent(subject.id)}/deposit/review?amount=${encodeURIComponent(amount)}&collateral=${encodeURIComponent(subject.collateralFaucetId)}`
      : mode === 'withdraw'
        ? `/earn/positions/${encodeURIComponent(subject.id)}/withdraw/review?amount=${encodeURIComponent(amount)}`
        : `/earn/vaults/${encodeURIComponent(subject.id)}/deposit`;

  return {
    kind: 'handoff',
    handoff: {
      action: 'earn',
      path: reviewPath,
      jumpToConfirm: mode === 'withdraw' || Boolean(subject.collateralFaucetId),
      draft: { mode, subjectId: subject.id, amount }
    }
  };
}

export function resolveDraftToAction(
  draft: HydratedIntentDraft,
  map: RedactionMap,
  ctx: OrchestratorWalletContext
): OrchestratorResolution {
  switch (draft.action) {
    case 'send':
      return resolveSendFlow(draft, map, ctx);
    case 'bridge':
      return resolveBridgeFlow(draft, map, ctx);
    case 'swap':
      return resolveSwapFlow(draft, map, ctx);
    case 'earn':
      return resolveEarnFlow(draft, map, ctx);
    case 'receive': {
      const balance = resolveBalanceAsset(draft.assetQuery, draft.tokenId, ctx.balances);
      return {
        kind: 'handoff',
        handoff: {
          action: 'receive',
          path: '/receive',
          jumpToConfirm: false,
          ...(balance ? { draft: { faucetId: balance.tokenId } } : {})
        }
      };
    }
  }
}

export function applyChipSelection(
  clarifying: Extract<OrchestratorResolution, { kind: 'clarifying' }>,
  chip: ClarificationChip,
  ctx: OrchestratorWalletContext
): OrchestratorResolution {
  const updated: HydratedIntentDraft = { ...clarifying.draft, ...chip.patch };
  return resolveDraftToAction(updated, clarifying.map, ctx);
}

export function compileOutputToResolution(
  output: AiCompilerOutput,
  map: RedactionMap,
  ctx: OrchestratorWalletContext,
  existingDraft?: HydratedIntentDraft
): OrchestratorResolution {
  if (!verifyProvenance(output, map)) {
    return {
      kind: 'error',
      messageKey: 'commandAiInvalidModelOutput'
    };
  }

  switch (output.op) {
    case 'cancel':
      return { kind: 'cancelled' };
    case 'unsupported':
      return {
        kind: 'error',
        messageKey: 'commandAiUnsupported',
        fallbackAction: output.suggested_route ?? undefined
      };
    case 'set_intent':
      return resolveDraftToAction(hydrateSlots(output, map), map, ctx);
    case 'patch_slots':
      if (!existingDraft) {
        return { kind: 'error', messageKey: 'commandAiNoActiveDraft' };
      }
      return resolveDraftToAction(applyPatchToDraft(existingDraft, output.patch, map), map, ctx);
    case 'query_ledger':
      throw new Error('Use executeLocalLedgerQuery for query_ledger outputs');
  }
}
