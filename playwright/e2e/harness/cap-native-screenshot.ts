import * as fs from 'fs';
import sharp from 'sharp';

export async function capNativeScreenshot(path: string): Promise<void> {
  const image = await sharp(path)
    .resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();
  fs.writeFileSync(path, image);
}
