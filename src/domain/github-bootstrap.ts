import { createHash } from "node:crypto";
import type { GitHubRepositoryBootstrapEffect } from "./github.js";

const CAPABILITY = "github.repository.bootstrap" as const;
const PATH = "README.md" as const;
const COMMIT_MESSAGE = "Initialize repository for Harvy" as const;

export interface NewGitHubRepositoryBootstrapEffect {
  attempt: number;
  ownerWorkspaceKey: string;
  installationConnectionId: string;
  selectionId: string;
  installationId: string;
  repositoryId: string;
  repositoryFullName: string;
  visibility: "private";
  defaultBranch: string;
}

export function createGitHubRepositoryBootstrapEffect(
  input: NewGitHubRepositoryBootstrapEffect,
): GitHubRepositoryBootstrapEffect {
  const base = {
    attempt: positive(input.attempt, "bootstrap attempt"),
    capability: CAPABILITY,
    ownerWorkspaceKey: opaque(input.ownerWorkspaceKey, "ownerWorkspaceKey", 512),
    installationConnectionId: opaque(
      input.installationConnectionId,
      "installationConnectionId",
      512,
    ),
    selectionId: opaque(input.selectionId, "selectionId", 512),
    installationId: opaque(input.installationId, "installationId", 128),
    repositoryId: opaque(input.repositoryId, "repositoryId", 128),
    repositoryFullName: repositoryName(input.repositoryFullName),
    visibility: input.visibility,
    defaultBranch: gitBranch(input.defaultBranch),
    expectedHead: null,
    path: PATH,
    contentSha256: "",
    commitMessage: COMMIT_MESSAGE,
  } satisfies Omit<GitHubRepositoryBootstrapEffect, "effectId">;
  if (base.visibility !== "private") {
    throw new Error("Bootstrap GitHub hanya diizinkan untuk repository privat.");
  }
  const contentSha256 = sha256(githubRepositoryBootstrapContent(base));
  const semantic = { ...base, contentSha256 };
  return Object.freeze({
    effectId: `github-bootstrap-${sha256(Buffer.from(canonicalJson(semantic), "utf8"))}`,
    ...semantic,
  });
}

export function validateGitHubRepositoryBootstrapEffect(
  input: GitHubRepositoryBootstrapEffect,
): GitHubRepositoryBootstrapEffect {
  exactKeys(input, [
    "effectId",
    "attempt",
    "capability",
    "ownerWorkspaceKey",
    "installationConnectionId",
    "selectionId",
    "installationId",
    "repositoryId",
    "repositoryFullName",
    "visibility",
    "defaultBranch",
    "expectedHead",
    "path",
    "contentSha256",
    "commitMessage",
  ]);
  const expected = createGitHubRepositoryBootstrapEffect(input);
  if (canonicalJson(expected) !== canonicalJson(input)) {
    throw new Error("Exact effect bootstrap GitHub tidak deterministik.");
  }
  return expected;
}

export function githubRepositoryBootstrapContent(
  effect: Pick<
    GitHubRepositoryBootstrapEffect,
    "selectionId" | "attempt" | "repositoryFullName"
  >,
): Buffer {
  const repository = repositoryName(effect.repositoryFullName).split("/")[1]!;
  const selectionId = opaque(effect.selectionId, "selectionId", 512);
  const attempt = positive(effect.attempt, "bootstrap attempt");
  return Buffer.from(
    `# ${repository}\n\n` +
      "Repository ini diinisialisasi oleh Harvy agar perubahan berikutnya " +
      "dapat ditinjau melalui pull request.\n\n" +
      `<!-- harvy-bootstrap:${selectionId}:${attempt} -->\n`,
    "utf8",
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function exactKeys(value: unknown, expected: readonly string[]): void {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())
  ) throw new Error("Schema exact effect bootstrap GitHub tidak sah.");
}

function opaque(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    /[\r\n\0]/u.test(value)
  ) throw new Error(`${label} bootstrap GitHub tidak sah.`);
  return value;
}

function repositoryName(value: unknown): string {
  const text = opaque(value, "repositoryFullName", 256);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(text)) {
    throw new Error("repositoryFullName bootstrap GitHub tidak sah.");
  }
  return text;
}

function gitBranch(value: unknown): string {
  const branch = opaque(value, "defaultBranch", 255);
  if (
    branch.startsWith("-") ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch.includes("@{") ||
    branch.split("/").some((segment) => segment.endsWith(".lock")) ||
    /[~^:?*[\\\p{Cc}\s]/u.test(branch)
  ) throw new Error("defaultBranch bootstrap GitHub tidak sah.");
  return branch;
}

function positive(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${label} GitHub tidak sah.`);
  }
  return Number(value);
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
