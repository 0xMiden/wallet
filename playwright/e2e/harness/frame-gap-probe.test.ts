import { findProveWindow, measureFrameGap, readyWorkerThreads } from './frame-gap-probe';

const open = (ts: number) => ({ ts, line: '[prove-timing] local-prove-window open' });
const close = (ts: number) => ({ ts, line: '[prove-timing] local-prove-window close' });

describe('findProveWindow', () => {
  it('returns the first window that closes after arming, counting the opens before it', () => {
    const markers = [open(50), close(60), open(100), { ts: 150, line: 'noise' }, close(900), open(950)];
    expect(findProveWindow(markers, 90)).toEqual({ openTs: 100, closeTs: 900, opens: 1 });
  });

  it('is undefined while the window after arming is still open', () => {
    expect(findProveWindow([close(60), open(100)], 90)).toBeUndefined();
  });

  it('counts a second open before the close, which the spec rejects', () => {
    expect(findProveWindow([open(100), open(200), close(900)], 0)).toEqual({ openTs: 100, closeTs: 900, opens: 2 });
  });
});

describe('measureFrameGap', () => {
  it('takes the largest of the lead-in, the gaps between frames, and the tail', () => {
    expect(measureFrameGap([90, 110, 130, 700, 720], 100, 1000)).toEqual({
      windowMs: 900,
      framesInWindow: 4,
      maxGapMs: 570
    });
  });

  it('counts the lead-in from open to the first frame', () => {
    expect(measureFrameGap([600, 616], 100, 620).maxGapMs).toBe(500);
  });

  it('counts the tail from the last frame to close', () => {
    expect(measureFrameGap([116, 132], 100, 900).maxGapMs).toBe(768);
  });

  it('treats a window with no frame as one gap as long as the window', () => {
    expect(measureFrameGap([50, 950], 100, 900)).toEqual({ windowMs: 800, framesInWindow: 0, maxGapMs: 800 });
  });
});

describe('readyWorkerThreads', () => {
  it('reads the thread count of the first isolated worker ready after arming', () => {
    const markers = [
      { ts: 10, line: '[prove-timing] prove-worker ready threads=2 coi=true ms=5' },
      { ts: 20, line: '[prove-timing] prove-worker ready threads=6 coi=true ms=812' }
    ];
    expect(readyWorkerThreads(markers, 15)).toBe(6);
    expect(readyWorkerThreads(markers, 25)).toBeUndefined();
  });
});
