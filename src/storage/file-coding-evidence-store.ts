import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type {
  CodingEvidenceBinding,
  CodingEvidenceSource,
  CodingEvidenceStore,
} from "../domain/coding-run.js";
import type { SandboxArtifactReference } from "../domain/sandbox.js";
import { containsSecretLikeValue } from "../security/credential-like.js";
import {
  writeDurableBytesAtomic,
  writeDurableFileAtomic,
} from "./durable-file.js";

const DEFAULT_MAX_EVIDENCE_BYTES = 128 * 1024 * 1024;

interface CodingEvidenceManifest {
  version: 1;
  evidenceId: string;
  binding: CodingEvidenceBinding;
  source: CodingEvidenceSource;
  artifact: SandboxArtifactReference;
}

/** Local single-process content-addressed evidence adapter. */
export class FileCodingEvidenceStore implements CodingEvidenceStore {
  private readonly root: string;

  constructor(
    root: string,
    private readonly maxEvidenceBytes = DEFAULT_MAX_EVIDENCE_BYTES,
  ) {
    this.root = resolve(root);
    if (!Number.isSafeInteger(maxEvidenceBytes) || maxEvidenceBytes < 1) {
      throw new Error("Batas byte evidence coding tidak sah.");
    }
  }

  async persist(
    bindingInput: CodingEvidenceBinding,
    sourceInput: CodingEvidenceSource,
    artifactInput: SandboxArtifactReference,
    bytesInput: Uint8Array,
  ): Promise<string> {
    const binding = validBinding(bindingInput);
    const source = validSource(sourceInput);
    const artifact = validArtifact(artifactInput, this.maxEvidenceBytes);
    if (!(bytesInput instanceof Uint8Array)) {
      throw new Error("Byte evidence coding tidak sah.");
    }
    const bytes = Buffer.from(bytesInput);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== artifact.size || digest !== artifact.sha256) {
      throw new Error("Byte evidence coding tidak cocok descriptor sandbox.");
    }
    const evidenceId = evidenceIdFor(binding, source, artifact);
    const path = this.bytePath(binding, evidenceId);
    const manifest: CodingEvidenceManifest = {
      version: 1,
      evidenceId,
      binding,
      source,
      artifact,
    };
    try {
      const existing = await readFile(path);
      if (
        existing.byteLength !== bytes.byteLength ||
        createHash("sha256").update(existing).digest("hex") !== digest
      ) throw new Error("Content-addressed evidence coding berkonflik.");
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      await writeDurableBytesAtomic(path, bytes);
    }
    try {
      const existing = await this.loadManifest(binding, evidenceId);
      if (JSON.stringify(existing) !== JSON.stringify(manifest)) {
        throw new Error("Manifest evidence coding berkonflik.");
      }
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      await writeDurableFileAtomic(
        this.manifestPath(binding, evidenceId),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
    }
    return evidenceId;
  }

  async verify(
    bindingInput: CodingEvidenceBinding,
    evidenceIdInput: string,
    sourceInput: CodingEvidenceSource,
  ): Promise<boolean> {
    const binding = validBinding(bindingInput);
    const source = validSource(sourceInput);
    const evidenceId = validEvidenceId(evidenceIdInput);
    try {
      const manifest = await this.loadManifest(binding, evidenceId);
      const bytes = await readFile(this.bytePath(binding, evidenceId));
      return manifest.evidenceId === evidenceId &&
        JSON.stringify(manifest.binding) === JSON.stringify(binding) &&
        JSON.stringify(manifest.source) === JSON.stringify(source) &&
        evidenceIdFor(binding, source, manifest.artifact) === evidenceId &&
        manifest.artifact.sha256 ===
          createHash("sha256").update(bytes).digest("hex") &&
        manifest.artifact.size === bytes.byteLength &&
        bytes.byteLength <= this.maxEvidenceBytes;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return false;
      throw error;
    }
  }

  async read(
    bindingInput: CodingEvidenceBinding,
    evidenceIdInput: string,
  ): Promise<Uint8Array> {
    const binding = validBinding(bindingInput);
    const evidenceId = validEvidenceId(evidenceIdInput);
    const manifest = await this.loadManifest(binding, evidenceId);
    const bytes = await readFile(this.bytePath(binding, evidenceId));
    if (
      bytes.byteLength > this.maxEvidenceBytes ||
      evidenceIdFor(binding, manifest.source, manifest.artifact) !== evidenceId ||
      manifest.artifact.size !== bytes.byteLength ||
      createHash("sha256").update(bytes).digest("hex") !==
        manifest.artifact.sha256
    ) throw new Error("Evidence coding hilang, terlalu besar, atau berubah.");
    return new Uint8Array(bytes);
  }

  async removeRun(bindingInput: CodingEvidenceBinding): Promise<void> {
    const binding = validBinding(bindingInput);
    await rm(this.runRoot(binding), { recursive: true, force: true });
  }

  async removeProject(
    bindingInput: Omit<CodingEvidenceBinding, "runId">,
  ): Promise<void> {
    const ownerWorkspaceKey = safeOpaque(
      bindingInput.ownerWorkspaceKey,
      "ownerWorkspaceKey",
    );
    const projectId = safeOpaque(bindingInput.projectId, "projectId");
    await rm(resolve(this.root, digestKey(ownerWorkspaceKey), digestKey(projectId)), {
      recursive: true,
      force: true,
    });
  }

  private bytePath(binding: CodingEvidenceBinding, evidenceId: string): string {
    return resolve(this.runRoot(binding), `${evidenceId}.bin`);
  }

  private manifestPath(
    binding: CodingEvidenceBinding,
    evidenceId: string,
  ): string {
    return resolve(this.runRoot(binding), `${evidenceId}.json`);
  }

  private async loadManifest(
    binding: CodingEvidenceBinding,
    evidenceId: string,
  ): Promise<CodingEvidenceManifest> {
    const value = JSON.parse(
      await readFile(this.manifestPath(binding, evidenceId), "utf8"),
    ) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Manifest evidence coding tidak sah.");
    }
    const manifest = value as CodingEvidenceManifest;
    if (
      JSON.stringify(Object.keys(manifest).sort()) !==
        JSON.stringify([
          "artifact", "binding", "evidenceId", "source", "version",
        ]) ||
      manifest.version !== 1 ||
      manifest.evidenceId !== evidenceId ||
      JSON.stringify(validBinding(manifest.binding)) !== JSON.stringify(binding)
    ) throw new Error("Manifest evidence coding tidak terikat exact run.");
    manifest.artifact = validArtifact(manifest.artifact, this.maxEvidenceBytes);
    manifest.source = validSource(manifest.source);
    if (evidenceIdFor(binding, manifest.source, manifest.artifact) !== evidenceId) {
      throw new Error("Identity manifest evidence coding tidak cocok.");
    }
    return manifest;
  }

  private runRoot(binding: CodingEvidenceBinding): string {
    return resolve(
      this.root,
      digestKey(binding.ownerWorkspaceKey),
      digestKey(binding.projectId),
      digestKey(binding.runId),
    );
  }
}

function validBinding(input: CodingEvidenceBinding): CodingEvidenceBinding {
  return {
    ownerWorkspaceKey: safeOpaque(input.ownerWorkspaceKey, "ownerWorkspaceKey"),
    projectId: safeOpaque(input.projectId, "projectId"),
    runId: safeOpaque(input.runId, "runId"),
  };
}

function validSource(input: CodingEvidenceSource): CodingEvidenceSource {
  const sandboxRequestDigest = input.sandboxRequestDigest;
  if (!/^[a-f0-9]{64}$/u.test(sandboxRequestDigest)) {
    throw new Error("Request digest evidence coding tidak sah.");
  }
  return {
    sandboxOperationId: safeOpaque(
      input.sandboxOperationId,
      "sandboxOperationId",
    ),
    sandboxRequestDigest,
    sandboxExecutionId: safeOpaque(
      input.sandboxExecutionId,
      "sandboxExecutionId",
    ),
  };
}

function validArtifact(
  input: SandboxArtifactReference,
  maxBytes: number,
): SandboxArtifactReference {
  if (
    !input ||
    JSON.stringify(Object.keys(input).sort()) !== JSON.stringify([
      "artifactId", "mediaType", "purpose", "sha256", "size",
    ]) ||
    input.size < 0 ||
    !Number.isSafeInteger(input.size) ||
    input.size > maxBytes ||
    !/^[a-f0-9]{64}$/u.test(input.sha256)
  ) throw new Error("Descriptor evidence sandbox tidak sah.");
  const artifactId = safeOpaque(input.artifactId, "artifactId");
  const mediaType = safeOpaque(input.mediaType, "mediaType");
  if (
    input.purpose !== "stdout" &&
    input.purpose !== "stderr" &&
    input.purpose !== "build-artifact"
  ) throw new Error("Purpose evidence sandbox tidak sah.");
  return {
    artifactId,
    sha256: input.sha256,
    size: input.size,
    mediaType,
    purpose: input.purpose,
  };
}

function evidenceIdFor(
  binding: CodingEvidenceBinding,
  source: CodingEvidenceSource,
  artifact: SandboxArtifactReference,
): string {
  return `evidence-${createHash("sha256")
    .update("harvy-coding-evidence-v1\0", "utf8")
    .update(JSON.stringify({ binding, source, artifact }), "utf8")
    .digest("hex")}`;
}

function validEvidenceId(input: string): string {
  if (!/^evidence-[a-f0-9]{64}$/u.test(input)) {
    throw new Error("Evidence id coding tidak sah.");
  }
  return input;
}

function safeOpaque(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 512 ||
    /\p{Cc}/u.test(value) ||
    containsSecretLikeValue(value)
  ) throw new Error(`${field} evidence coding tidak sah.`);
  return value;
}

function digestKey(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
