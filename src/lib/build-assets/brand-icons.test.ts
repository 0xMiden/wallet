import { readFileSync } from 'fs';
import { resolve } from 'path';
import { inflateSync } from 'zlib';

/**
 * The brand icons are rendered by hand from the SVG masters, and nothing else decodes them before they ship:
 * `Compile desktop (Tauri)` stayed green while icon.ico listed its 16px layer first, and a PNG renamed to .ico
 * once broke the Windows icon (#93). These checks pin what each consumer reads from the bytes.
 */
const ROOT = resolve(__dirname, '../../..');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_TRUECOLOUR = 2;
const PNG_TRUECOLOUR_ALPHA = 6;

interface PngHeader {
  width: number;
  height: number;
  colorType: number;
  chunkTypes: string[];
  idat: Buffer;
}

interface IcoLayer {
  width: number;
  height: number;
}

interface OpaqueExtent {
  columns: [number, number];
  rows: [number, number];
}

function readAsset(path: string): Buffer {
  return readFileSync(resolve(ROOT, path));
}

function readPngHeader(bytes: Buffer): PngHeader {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG');
  const header: PngHeader = { width: 0, height: 0, colorType: -1, chunkTypes: [], idat: Buffer.alloc(0) };
  const idat: Buffer[] = [];
  for (let offset = 8; offset < bytes.length; ) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    header.chunkTypes.push(type);
    if (type === 'IHDR') {
      header.width = body.readUInt32BE(0);
      header.height = body.readUInt32BE(4);
      header.colorType = body.readUInt8(9);
      if (body.readUInt8(8) !== 8 || body.readUInt8(12) !== 0) {
        throw new Error('only 8-bit non-interlaced PNGs are supported');
      }
    } else if (type === 'IDAT') {
      idat.push(body);
    }
    offset += length + 12;
  }
  header.idat = Buffer.concat(idat);
  return header;
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const toLeft = Math.abs(estimate - left);
  const toUp = Math.abs(estimate - up);
  const toUpLeft = Math.abs(estimate - upLeft);
  if (toLeft <= toUp && toLeft <= toUpLeft) return left;
  return toUp <= toUpLeft ? up : upLeft;
}

function predict(filter: number, left: number, up: number, upLeft: number): number {
  switch (filter) {
    case 0:
      return 0;
    case 1:
      return left;
    case 2:
      return up;
    case 3:
      return (left + up) >> 1;
    case 4:
      return paeth(left, up, upLeft);
    default:
      throw new Error(`unknown PNG filter type ${filter}`);
  }
}

/** Unfiltered RGBA bytes of an 8-bit, non-interlaced RGBA PNG. */
function decodeRgba(header: PngHeader): Buffer {
  if (header.colorType !== PNG_TRUECOLOUR_ALPHA) {
    throw new Error(`expected RGBA, got colour type ${header.colorType}`);
  }
  const filtered = inflateSync(header.idat);
  const stride = header.width * 4;
  const pixels = Buffer.alloc(stride * header.height);
  for (let y = 0; y < header.height; y++) {
    const row = y * (stride + 1);
    const filter = filtered.readUInt8(row);
    for (let x = 0; x < stride; x++) {
      const at = y * stride + x;
      const left = x >= 4 ? pixels.readUInt8(at - 4) : 0;
      const up = y > 0 ? pixels.readUInt8(at - stride) : 0;
      const upLeft = x >= 4 && y > 0 ? pixels.readUInt8(at - stride - 4) : 0;
      pixels.writeUInt8((filtered.readUInt8(row + 1 + x) + predict(filter, left, up, upLeft)) & 0xff, at);
    }
  }
  return pixels;
}

/** First and last pixel columns and rows holding any non-transparent pixel. */
function opaqueExtent(header: PngHeader): OpaqueExtent {
  const pixels = decodeRgba(header);
  const extent: OpaqueExtent = { columns: [header.width, -1], rows: [header.height, -1] };
  for (let y = 0; y < header.height; y++) {
    for (let x = 0; x < header.width; x++) {
      if (pixels.readUInt8((y * header.width + x) * 4 + 3) > 0) {
        extent.columns = [Math.min(extent.columns[0], x), Math.max(extent.columns[1], x)];
        extent.rows = [Math.min(extent.rows[0], y), Math.max(extent.rows[1], y)];
      }
    }
  }
  return extent;
}

/** Each layer of an ICO directory, in directory order (a stored 0 means 256). */
function icoLayers(bytes: Buffer): IcoLayer[] {
  if (bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) throw new Error('not an ICO');
  return Array.from({ length: bytes.readUInt16LE(4) }, (_, index) => ({
    width: bytes.readUInt8(6 + 16 * index) || 256,
    height: bytes.readUInt8(7 + 16 * index) || 256
  }));
}

describe('brand icons', () => {
  it('lists the 32px layer first in icon.ico, the layer Tauri embeds as the Windows window icon', () => {
    const layers = icoLayers(readAsset('src-tauri/icons/icon.ico'));

    expect(layers[0]).toEqual({ width: 32, height: 32 });
    expect(layers.map(layer => layer.width).sort((a, b) => a - b)).toEqual([16, 24, 32, 48, 64, 256]);
  });

  it('keeps the App Store icon at 1024x1024 with no alpha', () => {
    const header = readPngHeader(readAsset('ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'));

    expect([header.width, header.height]).toEqual([1024, 1024]);
    expect(header.colorType).toBe(PNG_TRUECOLOUR);
    expect(header.chunkTypes).not.toContain('tRNS');
  });

  it.each(['logo-white-bg', 'logo-devnet'])('draws the %s extension icons edge to edge (#346)', name => {
    for (const size of [16, 32, 48, 128]) {
      const { columns, rows } = opaqueExtent(readPngHeader(readAsset(`public/misc/${name}-${size}.png`)));

      // The mark is slightly wider than tall, so it spans the full width and all but a sliver of the height.
      expect({ size, columns }).toEqual({ size, columns: [0, size - 1] });
      expect({ size, rows: rows[1] - rows[0] + 1 >= Math.floor(size * 0.95) }).toEqual({ size, rows: true });
    }
  });
});
