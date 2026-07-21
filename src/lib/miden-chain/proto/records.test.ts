import * as _m0 from 'protobufjs/minimal';

import { protobufPackage, RecordInfo, RecordInfoList } from './records';

// Fully-populated fixtures used across the round-trip / codec assertions.
const fullRecord: RecordInfo = {
  transitionId: 'txn-1',
  nonceX: 'nx',
  nonceY: 'ny',
  ownerX: 'owner',
  outputIndex: 7
};

const emptyRecord: RecordInfo = {
  transitionId: '',
  nonceX: '',
  nonceY: '',
  ownerX: '',
  outputIndex: 0
};

describe('proto/records', () => {
  it('exposes the empty protobuf package name', () => {
    expect(protobufPackage).toBe('');
  });

  describe('RecordInfo.encode / decode', () => {
    it('round-trips a fully populated message', () => {
      const bytes = RecordInfo.encode(fullRecord).finish();
      expect(ArrayBuffer.isView(bytes)).toBe(true);
      expect(bytes.length).toBeGreaterThan(0);

      const decoded = RecordInfo.decode(bytes);
      expect(decoded).toEqual(fullRecord);
    });

    it('writes nothing for an all-default message (every field guard is false)', () => {
      const bytes = RecordInfo.encode(emptyRecord).finish();
      expect(bytes.length).toBe(0);

      const decoded = RecordInfo.decode(bytes);
      expect(decoded).toEqual(emptyRecord);
    });

    it('encodes into a caller-supplied writer', () => {
      const writer = _m0.Writer.create();
      const returned = RecordInfo.encode(fullRecord, writer);
      expect(returned).toBe(writer);
      expect(RecordInfo.decode(writer.finish())).toEqual(fullRecord);
    });

    it('decodes from an existing Reader instance', () => {
      const bytes = RecordInfo.encode(fullRecord).finish();
      const reader = _m0.Reader.create(bytes);
      const decoded = RecordInfo.decode(reader);
      expect(decoded).toEqual(fullRecord);
    });

    it('decodes with an explicit length argument', () => {
      const bytes = RecordInfo.encode(fullRecord).finish();
      const reader = _m0.Reader.create(bytes);
      const decoded = RecordInfo.decode(reader, bytes.length);
      expect(decoded).toEqual(fullRecord);
    });

    it.each([
      ['transitionId (field 1)', Uint8Array.from([8, 1])],
      ['nonceX (field 2)', Uint8Array.from([16, 1])],
      ['nonceY (field 3)', Uint8Array.from([24, 1])],
      ['ownerX (field 4)', Uint8Array.from([32, 1])],
      ['outputIndex (field 5)', Uint8Array.from([42, 0])],
      ['unknown field (field 6)', Uint8Array.from([48, 1])]
    ])('skips a field encoded with the wrong wire type: %s', (_label, bytes) => {
      // Each buffer carries a valid field number but a mismatched wire type,
      // forcing the `if (tag !== N) break` path and the trailing skipType().
      const decoded = RecordInfo.decode(bytes);
      expect(decoded).toEqual(emptyRecord);
    });

    it('stops decoding on an end-group tag (wire type 4)', () => {
      // field 1, wire type 4 -> tag 12 -> breaks the outer while via (tag & 7) === 4.
      const decoded = RecordInfo.decode(Uint8Array.from([12]));
      expect(decoded).toEqual(emptyRecord);
    });

    it('stops decoding on a zero tag', () => {
      const decoded = RecordInfo.decode(Uint8Array.from([0]));
      expect(decoded).toEqual(emptyRecord);
    });
  });

  describe('RecordInfo.fromJSON', () => {
    it('coerces present values via String/Number', () => {
      const result = RecordInfo.fromJSON({
        transitionId: 123,
        nonceX: true,
        nonceY: 'ny',
        ownerX: 0,
        outputIndex: '9'
      });
      expect(result).toEqual({
        transitionId: '123',
        nonceX: 'true',
        nonceY: 'ny',
        ownerX: '0',
        outputIndex: 9
      });
    });

    it('falls back to defaults for missing keys', () => {
      expect(RecordInfo.fromJSON({})).toEqual(emptyRecord);
    });

    it('treats explicit null values as unset (isSet false branch)', () => {
      expect(
        RecordInfo.fromJSON({
          transitionId: null,
          nonceX: null,
          nonceY: null,
          ownerX: null,
          outputIndex: null
        })
      ).toEqual(emptyRecord);
    });
  });

  describe('RecordInfo.toJSON', () => {
    it('emits all fields when populated and rounds outputIndex', () => {
      const obj = RecordInfo.toJSON({ ...fullRecord, outputIndex: 3.7 }) as Record<string, unknown>;
      expect(obj).toEqual({
        transitionId: 'txn-1',
        nonceX: 'nx',
        nonceY: 'ny',
        ownerX: 'owner',
        outputIndex: 4
      });
    });

    it('omits default-valued fields', () => {
      expect(RecordInfo.toJSON(emptyRecord)).toEqual({});
    });
  });

  describe('RecordInfo.create / fromPartial', () => {
    it('create() with no base fills defaults', () => {
      expect(RecordInfo.create()).toEqual(emptyRecord);
    });

    it('create(base) applies provided fields', () => {
      expect(RecordInfo.create(fullRecord)).toEqual(fullRecord);
    });

    it('fromPartial keeps provided values (?? left branch)', () => {
      expect(RecordInfo.fromPartial(fullRecord)).toEqual(fullRecord);
    });

    it('fromPartial defaults missing values (?? right branch)', () => {
      expect(RecordInfo.fromPartial({})).toEqual(emptyRecord);
    });
  });

  describe('RecordInfoList.encode / decode', () => {
    it('round-trips a list with records (encode loop runs, list decode case 1)', () => {
      const list: RecordInfoList = { records: [fullRecord, { ...emptyRecord, transitionId: 'second' }] };
      const bytes = RecordInfoList.encode(list).finish();
      const decoded = RecordInfoList.decode(bytes);
      expect(decoded).toEqual(list);
    });

    it('round-trips an empty list (encode loop skipped)', () => {
      const bytes = RecordInfoList.encode({ records: [] }).finish();
      expect(bytes.length).toBe(0);
      expect(RecordInfoList.decode(bytes)).toEqual({ records: [] });
    });

    it('encodes into a caller-supplied writer', () => {
      const writer = _m0.Writer.create();
      const returned = RecordInfoList.encode({ records: [fullRecord] }, writer);
      expect(returned).toBe(writer);
      expect(RecordInfoList.decode(writer.finish())).toEqual({ records: [fullRecord] });
    });

    it('decodes from an existing Reader instance with a length', () => {
      const bytes = RecordInfoList.encode({ records: [fullRecord] }).finish();
      const reader = _m0.Reader.create(bytes);
      expect(RecordInfoList.decode(reader, bytes.length)).toEqual({ records: [fullRecord] });
    });

    it('skips a wrong-wire-type record field', () => {
      // field 1, wire type 0 -> tag 8 -> `if (tag !== 10) break` then skipType(0).
      expect(RecordInfoList.decode(Uint8Array.from([8, 1]))).toEqual({ records: [] });
    });

    it('skips an unknown field number', () => {
      // field 6, wire type 0 -> tag 48 -> no case matched -> skipType(0).
      expect(RecordInfoList.decode(Uint8Array.from([48, 1]))).toEqual({ records: [] });
    });

    it('stops on an end-group tag (wire type 4)', () => {
      expect(RecordInfoList.decode(Uint8Array.from([12]))).toEqual({ records: [] });
    });

    it('stops on a zero tag', () => {
      expect(RecordInfoList.decode(Uint8Array.from([0]))).toEqual({ records: [] });
    });
  });

  describe('RecordInfoList.fromJSON', () => {
    it('maps an array of records', () => {
      const result = RecordInfoList.fromJSON({ records: [{ transitionId: 'a' }, {}] });
      expect(result).toEqual({
        records: [{ ...emptyRecord, transitionId: 'a' }, emptyRecord]
      });
    });

    it('returns an empty list when records is not an array', () => {
      expect(RecordInfoList.fromJSON({ records: 'nope' })).toEqual({ records: [] });
    });

    it('returns an empty list for a null-ish object (optional chaining branch)', () => {
      expect(RecordInfoList.fromJSON(null)).toEqual({ records: [] });
      expect(RecordInfoList.fromJSON(undefined)).toEqual({ records: [] });
    });
  });

  describe('RecordInfoList.toJSON', () => {
    it('maps records when the list is non-empty', () => {
      expect(RecordInfoList.toJSON({ records: [fullRecord] })).toEqual({
        records: [RecordInfo.toJSON(fullRecord)]
      });
    });

    it('omits records when the list is empty', () => {
      expect(RecordInfoList.toJSON({ records: [] })).toEqual({});
    });
  });

  describe('RecordInfoList.create / fromPartial', () => {
    it('create() with no base yields an empty list', () => {
      expect(RecordInfoList.create()).toEqual({ records: [] });
    });

    it('create(base) maps provided records', () => {
      expect(RecordInfoList.create({ records: [fullRecord] })).toEqual({ records: [fullRecord] });
    });

    it('fromPartial maps records when present (?.map branch)', () => {
      expect(RecordInfoList.fromPartial({ records: [{ transitionId: 'only' }] })).toEqual({
        records: [{ ...emptyRecord, transitionId: 'only' }]
      });
    });

    it('fromPartial defaults to [] when records is absent (|| [] branch)', () => {
      expect(RecordInfoList.fromPartial({})).toEqual({ records: [] });
    });
  });
});
