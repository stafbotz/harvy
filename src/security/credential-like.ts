/**
 * Conservative detector for strings that must never cross a durable metadata
 * or model boundary. It intentionally favors false positives: real secrets
 * belong in a credential-owning trust domain, not in Harvy coding state.
 */
export function containsSecretLikeValue(content: string): boolean {
  if (/-----BEGIN (?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----/u.test(content)) {
    return true;
  }
  if (/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u.test(content)) return true;
  if (/\bAWS_SECRET_ACCESS_KEY\s*[:=]\s*["']?[A-Za-z0-9/+=]{32,}/iu.test(content)) {
    return true;
  }
  if (/\bgh[pousr]_[A-Za-z0-9]{30,}\b/u.test(content)) return true;
  if (/\bgithub_pat_[A-Za-z0-9_]{20,}\b/u.test(content)) return true;
  if (/\bsk-[A-Za-z0-9_-]{16,}\b/u.test(content)) return true;
  if (/\bAIza[A-Za-z0-9_-]{20,}\b/u.test(content)) return true;
  if (/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u.test(content)) return true;
  if (/\bglpat-[A-Za-z0-9_-]{20,}\b/u.test(content)) return true;
  if (/\bnpm_[A-Za-z0-9]{20,}\b/u.test(content)) return true;
  if (/\bhf_[A-Za-z0-9]{20,}\b/u.test(content)) return true;
  if (/\bgsk_[A-Za-z0-9]{20,}\b/u.test(content)) return true;
  if (/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/u.test(content)) return true;
  if (/\bAuthorization:\s*Bearer\s+(?!\[REDACTED\])\S+/iu.test(content)) return true;
  if (/\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/u.test(content)) return true;
  if (/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u.test(content)) {
    return true;
  }
  if (/[?&](?:token|key|api_?key|secret|password|code)=(?!\[REDACTED\])[^&\s]+/iu.test(content)) {
    return true;
  }
  const assignment = /(?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|token|secret|password)\s*[:=]\s*["']?([^\s"'`,;}{]{12,})/gimu;
  for (const match of content.matchAll(assignment)) {
    const value = match[1]!.toLowerCase();
    if (!explicitCredentialPlaceholder(value)) return true;
  }
  return false;
}

/** Paths whose contents or even names must not be exposed to a model/tool observation. */
export function isSensitiveProjectPath(value: string): boolean {
  const segments = value.replace(/\\/gu, "/").toLowerCase().split("/");
  if (segments.some((segment) => segment === ".ssh" || segment === ".aws" || segment === ".gnupg")) {
    return true;
  }
  const name = segments.at(-1) ?? "";
  return name === ".env" ||
    name.startsWith(".env.") ||
    name === ".npmrc" ||
    name === ".pypirc" ||
    name === ".netrc" ||
    name === ".git-credentials" ||
    name === "id_rsa" ||
    name === "id_ed25519" ||
    name === "credentials.json" ||
    name === "secrets.json" ||
    name.endsWith(".p12") ||
    name.endsWith(".pfx") ||
    name.endsWith(".key");
}

function explicitCredentialPlaceholder(value: string): boolean {
  return /^(?:example|placeholder|dummy|changeme|test[_-]?only|example[_-]value|dummy[_-]value|your[_-]?(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|password))$/u
    .test(value);
}
