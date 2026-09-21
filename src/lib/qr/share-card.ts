import { truncateAddress } from 'utils/string';

/**
 * The image Receive shares: the QR laid out as a card, not a picture of the code.
 *
 * What went out before was `qr-code-styling`'s own 300px PNG with a caption strip painted under
 * it — the modules ran into all four edges, the network name sat on the bottom edge, and opened
 * full screen on a phone the whole thing was upscaled ~4x. This draws the code onto a surface
 * with a header, a quiet zone the scanner wants anyway, and the identifying lines placed rather
 * than appended.
 *
 * Everything below is in LOGICAL units — the wallet's own 360px layout width, so the numbers read
 * like the spacing and type scale the screens use — and the canvas is scaled once by `scale`.
 */

/**
 * 3x the 360px design width = a 1080px-wide PNG.
 *
 * 1080 is the width messengers keep: WhatsApp, Telegram and iMessage re-encode above roughly
 * 1280–1600px on the long edge, and a 1080 x ~1560 card is under that on both. It also puts about
 * 10 device pixels on every QR module, so the code survives a lossy re-encode, and it is the
 * smallest multiple of the design width that does — 2x was still soft full screen on a 3x phone.
 */
const SCALE = 3;

/**
 * The resolution the QR itself is rasterised at before it is drawn into the card. The card draws
 * it at 256 logical px = 768 device px, so 1024 oversamples it slightly: the downscale is what
 * keeps the module edges clean. (The old export rendered the QR at 300 and shared it as-is.)
 */
export const QR_SOURCE_SIZE = 1024;

/**
 * The QR's quiet zone and the gap around its embedded logo, as a fraction of the rendered size.
 * 0.02 is exactly the 6px both used at the previous 300px export size, expressed so raising the
 * export resolution cannot shrink either one on screen.
 */
export const QR_MARGIN_RATIO = 0.02;

/** The card's geometry. Exported so the layout is assertable without a real canvas. */
export const QR_SHARE_CARD = {
  scale: SCALE,
  width: 360,
  padding: 24,
  top: 28,
  bottom: 28,
  /** The Bread mark in the header, and the gap to the wallet's name beside it. */
  markSize: 32,
  markGap: 10,
  brandFont: 22,
  brandToTile: 22,
  /** The white tile the code sits on: `fill`'s 16px radius doubled, because the tile is large. */
  tileRadius: 28,
  /** The quiet zone. At ~3.5 logical px per module this is about 8 modules, twice the QR spec. */
  tilePadding: 28,
  tileToText: 22,
  networkFont: 15,
  networkLine: 18,
  networkToAddress: 10,
  addressFont: 16,
  addressLine: 22,
  addressToHint: 8,
  hintFont: 13,
  hintLine: 18
} as const;

/**
 * The card's colours, pinned to the LIGHT values of the design tokens they name.
 *
 * A shared file is a fixed artefact: it is read in someone else's chat, not in the sender's
 * wallet, so it cannot flip with the sender's theme. Same reason `--qr-*` is declared once in
 * main.css and never redeclared under `.dark`. `share-card.test.ts` pins each one against
 * main.css so a token change cannot drift the card silently.
 */
export const QR_SHARE_CARD_COLORS = {
  /** `--ds-fill` — the warm paper the card is printed on. */
  surface: '#f3f0ec',
  /** `--ds-page` — the tile under the code. The modules need white to scan off. */
  tile: '#ffffff',
  /** `--ds-ink` — the wallet's name and the address. */
  ink: '#3f3f3f',
  /** `--ds-muted` — the line saying what the code is for. 4.7:1 on the surface. */
  muted: '#6b6b6b',
  /**
   * `--network-miden-text` — the network name, the same colour the NetworkChip on the page gives
   * it. Deliberately NOT the QR's own palette colour: the card cycles through the five card
   * colours and the greens and slates land near 3:1 on the surface, under the 4.5:1 a 15px label
   * owes. The code carries the colour; the label carries the contrast.
   */
  network: '#9f4518'
} as const;

const HEADING_FONT = "'Nunito', system-ui, sans-serif";
const BODY_FONT = "'Inter', system-ui, sans-serif";

export interface QrShareCardOptions {
  /** The bare QR PNG, as `qr-code-styling` rasterises it. */
  qr: Blob;
  /** URL of the Bread mark drawn in the card's header. */
  logoUrl: string;
  /** The wallet's name, beside the mark. */
  brand: string;
  /** "Miden Testnet". Absent on mainnet, where there is no test network to name. */
  network?: string;
  /** Drawn under the code, truncated the same way the page's copy button shows it. */
  address: string;
  /** One line saying what the code is for. */
  hint: string;
}

/** The card's height for the lines it carries: the network line is the only optional one. */
export const qrShareCardHeight = (hasNetwork: boolean): number => {
  const c = QR_SHARE_CARD;
  const tile = c.width - c.padding * 2;
  const network = hasNetwork ? c.networkLine + c.networkToAddress : 0;
  return (
    c.top +
    c.markSize +
    c.brandToTile +
    tile +
    c.tileToText +
    network +
    c.addressLine +
    c.addressToHint +
    c.hintLine +
    c.bottom
  );
};

/** `roundRect` only reached Safari 16, and this runs in every WebView the wallet ships in. */
const roundedRectPath = (ctx: CanvasRenderingContext2D, x: number, y: number, size: number, radius: number): void => {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + size, y, x + size, y + size, radius);
  ctx.arcTo(x + size, y + size, x, y + size, radius);
  ctx.arcTo(x, y + size, x, y, radius);
  ctx.arcTo(x, y, x + size, y, radius);
  ctx.closePath();
};

/** Resolves to null rather than rejecting: a card the mark is missing from is still a card. */
const loadImage = (src: string): Promise<HTMLImageElement | null> =>
  new Promise(resolve => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });

/**
 * Compose the share card. Returns null when the realm cannot draw it (no document, no 2d context,
 * an image that will not load, a canvas that cannot encode) so the caller can still share the raw
 * QR instead of losing the share.
 */
export async function composeQrShareCard({
  qr,
  logoUrl,
  brand,
  network,
  address,
  hint
}: QrShareCardOptions): Promise<Blob | null> {
  if (typeof document === 'undefined') return null;

  const c = QR_SHARE_CARD;
  const height = qrShareCardHeight(Boolean(network));
  const canvas = document.createElement('canvas');
  canvas.width = c.width * c.scale;
  canvas.height = height * c.scale;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const codeUrl = URL.createObjectURL(qr);
  let code: HTMLImageElement | null;
  try {
    code = await loadImage(codeUrl);
  } finally {
    URL.revokeObjectURL(codeUrl);
  }
  if (!code) return null;
  const mark = await loadImage(logoUrl);

  // The card is typeset in the app's own faces; wait for them before measuring the lockup, or a
  // first share measures Nunito and draws the system font.
  if (document.fonts) await document.fonts.ready;

  ctx.scale(c.scale, c.scale);
  ctx.fillStyle = QR_SHARE_CARD_COLORS.surface;
  ctx.fillRect(0, 0, c.width, height);

  // Header: the mark and the wallet's name, centred together as one lockup.
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.font = `800 ${c.brandFont}px ${HEADING_FONT}`;
  ctx.fillStyle = QR_SHARE_CARD_COLORS.ink;
  const brandWidth = ctx.measureText(brand).width;
  let x = (c.width - (mark ? c.markSize + c.markGap + brandWidth : brandWidth)) / 2;
  if (mark) {
    // The mark is not square (273 x 263.2), so it keeps its own aspect inside the 32px slot.
    const markHeight = mark.naturalWidth ? (c.markSize * mark.naturalHeight) / mark.naturalWidth : c.markSize;
    ctx.drawImage(mark, x, c.top + (c.markSize - markHeight) / 2, c.markSize, markHeight);
    x += c.markSize + c.markGap;
  }
  ctx.fillText(brand, x, c.top + c.markSize / 2);

  // The code on its tile, inset by the quiet zone on all four sides.
  const tileY = c.top + c.markSize + c.brandToTile;
  const tileSize = c.width - c.padding * 2;
  ctx.fillStyle = QR_SHARE_CARD_COLORS.tile;
  roundedRectPath(ctx, c.padding, tileY, tileSize, c.tileRadius);
  ctx.fill();
  const codeSize = tileSize - c.tilePadding * 2;
  ctx.drawImage(code, c.padding + c.tilePadding, tileY + c.tilePadding, codeSize, codeSize);

  // Then what the code is: which network, whose address, what to do with it.
  ctx.textAlign = 'center';
  let y = tileY + tileSize + c.tileToText;
  if (network) {
    ctx.font = `800 ${c.networkFont}px ${HEADING_FONT}`;
    ctx.fillStyle = QR_SHARE_CARD_COLORS.network;
    ctx.fillText(network.toUpperCase(), c.width / 2, y + c.networkLine / 2);
    y += c.networkLine + c.networkToAddress;
  }
  ctx.font = `700 ${c.addressFont}px ${HEADING_FONT}`;
  ctx.fillStyle = QR_SHARE_CARD_COLORS.ink;
  ctx.fillText(truncateAddress(address, false, 16, 8), c.width / 2, y + c.addressLine / 2);
  y += c.addressLine + c.addressToHint;
  ctx.font = `400 ${c.hintFont}px ${BODY_FONT}`;
  ctx.fillStyle = QR_SHARE_CARD_COLORS.muted;
  ctx.fillText(hint, c.width / 2, y + c.hintLine / 2);

  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
  // A 1080 x ~1560 bitmap is ~6MB of backing store; hand it back before the share dialog opens.
  canvas.width = 0;
  canvas.height = 0;
  return blob;
}
