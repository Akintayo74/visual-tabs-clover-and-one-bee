export const FULL_WIDTH = 2400;
export const CARD_WIDTH = 960;
const FULL_QUALITY = 0.8;
const CARD_QUALITY = 0.75;

export interface Variants {
  full: Blob;
  card: Blob;
  width: number;
  height: number;
}

/**
 * Scales a bitmap down to at most maxWidth, keeping its aspect ratio (never cropping
 * or upscaling). Halves in steps so large downscales stay sharp.
 */
function scale(source: ImageBitmap | OffscreenCanvas, maxWidth: number): OffscreenCanvas {
  const targetWidth = Math.min(maxWidth, source.width);
  const targetHeight = Math.round((source.height * targetWidth) / source.width);
  let current: ImageBitmap | OffscreenCanvas = source;
  while (current.width / 2 > targetWidth) {
    current = draw(current, Math.round(current.width / 2), Math.round(current.height / 2));
  }
  return draw(current, targetWidth, targetHeight);
}

function draw(
  source: ImageBitmap | OffscreenCanvas,
  width: number,
  height: number,
): OffscreenCanvas {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is unavailable');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, width, height);
  return canvas;
}

async function encode(canvas: OffscreenCanvas, quality: number): Promise<Blob> {
  const blob = await canvas.convertToBlob({ type: 'image/webp', quality });
  // Browsers fall back to PNG when they can't encode the requested type.
  if (blob.type !== 'image/webp') throw new Error(`WebP encoding unavailable (got ${blob.type})`);
  return blob;
}

/** Makes the stored WebP versions (full and card) from a raw capture. */
export async function makeVariants(raw: Blob): Promise<Variants> {
  const bitmap = await createImageBitmap(raw);
  try {
    const full = scale(bitmap, FULL_WIDTH);
    const card = scale(full, CARD_WIDTH);
    return {
      full: await encode(full, FULL_QUALITY),
      card: await encode(card, CARD_QUALITY),
      width: full.width,
      height: full.height,
    };
  } finally {
    bitmap.close();
  }
}

export async function imageSize(blob: Blob): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(blob);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return size;
}
