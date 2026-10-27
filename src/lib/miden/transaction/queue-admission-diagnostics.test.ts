import { consumeQueueAdmission, pruneQueueAdmission, recordQueueAdmission } from './queue-admission-diagnostics';
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
it('evicts the least recently recorded entry at257 and retains only literals', () => {
  for (let i = 0; i < 256; i++) recordQueueAdmission(row(String(i)), 'selected');
  recordQueueAdmission(row('0'), 'row_ineligible');
  recordQueueAdmission(row('256'), 'selected');
  expect(consumeQueueAdmission(row('1'))).toBe('unavailable');
  expect(consumeQueueAdmission(row('0'))).toBe('row_ineligible');
  expect(consumeQueueAdmission(row('256'))).toBe('selected');
});
