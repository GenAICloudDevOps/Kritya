import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

/**
 * Write a file without ever leaving a truncated one behind.
 *
 * `fs.writeFile` to the target truncates it first and then fills it back in.
 * Anything that interrupts the gap — a crash, a kill switch, a power cut, a
 * full disk partway through a large file — leaves the user's source file
 * destroyed, with the original recoverable only from the in-memory undo stack
 * of the process that just died. Writing a sibling temp file and renaming it
 * over the target closes that window: rename is a single filesystem metadata
 * operation, so a reader sees either the whole old file or the whole new one.
 *
 * Three details this has to get right that a bare rename does not:
 *
 *  - **Symlinks.** `fs.writeFile` follows them and writes through to the
 *    target; a rename would replace the link itself. The real path is
 *    resolved first so the observable behavior is unchanged.
 *  - **Permissions.** A renamed-in file carries the temp file's mode, not the
 *    original's, which would silently strip the executable bit off a script.
 *    The existing mode is copied across before the rename.
 *  - **Windows.** A rename onto a file another process holds open (an editor,
 *    an indexer, antivirus) fails with EPERM/EBUSY where a plain write would
 *    have succeeded. That must not turn a working write into an error, so it
 *    falls back to writing in place — no worse than the old behavior, and only
 *    on the paths where the old behavior was the only option.
 *
 * Durability is deliberately not part of the contract: there is no fsync, so a
 * power loss can still lose a just-written file on some filesystems. The
 * hazard being closed here is truncation, which is both far likelier and far
 * more destructive, and fsync on every edit is a cost every write would pay.
 */

/** Codes that mean "the target is locked", not "the write is wrong". */
const RENAME_FALLBACK_CODES = new Set(["EPERM", "EACCES", "EBUSY", "EEXIST", "ENOTEMPTY"]);

function tempPathFor(filePath: string): string {
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp-${unique}`);
}

/** Resolve symlinks so we replace what the path points at, not the link. */
function resolveTarget(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return filePath; // doesn't exist yet — nothing to follow
  }
}

/** The mode to give the replacement, when the file already exists. */
function existingMode(filePath: string): number | undefined {
  try {
    return fs.statSync(filePath).mode & 0o777;
  } catch {
    return undefined;
  }
}

export interface AtomicWriteOptions {
  /** Force this mode instead of inheriting the existing file's. */
  mode?: number;
  /** Text encoding; ignored when the data is a Buffer. Defaults to utf8. */
  encoding?: BufferEncoding;
}

export async function writeFileAtomic(
  filePath: string,
  data: string | Buffer,
  options: AtomicWriteOptions = {}
): Promise<void> {
  const target = resolveTarget(filePath);
  const mode = options.mode ?? existingMode(target);
  const tmp = tempPathFor(target);
  try {
    await fsp.writeFile(tmp, data, options.encoding ?? (typeof data === "string" ? "utf8" : null));
    if (mode !== undefined) await fsp.chmod(tmp, mode);
    await fsp.rename(tmp, target);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    if (!isRenameFallback(err)) throw err;
    await fsp.writeFile(
      filePath,
      data,
      options.encoding ?? (typeof data === "string" ? "utf8" : null)
    );
  }
}

export function writeFileAtomicSync(
  filePath: string,
  data: string | Buffer,
  options: AtomicWriteOptions = {}
): void {
  const target = resolveTarget(filePath);
  const mode = options.mode ?? existingMode(target);
  const tmp = tempPathFor(target);
  try {
    fs.writeFileSync(tmp, data, {
      ...(options.encoding ? { encoding: options.encoding } : {}),
      ...(mode !== undefined ? { mode } : {}),
    });
    // writeFileSync's `mode` only applies when it creates the file, and umask
    // can mask bits off it — set it explicitly so the replacement really does
    // carry the original's permissions.
    if (mode !== undefined) fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Nothing more to do; the write result below is what matters.
    }
    if (!isRenameFallback(err)) throw err;
    fs.writeFileSync(filePath, data, {
      ...(options.encoding ? { encoding: options.encoding } : {}),
      ...(mode !== undefined ? { mode } : {}),
    });
  }
}

function isRenameFallback(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return !!code && RENAME_FALLBACK_CODES.has(code);
}
