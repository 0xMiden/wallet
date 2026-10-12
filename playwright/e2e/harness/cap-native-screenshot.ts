import * as fs from 'fs';
import sharp from 'sharp';

export async function capNativeScreenshot(path: string): Promise<void> {
  const raw = await sharp(path).metadata();
  const image = await sharp(path)
    .resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();
  fs.writeFileSync(path, image);
  const saved = await sharp(image).metadata();
  fs.writeFileSync(
    path + '.dimensions.json',
    JSON.stringify({
      raw: { width: raw.width, height: raw.height },
      saved: { width: saved.width, height: saved.height }
    })
  );
}
