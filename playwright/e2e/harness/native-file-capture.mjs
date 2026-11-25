import { createReadStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function prepareNativeFileCapture(directory) {
  const traceDirectory = resolve(directory);
  await mkdir(traceDirectory, { mode: 0o700 });
  const file = resolve(traceDirectory, 'browser.pftrace');
  return { directory: traceDirectory, file };
}

// Trace.packet is field 1. Varints used as keys, lengths, and counters are read
// as numbers. Large values in unrelated fields are only skipped.
function varint(bytes, start, readValue = true) {
  let value = 0;
  let weight = 1;
  for (let offset = start; offset < bytes.length && offset < start + 10; offset++) {
    const part = bytes[offset];
    if (readValue) {
      value += (part & 127) * weight;
      weight *= 128;
    }
    if ((part & 128) === 0) return { value, end: offset + 1 };
  }
  if (bytes.length - start >= 10) throw new Error('Invalid trace varint');
  return undefined;
}

function requireVarint(bytes, start, readValue = true) {
  const read = varint(bytes, start, readValue);
  if (!read) throw new Error('Incomplete trace varint');
  return read;
}

function scanMessage(bytes, wanted, visit) {
  for (let cursor = 0; cursor < bytes.length;) {
    const tag = requireVarint(bytes, cursor);
    const field = tag.value >>> 3;
    const wire = tag.value & 7;
    cursor = tag.end;

    switch (wire) {
      case 0: {
        const v = requireVarint(bytes, cursor, wanted.has(field));
        if (wanted.has(field)) visit(field, v.value);
        cursor = v.end;
        break;
      }
      case 1:
        cursor += 8;
        break;
      case 2: {
        const length = requireVarint(bytes, cursor);
        cursor = length.end + length.value;
        if (cursor > bytes.length) throw new Error('Incomplete trace field');
        if (wanted.has(field)) visit(field, bytes.subarray(length.end, cursor));
        break;
      }
      case 5:
        cursor += 4;
        break;
      default:
        throw new Error('Invalid trace wire type');
    }
    if (!field || cursor > bytes.length) throw new Error('Invalid trace field');
  }
}

async function* tracePackets(file) {
  let carry = Buffer.alloc(0);
  for await (const chunk of createReadStream(file, { highWaterMark: 1024 * 1024 })) {
    const bytes = carry.length ? Buffer.concat([carry, chunk]) : chunk;
    let cursor = 0;
    while (cursor < bytes.length) {
      if (bytes[cursor] !== 10) throw new Error('Expected a Perfetto trace packet');
      const length = varint(bytes, cursor + 1);
      if (!length) break;
      if (length.value > 16 * 1024 * 1024) throw new Error('Perfetto packet exceeds the inspection limit');
      const end = length.end + length.value;
      if (end > bytes.length) break;
      yield bytes.subarray(length.end, end);
      cursor = end;
    }
    carry = bytes.subarray(cursor);
  }
  if (carry.length) throw new Error('Incomplete Perfetto trace packet at EOF');
}

const packetFields = new Set([10, 11, 12, 33, 35, 42, 87]);
const internedDataFields = new Set([2]);
const eventNameFields = new Set([2]);
const trackEventNameFields = new Set([23]);
const configFields = new Set([1, 8, 9]);
const bufferConfigFields = new Set([1, 4, 8]);
const statsFields = new Set([1, 8, 9, 10, 14, 15]);
// TraceStats.BufferStats counters reporting known data loss.
const lossFields = new Set([3, 6, 9, 18, 19, 22]);

export async function auditNativeFileCapture(file, markerPrefix = 'wallet.capture.', knownRecorder = false) {
  const fileStat = await stat(file);
  if (!fileStat.isFile() || (fileStat.mode & 0o077) !== 0) throw new Error('Native trace file is not private');
  const seqs = new Set();
  const markers = new Set();
  const nativeEvents = new Set();
  let packets = 0;
  let statsPackets = 0;
  let flaggedLossPackets = 0;
  let firstPacketFlags = 0;
  let reportedBufferLoss = 0;
  let discardedChunks = 0;
  let streamingV2 = false;
  function recordEventName(bytes) {
    const value = bytes.toString('utf8');
    if (value.startsWith(markerPrefix)) markers.add(value);
    if (value === 'Database::RegisterAndScheduleTransaction' ||
        value === 'Database::PutOperation' ||
        value === 'Transaction::CommitPhaseTwo.TransactionCompleteCallbacks') nativeEvents.add(value);
  }
  for await (const packet of tracePackets(file)) {
    packets++;
    let sequence = 0;
    let previousPacketDropped = 0;
    let firstOnSequence = false;
    scanMessage(packet, packetFields, (field, val) => {
      switch (field) {
        case 10:
          sequence = val;
          break;
        case 11:
          scanMessage(val, trackEventNameFields, (_, name) => recordEventName(name));
          break;
        case 12:
          scanMessage(val, internedDataFields, (_, eventName) => {
            scanMessage(eventName, eventNameFields, (_, name) => recordEventName(name));
          });
          break;
        case 33: {
          let bufferV2 = false;
          let writesToFile = false;
          let writePeriod;
          scanMessage(val, configFields, (key, value) => {
            if (key === 1) {
              const config = new Map();
              scanMessage(value, bufferConfigFields, (field, number) => config.set(field, number));
              bufferV2 ||= config.get(1) === 65536 && config.get(4) === 1 && config.get(8) === 1;
            } else if (key === 8) writesToFile = value === 1;
            else writePeriod = value;
          });
          streamingV2 ||= bufferV2 && writesToFile && writePeriod === 1000;
          break;
        }
        case 35:
          statsPackets++;
          let discardedAtSnapshot = 0;
          scanMessage(val, statsFields, (field, value) => {
            if (field === 1) scanMessage(value, lossFields, (counter, loss) => {
              if (counter === 18) discardedAtSnapshot += loss;
              else reportedBufferLoss += loss;
            });
            else if (field === 15) reportedBufferLoss += Number(value === 2);
            else reportedBufferLoss += value;
          });
          discardedChunks = Math.max(discardedChunks, discardedAtSnapshot);
          break;
        case 42:
          previousPacketDropped = val;
          break;
        case 87:
          firstOnSequence = val === 1;
          break;
      }
    });
    // Perfetto also sets this flag on the first packet of a newly seen sequence.
    if (previousPacketDropped === 1 && (firstOnSequence || !seqs.has(sequence))) {
      firstPacketFlags++;
    } else if (previousPacketDropped) {
      flaggedLossPackets++;
    }
    if (sequence) seqs.add(sequence);
  }
  if (!packets || !statsPackets) throw new Error('Perfetto output is missing trace packets or trace stats');
  // On the pinned v59.1 TraceBufferV2 ring, with no ProtoVM, counter 18
  // records commits for chunks already read by the consumer. Count them
  // separately from unread overwrites and service-level discards.
  // https://github.com/google/perfetto/blob/v59.1/src/tracing/service/trace_buffer_v2.cc#L994-L1004
  const lateDuplicateChunks = knownRecorder && streamingV2 ? discardedChunks : 0;
  return {
    bytes: fileStat.size, packets, statsPackets,
    reportedBufferLoss: reportedBufferLoss + discardedChunks - lateDuplicateChunks,
    flaggedLossPackets, firstPacketFlags, streamingV2, lateDuplicateChunks,
    markers: [...markers].sort(), nativeEvents: [...nativeEvents].sort()
  };
}
