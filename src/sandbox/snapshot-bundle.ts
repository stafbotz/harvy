import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type { ProjectSnapshotManifest } from "../domain/project-workspace.js";
import type {
  SandboxInputSnapshotDescriptor,
  SandboxInputSnapshotSource,
} from "../domain/sandbox.js";
import { canonicalProjectPath, resolveProjectPath } from "../core/project-files.js";
import {
  containsSecretLikeValue,
  isSensitiveProjectPath,
} from "../security/credential-like.js";

const MAGIC = Buffer.from("HARVY_SNAPSHOT_BUNDLE_V1\n", "ascii");
const MEDIA_TYPE = "application/vnd.harvy.snapshot-bundle.v1" as const;
const MAX_CHUNK_BYTES = 64 * 1024;

/**
 * Membentuk bundle deterministik dari snapshot immutable. Descriptor dihitung
 * melalui pass penuh pertama; setiap open melakukan verifikasi file lagi agar
 * transport tidak pernah menerima byte yang diam-diam berbeda dari manifest.
 */
export async function createSandboxSnapshotSource(
  rootInput: string,
  manifestInput: ProjectSnapshotManifest,
): Promise<SandboxInputSnapshotSource> {
  const root = rootInput;
  const rootState = await lstat(root);
  if (!rootState.isDirectory() || rootState.isSymbolicLink()) {
    throw new Error("Root bundle sandbox harus snapshot direktori nyata.");
  }
  const manifest = structuredClone(manifestInput);
  const manifestBytes = canonicalManifestBytes(manifest);
  const manifestSha256 = sha256(manifestBytes);
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of bundleChunks(root, manifest, manifestBytes)) {
    size += chunk.byteLength;
    if (!Number.isSafeInteger(size)) {
      throw new Error("Ukuran bundle snapshot melampaui integer aman.");
    }
    hash.update(chunk);
  }
  const descriptor: SandboxInputSnapshotDescriptor = Object.freeze({
    version: 1,
    snapshotId: manifest.snapshotId,
    bundleSha256: hash.digest("hex"),
    manifestSha256,
    size,
    fileCount: manifest.files.length,
    mediaType: MEDIA_TYPE,
  });
  return Object.freeze({
    descriptor,
    open: () => bundleChunks(root, manifest, manifestBytes),
  });
}

async function* bundleChunks(
  root: string,
  manifest: ProjectSnapshotManifest,
  manifestBytes: Buffer,
): AsyncGenerator<Uint8Array> {
  yield MAGIC;
  yield manifestBytes;
  yield Buffer.from("\n", "ascii");
  for (const file of manifest.files) {
    const path = canonicalProjectPath(file.path);
    const header = Buffer.from(
      `${JSON.stringify({
        path,
        size: file.size,
        sha256: file.sha256,
        executable: file.executable,
      })}\n`,
      "utf8",
    );
    yield header;
    const absolute = resolveProjectPath(root, path);
    const noFollow = constants.O_NOFOLLOW ?? 0;
    const handle = await open(absolute, constants.O_RDONLY | noFollow);
    const fileHash = createHash("sha256");
    const decoder = new TextDecoder("utf-8", { fatal: false });
    let secretScanTail = "";
    let position = 0;
    try {
      const state = await handle.stat();
      if (!state.isFile() || state.size !== file.size) {
        throw new Error("File snapshot berubah sebelum bundle sandbox dibaca.");
      }
      while (position < file.size) {
        const length = Math.min(MAX_CHUNK_BYTES, file.size - position);
        const buffer = Buffer.allocUnsafe(length);
        const read = await handle.read(buffer, 0, length, position);
        if (read.bytesRead !== length) {
          throw new Error("File snapshot terpotong saat bundle sandbox dibaca.");
        }
        position += read.bytesRead;
        const chunk = buffer.subarray(0, read.bytesRead);
        fileHash.update(chunk);
        secretScanTail = scanProviderBoundText(
          secretScanTail,
          decoder.decode(chunk, { stream: true }),
        );
        yield chunk;
      }
    } finally {
      await handle.close();
    }
    if (position !== file.size || fileHash.digest("hex") !== file.sha256) {
      throw new Error("Hash file snapshot berubah saat bundle sandbox dibaca.");
    }
    scanProviderBoundText(secretScanTail, decoder.decode());
    yield Buffer.from("\n", "ascii");
  }
}

function canonicalManifestBytes(manifest: ProjectSnapshotManifest): Buffer {
  if (
    manifest.version !== 1 ||
    !/^[a-f0-9]{64}$/u.test(manifest.snapshotId) ||
    !Number.isSafeInteger(manifest.totalBytes) ||
    manifest.totalBytes < 0 ||
    !Array.isArray(manifest.files)
  ) {
    throw new Error("Manifest bundle sandbox tidak sah.");
  }
  const files = manifest.files.map((file) => {
    const path = canonicalProjectPath(file.path);
    if (isSensitiveProjectPath(path) || containsSecretLikeValue(path)) {
      throw new Error(
        "Snapshot memuat path sensitif yang tidak boleh masuk trust-domain consumer.",
      );
    }
    if (
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      !/^[a-f0-9]{64}$/u.test(file.sha256) ||
      typeof file.executable !== "boolean"
    ) {
      throw new Error("Entry manifest bundle sandbox tidak sah.");
    }
    return {
      path,
      size: file.size,
      sha256: file.sha256,
      executable: file.executable,
    };
  });
  return Buffer.from(JSON.stringify({
    version: 1,
    snapshotId: manifest.snapshotId,
    totalBytes: manifest.totalBytes,
    files,
  }), "utf8");
}

function scanProviderBoundText(
  tail: string,
  next: string,
): string {
  const combined = `${tail}${next}`;
  if (containsSecretLikeValue(combined)) {
    throw new Error(
      "Snapshot memuat credential-like content yang tidak boleh masuk trust-domain consumer.",
    );
  }
  return combined.slice(-4_096);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
