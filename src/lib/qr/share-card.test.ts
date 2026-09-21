import fs from 'fs';
import path from 'path';

import { truncateAddress } from 'utils/string';

import {
  composeQrShareCard,
  qrShareCardHeight,
  QR_MARGIN_RATIO,
  QR_SHARE_CARD,
  QR_SHARE_CARD_COLORS,
  QR_SOURCE_SIZE
} from './share-card';

// ---------------------------------------------------------------------------
// jsdom has no canvas rendering and loads no images, so this suite tests up to
// that boundary: every drawing CALL the card makes (what, where, in which colour
// and face) and the canvas it makes them on, with a recording 2d context. What it
// cannot say anything about is the pixels — whether Nunito was really available,
// whether the mark rasterised, how the downscaled QR looks. That needs a real
// share on a device.
// ---------------------------------------------------------------------------

interface DrawnText {
  text: string;
  x: number;
  y: number;
  font: string;
  color: string;
  align: string;
  baseline: string;
}
interface DrawnImage {
  source: unknown;
  x: number;
  y: number;
  width: number;
  height: number;
}
interface DrawnRect {
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
}

/** One character of measured width per character, so the lockup's centring is arithmetic. */
const CHAR_WIDTH = 10;
const ADDRESS = 'mtst1aplqzwh6s4gvcyzsvx726y6xvsgt5qv5qruqqypuyph';
const QR_URL = 'blob:qr';
const LOGO_URL = 'app://bread.svg';
/** The real mark is 273 x 263.2, so it is drawn slightly shorter than the 32px slot. */
const MARK_RATIO = 263.2 / 273;

let texts: DrawnText[];
let images: DrawnImage[];
let rects: DrawnRect[];
let pathFills: string[];
let scales: number[][];
let canvasSizes: { width: number; height: number }[];
let loaded: HTMLImageElement[];
let failing: string[];
let naturalWidth: number;
let blob: Blob | null;
let encodedAs: (string | undefined)[];
let context: object | null;

const encoded = new Blob(['card'], { type: 'image/png' });

const createContext = () => {
  const ctx = {
    fillStyle: '',
    font: '',
    textAlign: '',
    textBaseline: '',
    scale: (x: number, y: number) => void scales.push([x, y]),
    fillRect: (x: number, y: number, width: number, height: number) =>
      void rects.push({ x, y, width, height, color: ctx.fillStyle }),
    drawImage: (source: unknown, x: number, y: number, width: number, height: number) =>
      void images.push({ source, x, y, width, height }),
    fillText: (text: string, x: number, y: number) =>
      void texts.push({
        text,
        x,
        y,
        font: ctx.font,
        color: ctx.fillStyle,
        align: ctx.textAlign,
        baseline: ctx.textBaseline
      }),
    measureText: (text: string) => ({ width: text.length * CHAR_WIDTH }),
    beginPath: () => {},
    moveTo: () => {},
    arcTo: () => {},
    closePath: () => {},
    fill: () => void pathFills.push(ctx.fillStyle)
  };
  return ctx;
};

beforeEach(() => {
  texts = [];
  images = [];
  rects = [];
  pathFills = [];
  scales = [];
  canvasSizes = [];
  loaded = [];
  failing = [];
  naturalWidth = 273;
  blob = encoded;
  encodedAs = [];
  context = createContext();

  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: () => QR_URL });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: jest.fn() });
  jest.spyOn(HTMLImageElement.prototype, 'src', 'set').mockImplementation(function (this: HTMLImageElement, value) {
    loaded.push(this);
    Object.defineProperty(this, 'naturalWidth', { configurable: true, value: naturalWidth });
    Object.defineProperty(this, 'naturalHeight', { configurable: true, value: 263.2 });
    const failed = failing.includes(value);
    queueMicrotask(() => this.dispatchEvent(new Event(failed ? 'error' : 'load')));
  });
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: () => context });
  Object.defineProperty(HTMLCanvasElement.prototype, 'toBlob', {
    configurable: true,
    value: function (this: HTMLCanvasElement, callback: BlobCallback, type?: string) {
      canvasSizes.push({ width: this.width, height: this.height });
      encodedAs.push(type);
      callback(blob);
    }
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

const compose = (network?: string) =>
  composeQrShareCard({
    qr: new Blob(['qr'], { type: 'image/png' }),
    logoUrl: LOGO_URL,
    brand: 'Bread',
    network,
    address: ADDRESS,
    hint: 'Scan to send to this wallet'
  });

const c = QR_SHARE_CARD;

describe('resolution', () => {
  it('rasterises a 1080px-wide card, three times the design width', async () => {
    await compose('Miden Testnet');

    // The pixels the file actually carries — the old export was a 300px QR.
    expect(canvasSizes[0]).toEqual({ width: 1080, height: qrShareCardHeight(true) * 3 });
    expect(c.width * c.scale).toBe(1080);
    // Everything is drawn in logical units on top of one scale().
    expect(scales).toEqual([[3, 3]]);
    // A lossless encode: JPEG artefacts on a module edge are what a scanner trips over.
    expect(encodedAs).toEqual(['image/png']);
  });

  it('oversamples the code so the card can downscale it', () => {
    const drawn = (c.width - c.padding * 2 - c.tilePadding * 2) * c.scale;

    expect(drawn).toBe(768);
    expect(QR_SOURCE_SIZE).toBeGreaterThan(drawn);
  });

  it('keeps the quiet zone the 300px export drew, as a ratio', () => {
    // 6px at 300 was the previous fixed margin: raising the export resolution must not
    // shrink the zone the scanner needs, on screen or in the card.
    expect(Math.round(300 * QR_MARGIN_RATIO)).toBe(6);
    expect(Math.round(QR_SOURCE_SIZE * QR_MARGIN_RATIO)).toBe(20);
  });

  it('leaves the modules a quiet zone of their own around the code', () => {
    // The tile's inset alone, before the QR's own margin: at ~3.7 logical px per module for a
    // version-13 code this is ~7 modules, against the 4 the spec asks for.
    const modules = 77;
    const moduleSize = (c.width - c.padding * 2 - c.tilePadding * 2) / modules;

    expect(c.tilePadding / moduleSize).toBeGreaterThan(4);
  });
});

describe('composition', () => {
  it('lays the card out top to bottom: brand, code on its tile, network, address, hint', async () => {
    expect(await compose('Miden Testnet')).toBe(encoded);

    const tileY = c.top + c.markSize + c.brandToTile;
    const tile = c.width - c.padding * 2;
    const codeSize = tile - c.tilePadding * 2;

    // The surface, then the tile drawn as a rounded path on top of it.
    expect(rects).toEqual([
      { x: 0, y: 0, width: c.width, height: qrShareCardHeight(true), color: QR_SHARE_CARD_COLORS.surface }
    ]);
    expect(pathFills).toEqual([QR_SHARE_CARD_COLORS.tile]);

    // The mark, then the code inset by the quiet zone on all four sides.
    expect(images).toEqual([
      {
        source: loaded[1],
        x: 134,
        y: c.top + (c.markSize - c.markSize * MARK_RATIO) / 2,
        width: 32,
        height: 32 * MARK_RATIO
      },
      { source: loaded[0], x: c.padding + c.tilePadding, y: tileY + c.tilePadding, width: codeSize, height: codeSize }
    ]);
    expect(images[1]!.x).toBe(52);
    expect(images[1]!.y).toBe(110);
    expect(codeSize).toBe(256);

    expect(texts).toEqual([
      {
        text: 'Bread',
        // The mark and the name are centred together: (360 - (32 + 10 + 5 * 10)) / 2 = 134.
        x: 134 + c.markSize + c.markGap,
        y: c.top + c.markSize / 2,
        font: `800 22px 'Nunito', system-ui, sans-serif`,
        color: QR_SHARE_CARD_COLORS.ink,
        align: 'left',
        baseline: 'middle'
      },
      {
        text: 'MIDEN TESTNET',
        x: c.width / 2,
        y: 425,
        font: `800 15px 'Nunito', system-ui, sans-serif`,
        color: QR_SHARE_CARD_COLORS.network,
        align: 'center',
        baseline: 'middle'
      },
      {
        // The same truncation the page's copy button shows, whatever `utils/string` makes of
        // the address — the repo's root `__mocks__/utils/string.ts` hands every suite an identity.
        text: truncateAddress(ADDRESS, false, 16, 8),
        x: c.width / 2,
        y: 455,
        font: `700 16px 'Nunito', system-ui, sans-serif`,
        color: QR_SHARE_CARD_COLORS.ink,
        align: 'center',
        baseline: 'middle'
      },
      {
        text: 'Scan to send to this wallet',
        x: c.width / 2,
        y: 483,
        font: `400 13px 'Inter', system-ui, sans-serif`,
        color: QR_SHARE_CARD_COLORS.muted,
        align: 'center',
        baseline: 'middle'
      }
    ]);
  });

  it('drops the network line on mainnet and shortens the card by it', async () => {
    await compose();

    expect(texts.map(t => t.text)).toEqual([
      'Bread',
      truncateAddress(ADDRESS, false, 16, 8),
      'Scan to send to this wallet'
    ]);
    expect(qrShareCardHeight(false)).toBe(qrShareCardHeight(true) - c.networkLine - c.networkToAddress);
    expect(canvasSizes[0]!.height).toBe(qrShareCardHeight(false) * c.scale);
  });

  it('centres the name on its own when the mark will not load', async () => {
    failing = [LOGO_URL];

    expect(await compose('Miden Testnet')).toBe(encoded);
    // No mark drawn, and the code is the only image on the card.
    expect(images).toHaveLength(1);
    expect(images[0]!.width).toBe(256);
    expect(texts[0]!.x).toBe((c.width - 'Bread'.length * CHAR_WIDTH) / 2);
  });

  it('draws a mark with no intrinsic size square rather than dividing by zero', async () => {
    naturalWidth = 0;

    await compose('Miden Testnet');

    expect(images[0]).toMatchObject({ width: c.markSize, height: c.markSize, y: c.top });
  });

  it('waits for the app s own faces before measuring the lockup', async () => {
    // jsdom has no font loading API; a WebView that does must not be measured before it settles,
    // or the lockup is centred on the system font and drawn in Nunito.
    let settled = false;
    const ready = Promise.resolve().then(() => void (settled = true));
    Object.defineProperty(document, 'fonts', { configurable: true, value: { ready } });
    try {
      await compose('Miden Testnet');

      expect(settled).toBe(true);
      expect(texts).toHaveLength(4);
    } finally {
      Reflect.deleteProperty(document, 'fonts');
    }
  });

  it('releases the code s object URL and the canvas backing store', async () => {
    await compose('Miden Testnet');

    expect(URL.revokeObjectURL).toHaveBeenCalledWith(QR_URL);
    // toBlob saw the full-size canvas; it is released on the way out.
    expect(canvasSizes[0]!.width).toBe(1080);
  });
});

describe('when the realm cannot draw the card', () => {
  it('returns null without a 2d context, so the caller shares the raw QR', async () => {
    context = null;

    expect(await compose('Miden Testnet')).toBeNull();
    expect(images).toEqual([]);
  });

  it('returns null when the code image will not load', async () => {
    failing = [QR_URL];

    expect(await compose('Miden Testnet')).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(QR_URL);
    expect(texts).toEqual([]);
  });

  it('returns null when the canvas cannot encode', async () => {
    blob = null;

    expect(await compose('Miden Testnet')).toBeNull();
  });
});

describe('colours', () => {
  // The card is drawn on a canvas, so it cannot use the tokens; these literals are the tokens'
  // LIGHT values, pinned here so a shared file does not flip with the sender's theme. This test
  // is what keeps the copy honest when main.css moves.
  const css = fs.readFileSync(path.join(__dirname, '../../main.css'), 'utf8');
  const light = css.slice(css.indexOf('@layer base {'));
  const token = (name: string): string => {
    const match = light.match(new RegExp(`--${name}:\\s*([^;]+);`));
    if (!match?.[1]) throw new Error(`no such token: --${name}`);
    return match[1].trim().toLowerCase();
  };

  it.each([
    ['surface', 'ds-fill'],
    ['tile', 'ds-page'],
    ['ink', 'ds-ink'],
    ['muted', 'ds-muted'],
    ['network', 'network-miden-text']
  ] as const)('draws %s in the light value of --%s', (key, name) => {
    expect(QR_SHARE_CARD_COLORS[key]).toBe(token(name));
  });
});
