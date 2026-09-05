import JSZip from "jszip";

/**
 * .docx, .xlsx, and .pptx are all zip containers, and every library that
 * reads them (exceljs, mammoth, and this codebase's own pptx reader via
 * JSZip directly) decompresses each entry with no size limit — a small file
 * whose declared uncompressed size is huge can exhaust memory before the
 * library that actually parses the format ever runs (see CVE-2026-78206 for
 * exceljs specifically; mammoth uses the same unbounded JSZip decompression
 * path). Loading with JSZip first only reads the central directory (cheap,
 * no inflation) so summing each entry's *declared* uncompressed size rejects
 * a bomb before any real parsing starts.
 */
const MAX_ZIP_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;

/** Throws if `zip`'s entries declare more than `maxBytes` of uncompressed data combined. */
export function assertSafeZipEntries(
  zip: JSZip,
  maxBytes: number = MAX_ZIP_UNCOMPRESSED_BYTES
): void {
  let total = 0;
  for (const entry of Object.values(zip.files)) {
    // `_data` is JSZip's internal CompressedObject; there is no public API
    // for a zip entry's declared (pre-inflation) uncompressed size.
    total +=
      (entry as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
    if (total > maxBytes) {
      throw new Error(
        `This file's declared uncompressed size exceeds ` +
          `${maxBytes / (1024 * 1024)}MB and was refused as a likely decompression bomb ` +
          `rather than risk exhausting memory.`
      );
    }
  }
}

/** Loads `buf` as a zip and validates its declared uncompressed size, returning the loaded zip for reuse. */
export async function loadSafeZip(
  buf: Buffer,
  maxBytes: number = MAX_ZIP_UNCOMPRESSED_BYTES
): Promise<JSZip> {
  const zip = await JSZip.loadAsync(buf);
  assertSafeZipEntries(zip, maxBytes);
  return zip;
}
