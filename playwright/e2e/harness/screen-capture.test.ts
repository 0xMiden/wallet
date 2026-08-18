import { screenShotName, startScreenPoll } from './screen-capture';

describe('screenShotName', () => {
  it('zero-pads seq and slugifies the key', () => {
    expect(screenShotName(4, '/send > SelectAmount > drawer:token', 'A')).toBe(
      'screen-004-send-SelectAmount-drawer-token-wallet-a.png'
    );
  });
});

describe('startScreenPoll', () => {
  it('grabs once per seq change, not on unchanged reads', async () => {
    jest.useFakeTimers();
    const grabs: string[] = [];
    let state: { key: string; seq: number } | null = { key: '/a', seq: 1 };
    const poll = startScreenPoll({
      intervalMs: 100,
      read: async () => state,
      grab: async p => {
        grabs.push(p);
      },
      dir: '/out',
      label: 'A'
    });
    await jest.advanceTimersByTimeAsync(100); // seq 1 -> grab
    await jest.advanceTimersByTimeAsync(100); // unchanged -> no grab
    state = { key: '/b', seq: 2 };
    await jest.advanceTimersByTimeAsync(100); // seq 2 -> grab
    poll.stop();
    expect(grabs).toEqual(['/out/screen-001-a-wallet-a.png', '/out/screen-002-b-wallet-a.png']);
    jest.useRealTimers();
  });
});
