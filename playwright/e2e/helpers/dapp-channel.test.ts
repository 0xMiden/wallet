/**
 * @jest-environment node
 */
import { CellDeadlineExceeded, deadlineIn, HarnessFault } from './dapp-cells';
import { callOn, ChainUnavailable, type DappChannel } from './dapp-channel';

interface Asked {
  command: string;
  timeoutMs: number | undefined;
}

// Answers each send with the next of `answers`; an Error rejects.
function channelAnswering(answers: unknown[]): { channel: DappChannel; asked: Asked[] } {
  const asked: Asked[] = [];
  const channel: DappChannel = {
    label: 'A/one',
    send: async (command, _input, timeoutMs) => {
      asked.push({ command, timeoutMs });
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next;
    }
  };
  return { channel, asked };
}

const nodeDown = () =>
  new ChainUnavailable('dApp A/one syncHeight: ChainUnavailableError: syncChain: TypeError: Failed to fetch');

describe('callOn', () => {
  it('sends no command when the deadline has already expired', async () => {
    const { channel, asked } = channelAnswering([{ height: 7 }]);
    const deadline = deadlineIn(0, 'expired cell');
    await expect(callOn(channel, 'syncHeight', {}, deadline)).rejects.toBeInstanceOf(CellDeadlineExceeded);
    expect(asked).toEqual([]);
  });

  it('asks once, with no timeout, when no deadline is given', async () => {
    const { channel, asked } = channelAnswering([{ height: 7 }]);
    await expect(callOn(channel, 'syncHeight', {})).resolves.toEqual({ height: 7 });
    expect(asked).toEqual([{ command: 'syncHeight', timeoutMs: undefined }]);
  });

  it('hands the channel what the deadline leaves less a second, so its own verdict lands first', async () => {
    const { channel, asked } = channelAnswering([{ height: 7 }]);
    await callOn(channel, 'syncHeight', {}, deadlineIn(10_000, 'cell'));
    expect(asked[0]?.timeoutMs).toBeLessThanOrEqual(9_000);
    expect(asked[0]?.timeoutMs).toBeGreaterThan(8_800);
  });

  it('asks a repeatable command again after the node failed it', async () => {
    const { channel, asked } = channelAnswering([nodeDown(), { height: 8 }]);
    await expect(callOn(channel, 'syncHeight', {}, deadlineIn(10_000, 'cell'))).resolves.toEqual({ height: 8 });
    expect(asked.map(entry => entry.command)).toEqual(['syncHeight', 'syncHeight']);
  });

  it('never asks a connect again, whatever failed it', async () => {
    const { channel, asked } = channelAnswering([nodeDown()]);
    await expect(
      callOn(channel, 'connect', { permission: 'UponRequest', network: 'testnet' }, deadlineIn(10_000, 'cell'))
    ).rejects.toBeInstanceOf(ChainUnavailable);
    expect(asked).toHaveLength(1);
  });

  it("passes a mobile channel's own verdicts through unchanged", async () => {
    const verdicts = [
      new CellDeadlineExceeded(
        'dApp A/one session was delivered 5 ms after it was sent and not answered within 900 ms'
      ),
      new HarnessFault('dApp A/one session was never delivered within 900 ms: the page stopped polling')
    ];
    for (const verdict of verdicts) {
      const { channel } = channelAnswering([verdict]);
      await expect(callOn(channel, 'session', {}, deadlineIn(10_000, 'cell'))).rejects.toBe(verdict);
    }
  });
});
