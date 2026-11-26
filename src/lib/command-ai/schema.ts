export type CommandAiAction = 'send' | 'swap' | 'bridge' | 'earn' | 'receive';

export type AmountExpr =
  | { kind: 'exact_ref'; ref: string }
  | { kind: 'fiat_ref'; ref: string; currency: 'USD' }
  | { kind: 'fraction'; numerator: number; denominator: number }
  | { kind: 'max' }
  | { kind: 'previous_output' };

export interface IntentSlots {
  action: CommandAiAction;
  amount: AmountExpr | null;
  asset: string | null;
  to_asset: string | null;
  from_chain: string | null;
  to_chain: string | null;
  recipient_ref: string | null;
  provider: string | null;
  note_type: 'private' | 'public' | null;
  earn_op: 'deposit' | 'withdraw' | null;
}

export interface PatchIntentSlots {
  action: CommandAiAction | null;
  amount: AmountExpr | null;
  asset: string | null;
  to_asset: string | null;
  from_chain: string | null;
  to_chain: string | null;
  recipient_ref: string | null;
  provider: string | null;
  note_type: 'private' | 'public' | null;
  earn_op: 'deposit' | 'withdraw' | null;
}

export type LedgerQueryType = 'balance' | 'tx_sum' | 'tx_list';
export type LedgerDirection = 'in' | 'out' | 'all';
export type LedgerTimeWindow = 'today' | 'last_7d' | 'this_month' | 'prev_month' | 'all_time';

export type AiCompilerOutput =
  | ({ op: 'set_intent' } & IntentSlots)
  | { op: 'set_plan'; steps: IntentSlots[] }
  | { op: 'patch_slots'; patch: PatchIntentSlots }
  | {
      op: 'query_ledger';
      query: LedgerQueryType;
      asset: string | null;
      counterparty_ref: string | null;
      direction: LedgerDirection;
      window: LedgerTimeWindow;
    }
  | { op: 'cancel' }
  | { op: 'unsupported'; reason: string; suggested_route: CommandAiAction | null };

const ACTION_ENUM = ['send', 'swap', 'bridge', 'earn', 'receive'] as const;
const NOTE_TYPE_ENUM = ['private', 'public'] as const;
const EARN_OP_ENUM = ['deposit', 'withdraw'] as const;
const QUERY_TYPE_ENUM = ['balance', 'tx_sum', 'tx_list'] as const;
const DIRECTION_ENUM = ['in', 'out', 'all'] as const;
const WINDOW_ENUM = ['today', 'last_7d', 'this_month', 'prev_month', 'all_time'] as const;

const NULLABLE_STRING = { type: ['string', 'null'] };

const AMOUNT_EXPR_VARIANTS = [
  {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'ref'],
    properties: {
      kind: { type: 'string', enum: ['exact_ref'] },
      ref: { type: 'string' }
    }
  },
  {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'ref', 'currency'],
    properties: {
      kind: { type: 'string', enum: ['fiat_ref'] },
      ref: { type: 'string' },
      currency: { type: 'string', enum: ['USD'] }
    }
  },
  {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'numerator', 'denominator'],
    properties: {
      kind: { type: 'string', enum: ['fraction'] },
      numerator: { type: 'number' },
      denominator: { type: 'number' }
    }
  },
  {
    type: 'object',
    additionalProperties: false,
    required: ['kind'],
    properties: {
      kind: { type: 'string', enum: ['max'] }
    }
  },
  {
    type: 'object',
    additionalProperties: false,
    required: ['kind'],
    properties: {
      kind: { type: 'string', enum: ['previous_output'] }
    }
  }
];

const NULLABLE_AMOUNT_SCHEMA = {
  anyOf: [...AMOUNT_EXPR_VARIANTS, { type: 'null' }]
};

const SET_INTENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'op',
    'action',
    'amount',
    'asset',
    'to_asset',
    'from_chain',
    'to_chain',
    'recipient_ref',
    'provider',
    'note_type',
    'earn_op'
  ],
  properties: {
    op: { type: 'string', enum: ['set_intent'] },
    action: { type: 'string', enum: [...ACTION_ENUM] },
    amount: NULLABLE_AMOUNT_SCHEMA,
    asset: NULLABLE_STRING,
    to_asset: NULLABLE_STRING,
    from_chain: NULLABLE_STRING,
    to_chain: NULLABLE_STRING,
    recipient_ref: NULLABLE_STRING,
    provider: NULLABLE_STRING,
    note_type: { type: ['string', 'null'], enum: [...NOTE_TYPE_ENUM, null] },
    earn_op: { type: ['string', 'null'], enum: [...EARN_OP_ENUM, null] }
  }
};

const INTENT_SLOT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'action',
    'amount',
    'asset',
    'to_asset',
    'from_chain',
    'to_chain',
    'recipient_ref',
    'provider',
    'note_type',
    'earn_op'
  ],
  properties: {
    action: { type: 'string', enum: [...ACTION_ENUM] },
    amount: NULLABLE_AMOUNT_SCHEMA,
    asset: NULLABLE_STRING,
    to_asset: NULLABLE_STRING,
    from_chain: NULLABLE_STRING,
    to_chain: NULLABLE_STRING,
    recipient_ref: NULLABLE_STRING,
    provider: NULLABLE_STRING,
    note_type: { type: ['string', 'null'], enum: [...NOTE_TYPE_ENUM, null] },
    earn_op: { type: ['string', 'null'], enum: [...EARN_OP_ENUM, null] }
  }
};

const SET_PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['op', 'steps'],
  properties: {
    op: { type: 'string', enum: ['set_plan'] },
    steps: {
      type: 'array',
      items: INTENT_SLOT_SCHEMA
    }
  }
};

const PATCH_SLOTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['op', 'patch'],
  properties: {
    op: { type: 'string', enum: ['patch_slots'] },
    patch: {
      type: 'object',
      additionalProperties: false,
      required: [
        'action',
        'amount',
        'asset',
        'to_asset',
        'from_chain',
        'to_chain',
        'recipient_ref',
        'provider',
        'note_type',
        'earn_op'
      ],
      properties: {
        action: { type: ['string', 'null'], enum: [...ACTION_ENUM, null] },
        amount: NULLABLE_AMOUNT_SCHEMA,
        asset: NULLABLE_STRING,
        to_asset: NULLABLE_STRING,
        from_chain: NULLABLE_STRING,
        to_chain: NULLABLE_STRING,
        recipient_ref: NULLABLE_STRING,
        provider: NULLABLE_STRING,
        note_type: { type: ['string', 'null'], enum: [...NOTE_TYPE_ENUM, null] },
        earn_op: { type: ['string', 'null'], enum: [...EARN_OP_ENUM, null] }
      }
    }
  }
};

const QUERY_LEDGER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['op', 'query', 'asset', 'counterparty_ref', 'direction', 'window'],
  properties: {
    op: { type: 'string', enum: ['query_ledger'] },
    query: { type: 'string', enum: [...QUERY_TYPE_ENUM] },
    asset: NULLABLE_STRING,
    counterparty_ref: NULLABLE_STRING,
    direction: { type: 'string', enum: [...DIRECTION_ENUM] },
    window: { type: 'string', enum: [...WINDOW_ENUM] }
  }
};

const CANCEL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['op'],
  properties: {
    op: { type: 'string', enum: ['cancel'] }
  }
};

const UNSUPPORTED_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['op', 'reason', 'suggested_route'],
  properties: {
    op: { type: 'string', enum: ['unsupported'] },
    reason: { type: 'string' },
    suggested_route: { type: ['string', 'null'], enum: [...ACTION_ENUM, null] }
  }
};

/**
 * Root object envelope required by strict JSON Schema structured outputs (Groq / OpenAI).
 * Wrapping the discriminated union inside `result` guarantees compatibility while keeping
 * `parseAiCompilerOutput` strict and deterministic.
 */
export const COMMAND_AI_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['result'],
  properties: {
    result: {
      anyOf: [
        SET_INTENT_SCHEMA,
        SET_PLAN_SCHEMA,
        PATCH_SLOTS_SCHEMA,
        QUERY_LEDGER_SCHEMA,
        CANCEL_SCHEMA,
        UNSUPPORTED_SCHEMA
      ]
    }
  }
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOneOf<const T extends readonly string[]>(value: unknown, allowed: T): value is T[number] {
  return typeof value === 'string' && allowed.includes(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function parseAmountExpr(value: unknown): AmountExpr | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  switch (value.kind) {
    case 'exact_ref':
      return typeof value.ref === 'string' && value.ref.length > 0 ? { kind: 'exact_ref', ref: value.ref } : undefined;
    case 'fiat_ref':
      return typeof value.ref === 'string' && value.ref.length > 0 && value.currency === 'USD'
        ? { kind: 'fiat_ref', ref: value.ref, currency: 'USD' }
        : undefined;
    case 'fraction': {
      const { numerator, denominator } = value;
      if (
        typeof numerator !== 'number' ||
        typeof denominator !== 'number' ||
        !Number.isFinite(numerator) ||
        !Number.isFinite(denominator) ||
        numerator <= 0 ||
        denominator <= 0 ||
        numerator > denominator
      ) {
        return undefined;
      }
      return { kind: 'fraction', numerator, denominator };
    }
    case 'max':
      return { kind: 'max' };
    case 'previous_output':
      return { kind: 'previous_output' };
    default:
      return undefined;
  }
}

function parseSlotFields(raw: Record<string, unknown>, requireAction: boolean): IntentSlots | PatchIntentSlots | null {
  const action = requireAction
    ? isOneOf(raw.action, ACTION_ENUM)
      ? raw.action
      : null
    : raw.action === null || isOneOf(raw.action, ACTION_ENUM)
      ? raw.action
      : undefined;
  if (action === undefined || (requireAction && action === null)) return null;

  const amount = parseAmountExpr(raw.amount);
  if (amount === undefined) return null;
  if (
    !isNullableString(raw.asset) ||
    !isNullableString(raw.to_asset) ||
    !isNullableString(raw.from_chain) ||
    !isNullableString(raw.to_chain) ||
    !isNullableString(raw.recipient_ref) ||
    !isNullableString(raw.provider)
  ) {
    return null;
  }

  const noteType = raw.note_type === null || isOneOf(raw.note_type, NOTE_TYPE_ENUM) ? raw.note_type : undefined;
  const earnOp = raw.earn_op === null || isOneOf(raw.earn_op, EARN_OP_ENUM) ? raw.earn_op : undefined;
  if (noteType === undefined || earnOp === undefined) return null;

  return {
    action,
    amount,
    asset: raw.asset,
    to_asset: raw.to_asset,
    from_chain: raw.from_chain,
    to_chain: raw.to_chain,
    recipient_ref: raw.recipient_ref,
    provider: raw.provider,
    note_type: noteType,
    earn_op: earnOp
  };
}

/**
 * Strictly validates an untrusted JSON payload from the LLM proxy. Accepts either
 * the `{ result: ... }` strict-schema envelope or an unwrapped variant object.
 */
export function parseAiCompilerOutput(raw: unknown): AiCompilerOutput | null {
  const candidate = isRecord(raw) && 'result' in raw && Object.keys(raw).length === 1 ? raw.result : raw;
  if (!isRecord(candidate) || typeof candidate.op !== 'string') return null;

  switch (candidate.op) {
    case 'set_intent': {
      const slots = parseSlotFields(candidate, true);
      if (!slots || slots.action === null) return null;
      return { op: 'set_intent', ...(slots as IntentSlots) };
    }
    case 'set_plan': {
      if (!Array.isArray(candidate.steps) || candidate.steps.length < 2 || candidate.steps.length > 4) {
        return null;
      }
      const steps: IntentSlots[] = [];
      for (const rawStep of candidate.steps) {
        if (!isRecord(rawStep)) return null;
        const parsed = parseSlotFields(rawStep, true);
        if (!parsed || parsed.action === null) return null;
        steps.push(parsed as IntentSlots);
      }
      return { op: 'set_plan', steps };
    }
    case 'patch_slots': {
      if (!isRecord(candidate.patch)) return null;
      const patch = parseSlotFields(candidate.patch, false);
      if (!patch) return null;
      return { op: 'patch_slots', patch: patch as PatchIntentSlots };
    }
    case 'query_ledger': {
      if (
        !isOneOf(candidate.query, QUERY_TYPE_ENUM) ||
        !isNullableString(candidate.asset) ||
        !isNullableString(candidate.counterparty_ref) ||
        !isOneOf(candidate.direction, DIRECTION_ENUM) ||
        !isOneOf(candidate.window, WINDOW_ENUM)
      ) {
        return null;
      }
      return {
        op: 'query_ledger',
        query: candidate.query,
        asset: candidate.asset,
        counterparty_ref: candidate.counterparty_ref,
        direction: candidate.direction,
        window: candidate.window
      };
    }
    case 'cancel':
      return { op: 'cancel' };
    case 'unsupported': {
      if (
        typeof candidate.reason !== 'string' ||
        !(candidate.suggested_route === null || isOneOf(candidate.suggested_route, ACTION_ENUM))
      ) {
        return null;
      }
      return {
        op: 'unsupported',
        reason: candidate.reason,
        suggested_route: candidate.suggested_route
      };
    }
    default:
      return null;
  }
}
