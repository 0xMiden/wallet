import {
  consumeQueueAdmission,
  noteQueueSighting,
  peekQueueSighting,
  pruneQueueAdmission,
  queueSightingFor,
  recordQueueAdmission,
  retainQueueSightings
} from './queue-admission-diagnostics';
const row = (id = 'private-row', initiatedAt = 1, queuedSeq: number | undefined = undefined) => ({
  id,
  initiatedAt,
  queuedSeq
});
let clock: jest.SpyInstance;
beforeEach(() => {
  pruneQueueAdmission([]);
  clock = jest.spyOn(performance, 'now').mockReturnValue(100000);
});
afterEach(() => clock.mockRestore());
it.each([0, 60000])('consumes one exact recent observation at age %s', age => {
  const member = row();
  recordQueueAdmission(member, 'in_progress_gate');
  clock.mockReturnValue(100000 + age);
  expect(consumeQueueAdmission(member)).toBe('in_progress_gate');
  expect(consumeQueueAdmission(member)).toBe('unavailable');
});
it.each([60001, -1, NaN, Infinity])('rejects invalid age %s', age => {
  const member = row();
  recordQueueAdmission(member, 'selected');
  clock.mockReturnValue(100000 + age);
  expect(consumeQueueAdmission(member)).toBe('unavailable');
});
it('binds exact identity, prunes absent/mismatched members and never invokes row getters', () => {
  recordQueueAdmission(row(), 'row_ineligible');
  expect(consumeQueueAdmission(row('private-row', 2))).toBe('unavailable');
  recordQueueAdmission(row(), 'selected');
  pruneQueueAdmission([row('different')]);
  expect(consumeQueueAdmission(row())).toBe('unavailable');
  recordQueueAdmission(row(), 'selected');
  pruneQueueAdmission([row('private-row', 1, 2)]);
  expect(consumeQueueAdmission(row())).toBe('unavailable');
  const getter = jest.fn();
  const hostile = Object.defineProperty(row(), 'queuedSeq', { get: getter });
  recordQueueAdmission(hostile, 'selected');
  expect(consumeQueueAdmission(hostile)).toBe('unavailable');
  expect(getter).not.toHaveBeenCalled();
});
it('keeps the strongest look after the 60-second observation is consumed', () => {
  const member = row();
  recordQueueAdmission(member, 'selected');
  noteQueueSighting(member, 'not_reached');
  recordQueueAdmission(member, 'in_progress_gate');
  clock.mockReturnValue(100000 + 60001);
  expect(consumeQueueAdmission(member)).toBe('unavailable');
  expect(peekQueueSighting(member)).toBe('selected');
  expect(
    queueSightingFor({ ...member, queueSighting: 'not_reached', queueSightingAt: 1, queueSightingSeq: null })
  ).toBe('selected');
  expect(
    queueSightingFor({
      ...member,
      initiatedAt: 2,
      queueSighting: 'selected',
      queueSightingAt: 1,
      queueSightingSeq: null
    })
  ).toBe('never');
});
it('does not let a partial lap forget a later row, and drops a look whose incarnation changed', () => {
  const later = row('later', 1, 4);
  recordQueueAdmission(later, 'row_ineligible');
  pruneQueueAdmission([row('earlier', 1, 3)]);
  expect(peekQueueSighting(later)).toBe('row_ineligible');
  retainQueueSightings([row('later', 1, 9)]);
  expect(peekQueueSighting(later)).toBe('never');
  noteQueueSighting(later, 'not_reached');
  retainQueueSightings([later]);
  expect(peekQueueSighting(later)).toBe('not_reached');
  expect(queueSightingFor({ ...later, queueSighting: 'selected', queueSightingAt: 1, queueSightingSeq: 4 })).toBe(
    'selected'
  );
  expect(consumeQueueAdmission(later)).toBe('unavailable');
});
it('evicts the least recently recorded entry at257 and retains only literals', () => {
  for (let i = 0; i < 256; i++) recordQueueAdmission(row(String(i)), 'selected');
  recordQueueAdmission(row('0'), 'row_ineligible');
  recordQueueAdmission(row('256'), 'selected');
  expect(consumeQueueAdmission(row('1'))).toBe('unavailable');
  expect(consumeQueueAdmission(row('0'))).toBe('row_ineligible');
  expect(consumeQueueAdmission(row('256'))).toBe('selected');
});
