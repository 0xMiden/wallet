/** @jest-environment node */
import { NODE_RETRY_MS, runMeasuredCustomSubmit, type DappOutput } from './protocol';

const refusal: DappOutput<'submitCustom'> = { ok: false, error: { name: 'Refused', message: 'refused' } };
const nodeFailure = Object.assign(new Error('Node unavailable'), { name: 'ChainUnavailableError' });

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

it('samples distinct heights on either side of the refusal', async () => {
  const order: string[] = [];
  const sync = jest.fn(async () => {
    order.push('sync');
    return { height: order.length === 1 ? 10 : 13 };
  });
  const submit = jest.fn(async () => {
    order.push('submit');
    return refusal;
  });
  const result = await runMeasuredCustomSubmit(sync, submit);
  expect(result).toMatchObject({ result: refusal, timing: { beforeHeight: 10, afterHeight: 13 } });
  expect(order).toEqual(['sync', 'submit', 'sync']);
});

it('does not submit when the leading read returns at expiry', async () => {
  const expiresAt = Date.now() + 500;
  const sync = jest.fn(async () => {
    jest.setSystemTime(expiresAt);
    return { height: 10 };
  });
  const submit = jest.fn(async () => refusal);
  await expect(runMeasuredCustomSubmit(sync, submit, expiresAt)).rejects.toMatchObject({ name: 'CommandExpiredError' });
  expect(sync).toHaveBeenCalledTimes(1);
  expect(submit).not.toHaveBeenCalled();
});

it('retries only the leading read and submits once', async () => {
  const sync = jest.fn().mockRejectedValueOnce(nodeFailure).mockResolvedValueOnce({ height: 10 }).mockResolvedValueOnce({ height: 12 });
  const submit = jest.fn(async () => refusal);
  const pending = runMeasuredCustomSubmit(sync, submit, Date.now() + NODE_RETRY_MS * 2);
  await jest.advanceTimersByTimeAsync(NODE_RETRY_MS);
  await expect(pending).resolves.toMatchObject({ result: refusal, timing: { beforeHeight: 10, afterHeight: 12 } });
  expect(sync).toHaveBeenCalledTimes(3);
  expect(submit).toHaveBeenCalledTimes(1);
});

it('does not retry when there is no budget left for the leading read', async () => {
  const sync = jest.fn().mockRejectedValue(nodeFailure);
  const submit = jest.fn(async () => refusal);
  await expect(runMeasuredCustomSubmit(sync, submit, Date.now() + NODE_RETRY_MS)).rejects.toBe(nodeFailure);
  expect(sync).toHaveBeenCalledTimes(1);
  expect(submit).not.toHaveBeenCalled();
});

it('does not retry a failed trailing read or replay the submission', async () => {
  const sync = jest.fn().mockResolvedValueOnce({ height: 10 }).mockRejectedValueOnce(nodeFailure);
  const submit = jest.fn(async () => refusal);
  await expect(runMeasuredCustomSubmit(sync, submit, Date.now() + 30_000)).resolves.toMatchObject({
    result: refusal,
    timing: { beforeHeight: 10, trailingReadFailed: true }
  });
  expect(sync).toHaveBeenCalledTimes(2);
  expect(submit).toHaveBeenCalledTimes(1);
});
