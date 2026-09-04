import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { writeFileAtomic, writeFileAtomicSync } from "../atomicWrite.js";

async function makeDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), "kritya-atomic-"));
}

/** Temp files must never be left lying around next to the user's source. */
async function siblings(dir: string): Promise<string[]> {
  return (await fsp.readdir(dir)).sort();
}

test("writeFileAtomic creates a new file and leaves no temp file behind", async () => {
  const dir = await makeDir();
  const file = path.join(dir, "new.txt");

  await writeFileAtomic(file, "hello");

  assert.equal(await fsp.readFile(file, "utf8"), "hello");
  assert.deepEqual(await siblings(dir), ["new.txt"]);
});

test("writeFileAtomic replaces existing content", async () => {
  const dir = await makeDir();
  const file = path.join(dir, "x.txt");
  await fsp.writeFile(file, "old content that is longer");

  await writeFileAtomic(file, "new");

  assert.equal(await fsp.readFile(file, "utf8"), "new");
  assert.deepEqual(await siblings(dir), ["x.txt"]);
});

test("writeFileAtomic round-trips binary data unchanged", async () => {
  const dir = await makeDir();
  const file = path.join(dir, "b.bin");
  const bytes = Buffer.from([0x00, 0xff, 0x1f, 0x80, 0x0a, 0x00]);

  await writeFileAtomic(file, bytes);

  assert.deepEqual(await fsp.readFile(file), bytes);
});

test("writeFileAtomic keeps the original file's permissions", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX modes are not meaningful on Windows");
  const dir = await makeDir();
  const file = path.join(dir, "script.sh");
  await fsp.writeFile(file, "#!/bin/sh\necho old\n");
  await fsp.chmod(file, 0o755);

  await writeFileAtomic(file, "#!/bin/sh\necho new\n");

  // Renaming a fresh temp file over the target would have silently dropped
  // the executable bit and broken the script.
  assert.equal((await fsp.stat(file)).mode & 0o777, 0o755);
});

test("writeFileAtomic writes through a symlink instead of replacing it", async (t) => {
  const dir = await makeDir();
  const real = path.join(dir, "real.txt");
  const link = path.join(dir, "link.txt");
  await fsp.writeFile(real, "original");
  try {
    await fsp.symlink(real, link);
  } catch {
    return t.skip("symlinks not permitted on this machine");
  }

  await writeFileAtomic(link, "updated");

  assert.equal(await fsp.readFile(real, "utf8"), "updated", "the target was updated");
  assert.ok((await fsp.lstat(link)).isSymbolicLink(), "the link itself was not replaced");
});

test("writeFileAtomic honors an explicit mode from the very first write, not just after a later chmod", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX modes are not meaningful on Windows");
  const dir = await makeDir();
  const file = path.join(dir, "secret.json");

  await writeFileAtomic(file, '{"apiKey":"x"}\n', { mode: 0o600 });

  // An explicit mode must win over both the umask and any inherited mode —
  // config.json holds secrets, so there must be no window where the temp
  // file sits at a more permissive default mode before being narrowed.
  assert.equal((await fsp.stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await siblings(dir), ["secret.json"]);
});

test("writeFileAtomic leaves the old content intact when the write fails", async () => {
  const dir = await makeDir();
  const file = path.join(dir, "keep.txt");
  await fsp.writeFile(file, "precious");

  // A directory where the temp file needs to go cannot be written to.
  await assert.rejects(() => writeFileAtomic(path.join(dir, "nope", "deep.txt"), "x"));
  // The unrelated file is untouched, and no debris was left in the directory.
  assert.equal(await fsp.readFile(file, "utf8"), "precious");
  assert.deepEqual(await siblings(dir), ["keep.txt"]);
});

test("writeFileAtomicSync honors an explicit mode and cleans up after itself", async (t) => {
  const dir = await makeDir();
  const file = path.join(dir, "secret.jsonl");

  writeFileAtomicSync(file, '{"a":1}\n', { mode: 0o600 });

  assert.equal(fs.readFileSync(file, "utf8"), '{"a":1}\n');
  assert.deepEqual(await siblings(dir), ["secret.jsonl"]);
  if (process.platform === "win32") return t.skip("POSIX modes are not meaningful on Windows");
  // An explicit mode must win over both the umask and any inherited mode —
  // transcripts can contain secrets that passed through tool output.
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("writeFileAtomicSync round-trips latin1 bytes, as the undo stack needs", async () => {
  const dir = await makeDir();
  const file = path.join(dir, "u.bin");
  // latin1 is what UndoStack snapshots binary files as; every byte 0-255 must
  // survive the trip or restoring a docx/pdf would corrupt it.
  const content = Buffer.from([0x00, 0x80, 0xfe, 0xff]).toString("latin1");

  writeFileAtomicSync(file, content, { encoding: "latin1" });

  assert.deepEqual(fs.readFileSync(file), Buffer.from([0x00, 0x80, 0xfe, 0xff]));
});
