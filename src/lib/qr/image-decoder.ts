import jsQR from 'jsqr';

/** Decode locally, including WebViews without BarcodeDetector/createImageBitmap. */
export async function decodeQrImage(file: File): Promise<string> {
  if (file.size > 20 * 1024 * 1024) throw new Error('invalidQrImage');
  const url = URL.createObjectURL(file);
  const image = new Image();
  const canvas = document.createElement('canvas');
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('invalidQrImage'));
      image.src = url;
    });
    const scale = Math.min(1, 2048 / Math.max(image.naturalWidth, image.naturalHeight));
    canvas.width = Math.round(image.naturalWidth * scale);
    canvas.height = Math.round(image.naturalHeight * scale);
    const context = canvas.getContext('2d');
    if (!context || !canvas.width || !canvas.height) throw new Error('invalidQrImage');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    try {
      const result = jsQR(pixels.data, pixels.width, pixels.height);
      if (!result) throw new Error('invalidQrImage');
      return result.data;
    } finally {
      pixels.data.fill(0);
    }
  } finally {
    image.onload = null;
    image.onerror = null;
    image.src = '';
    canvas.width = 0;
    canvas.height = 0;
    URL.revokeObjectURL(url);
  }
}
