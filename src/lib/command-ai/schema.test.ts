import { COMMAND_AI_JSON_SCHEMA, parseAiCompilerOutput } from './schema';

describe('command-ai schema', () => {
  it('parses envelope-wrapped set_intent payloads', () => {
    const parsed = parseAiCompilerOutput({
      result: {
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
      }
    });

    expect(parsed).toEqual({
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
    });
  });

  it('rejects out-of-range fractions and unknown ops', () => {
    expect(
      parseAiCompilerOutput({
        result: {
          op: 'set_intent',
          action: 'send',
          amount: { kind: 'fraction', numerator: 3, denominator: 2 },
          asset: 'ETH',
          to_asset: null,
          from_chain: null,
          to_chain: null,
          recipient_ref: 'CONTACT_1',
          provider: null,
          note_type: null,
          earn_op: null
        }
      })
    ).toBeNull();

    expect(parseAiCompilerOutput({ op: 'execute_raw_tx', calldata: '0xdeadbeef' })).toBeNull();
  });

  it('defines strict object wrapper schema with additionalProperties: false', () => {
    expect(COMMAND_AI_JSON_SCHEMA.type).toBe('object');
    expect(COMMAND_AI_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(COMMAND_AI_JSON_SCHEMA.required).toEqual(['result']);
  });

  it('parses chained set_plan payloads and enforces 2..4 step bounds', () => {
    const step1 = {
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
    };
    const step2 = {
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
    };

    const parsed = parseAiCompilerOutput({
      result: { op: 'set_plan', steps: [step1, step2] }
    });
    expect(parsed).toEqual({ op: 'set_plan', steps: [step1, step2] });

    expect(parseAiCompilerOutput({ result: { op: 'set_plan', steps: [step1] } })).toBeNull();
    expect(
      parseAiCompilerOutput({ result: { op: 'set_plan', steps: [step1, step2, step1, step2, step1] } })
    ).toBeNull();
  });
});
