/** @jest-environment node */
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';

import { capNativeScreenshot } from './cap-native-screenshot';

test('caps before returning and preserves raw/saved dimensions for native scaling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'native-cap-'));
  const file = join(root, 'screen.png');
  try {
    await sharp({ create: { width: 1080, height: 2400, channels: 3, background: '#123456' } })
      .png()
      .toFile(file);
    await capNativeScreenshot(file);
    const saved = await sharp(file).metadata();
    expect([saved.width, saved.height]).toEqual([810, 1800]);
    expect(JSON.parse(await readFile(file + '.dimensions.json', 'utf8'))).toEqual({
      raw: { width: 1080, height: 2400 },
      saved: { width: 810, height: 1800 }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each([
  [2400, 1080, 1800, 810],
  [600, 400, 600, 400]
])('caps %ix%i without enlargement or padding', async (width, height, savedWidth, savedHeight) => {
  const root = await mkdtemp(join(tmpdir(), 'native-cap-'));
  const file = join(root, 'screen.png');
  try {
    await sharp({ create: { width, height, channels: 3, background: '#123456' } })
      .png()
      .toFile(file);
    await capNativeScreenshot(file);
    const saved = await sharp(file).metadata();
    expect([saved.width, saved.height]).toEqual([savedWidth, savedHeight]);
    expect(JSON.parse(await readFile(file + '.dimensions.json', 'utf8'))).toEqual({
      raw: { width, height },
      saved: { width: savedWidth, height: savedHeight }
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
