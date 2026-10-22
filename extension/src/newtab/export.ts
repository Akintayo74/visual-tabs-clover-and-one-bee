import { Zip, ZipDeflate, ZipPassThrough, strToU8 } from 'fflate';
import { getFingerprint, getImage, listSaves } from '@/src/lib/db';
import type { Fingerprint, ImageVariant, SaveRecord } from '@/src/lib/types';

export const EXPORT_VERSION = 1;

export interface ExportedSave {
  id: string;
  url: string;
  canonicalUrl: string | null;
  title: string;
  siteName: string;
  faviconUrl: string | null;
  createdAt: string;
  capturedAt: string;
  width: number;
  height: number;
  palette: string[];
  fonts: string[];
  note: string | null;
  fingerprint: Fingerprint | null;
  /** What the model made of the save, once the server has described it. */
  description: string | null;
  recallPhrases: string[];
  tags: string[];
  /** Paths inside the zip. `raw` is only there for saves whose images weren't processed yet. */
  images: Partial<Record<ImageVariant, string>>;
}

export interface ExportManifest {
  version: typeof EXPORT_VERSION;
  exportedAt: string;
  saves: ExportedSave[];
}

const EXTENSIONS: Record<ImageVariant, string> = { full: 'webp', card: 'webp', raw: 'jpg' };

export function exportedSave(
  save: SaveRecord,
  fingerprint: Fingerprint | null,
  variants: ImageVariant[],
): ExportedSave {
  return {
    id: save.id,
    url: save.url,
    canonicalUrl: save.canonicalUrl,
    title: save.title,
    siteName: save.siteName,
    faviconUrl: save.faviconUrl,
    createdAt: new Date(save.createdAt).toISOString(),
    capturedAt: new Date(save.updatedAt).toISOString(),
    width: save.width,
    height: save.height,
    palette: save.palette,
    fonts: save.fonts,
    note: save.note,
    fingerprint,
    description: save.understanding?.description ?? null,
    recallPhrases: save.understanding?.recallPhrases ?? [],
    tags: save.understanding?.tags ?? [],
    images: Object.fromEntries(variants.map((v) => [v, `images/${save.id}-${v}.${EXTENSIONS[v]}`])),
  };
}

/**
 * Zips every save on this device: saves.json plus each save's images. Images are stored
 * uncompressed because WebP and JPEG don't compress further.
 */
export async function buildExport(now = new Date()): Promise<Blob> {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  const result: { failure: Error | null } = { failure: null };
  let finished: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const zip = new Zip((error, chunk, final) => {
    if (error) result.failure = error;
    else chunks.push(chunk);
    if (error || final) finished();
  });

  const manifest: ExportManifest = {
    version: EXPORT_VERSION,
    exportedAt: now.toISOString(),
    saves: [],
  };
  for (const save of await listSaves()) {
    const variants: ImageVariant[] = [];
    for (const variant of ['full', 'card', 'raw'] as const) {
      const blob = await getImage(save.id, variant);
      if (!blob) continue;
      // Once processed, the raw capture is gone; while it's still here, full/card aren't.
      variants.push(variant);
      const file = new ZipPassThrough(`images/${save.id}-${variant}.${EXTENSIONS[variant]}`);
      zip.add(file);
      file.push(new Uint8Array(await blob.arrayBuffer()), true);
    }
    manifest.saves.push(exportedSave(save, (await getFingerprint(save.id)) ?? null, variants));
  }
  const json = new ZipDeflate('saves.json', { level: 6 });
  zip.add(json);
  json.push(strToU8(JSON.stringify(manifest, null, 2)), true);
  zip.end();
  await done;
  if (result.failure) throw result.failure;
  return new Blob(chunks, { type: 'application/zip' });
}

export function exportFileName(now = new Date()): string {
  return `visual-tabs-export-${now.toISOString().slice(0, 10)}.zip`;
}
