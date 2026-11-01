import { JOURNAL_MAX_BYTES, JOURNAL_MAX_ENTRIES } from './journal';

interface WireBudget {
  bytes: number;
  materials: number;
}

function refuse(): never {
  throw new Error('Invalid recovery wire data');
}

function object(value: unknown, allowed: readonly string[]): asserts value is Record<string, unknown> {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  )
    refuse();
  for (const key in value) if (!allowed.includes(key)) refuse();
}

function text(value: unknown, maximum = 2048): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) refuse();
}

function integer(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) refuse();
}

function array(value: unknown, maximum: number): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > maximum) refuse();
  for (let index = 0; index < value.length; index++) if (!Object.prototype.hasOwnProperty.call(value, index)) refuse();
}

function bytes(value: unknown, budget: WireBudget, allowTyped: boolean, allowEmpty = false): void {
  if (!(allowTyped && value instanceof Uint8Array)) array(value, JOURNAL_MAX_BYTES);
  if (!(value instanceof Uint8Array) && !Array.isArray(value)) refuse();
  budget.bytes += value.length;
  if ((!allowEmpty && value.length === 0) || budget.bytes > JOURNAL_MAX_BYTES) refuse();
  for (let index = 0; index < value.length; index++) {
    const byte: unknown = value[index];
    if (typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255) refuse();
  }
}

function account(value: unknown): void {
  object(value, ['accountId', 'nonce', 'commitment']);
  text(value.accountId);
  text(value.commitment);
  if (typeof value.nonce !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(value.nonce)) refuse();
}

function material(value: unknown, budget: WireBudget, allowTyped: boolean, primary: boolean): void {
  object(
    value,
    primary
      ? ['kind', 'id', 'accountId', 'detailsId', 'noteFile', 'provenance', 'format', 'scan', 'candidates']
      : ['id', 'accountId', 'detailsId', 'noteFile', 'provenance', 'format']
  );
  if (primary && value.kind !== 'note') refuse();
  if (++budget.materials > JOURNAL_MAX_ENTRIES) refuse();
  text(value.id);
  if (value.accountId !== undefined) text(value.accountId);
  if (value.detailsId !== undefined && (typeof value.detailsId !== 'string' || !/^[a-f0-9]{64}$/.test(value.detailsId)))
    refuse();
  if (value.provenance !== 'input' && value.provenance !== 'output') refuse();
  if (value.format !== undefined && value.format !== 'full' && value.format !== 'details') refuse();
  bytes(value.noteFile, budget, allowTyped);
  if (primary && value.scan !== undefined) {
    object(value.scan, ['nextBlock', 'anchorBlock', 'anchor']);
    integer(value.scan.nextBlock);
    integer(value.scan.anchorBlock);
    text(value.scan.anchor);
    if (value.scan.nextBlock !== value.scan.anchorBlock + 1) refuse();
  }
  if (primary && value.candidates !== undefined) {
    array(value.candidates, JOURNAL_MAX_ENTRIES - budget.materials);
    if (value.candidates.length === 0) refuse();
    for (const candidate of value.candidates) material(candidate, budget, allowTyped, false);
  }
}

function notes(value: unknown, budget: WireBudget, allowTyped: boolean): void {
  array(value, JOURNAL_MAX_ENTRIES);
  for (const note of value) material(note, budget, allowTyped, true);
}

export function assertRecoveryCaptureWire(value: unknown): void {
  object(value, ['requestBytes', 'notes']);
  const budget = { bytes: 0, materials: 0 };
  bytes(value.requestBytes, budget, true);
  notes(value.notes, budget, true);
}

export function assertRetainedNotesWire(value: unknown): void {
  if (value !== undefined) notes(value, { bytes: 0, materials: 0 }, false);
}

export function assertCanonicalNotesWire(value: unknown): void {
  if (value === undefined) return;
  array(value, 4);
  notes(value, { bytes: 0, materials: 0 }, false);
}

export function assertSdkRecoveryCommandWire(value: unknown): void {
  object(value, ['kind', 'generation', 'note', 'accountId', 'material']);
  if (value.kind === 'generation') {
    object(value, ['kind', 'generation']);
    text(value.generation, 128);
    return;
  }
  const budget = { bytes: 0, materials: 0 };
  if (value.kind === 'note') {
    object(value, ['kind', 'note', 'accountId']);
    text(value.accountId);
    material(value.note, budget, false, true);
    return;
  }
  if (value.kind !== 'account') refuse();
  object(value, ['kind', 'material']);
  object(value.material, ['floor', 'accountBytes', 'guardianCommitment', 'signerCommitments', 'chainCommitment']);
  account(value.material.floor);
  bytes(value.material.accountBytes, budget, false, true);
  text(value.material.guardianCommitment);
  text(value.material.chainCommitment);
  array(value.material.signerCommitments, 2);
  if (value.material.signerCommitments.length === 0) refuse();
  for (const signer of value.material.signerCommitments) text(signer);
}

export function assertSdkRecoverySnapshotWire(value: unknown): void {
  object(value, ['generation', 'accounts', 'notes', 'canonicalNotes']);
  if (value.generation !== null) text(value.generation, 128);
  array(value.accounts, JOURNAL_MAX_ENTRIES);
  if (value.accounts.length === 0) refuse();
  for (const floor of value.accounts) account(floor);
  const budget = { bytes: 0, materials: 0 };
  notes(value.notes, budget, false);
  if (value.canonicalNotes !== undefined) {
    array(value.canonicalNotes, 4);
    for (const canonical of value.canonicalNotes) {
      object(canonical, ['familyId', 'id', 'detailsId', 'noteFile']);
      text(canonical.familyId);
      for (const field of ['id', 'detailsId'])
        if (typeof canonical[field] !== 'string' || !/^[a-f0-9]{64}$/.test(canonical[field])) refuse();
      if (++budget.materials > JOURNAL_MAX_ENTRIES) refuse();
      bytes(canonical.noteFile, budget, false);
    }
  }
}
