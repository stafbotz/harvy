import type { MemoryKnowledgeNamespace } from "../domain/memory-knowledge.js";

const MAX_NAMESPACE_PART_CHARACTERS = 512;

export function privateMemoryNamespace(
  ownerId: string,
): MemoryKnowledgeNamespace {
  return Object.freeze({
    kind: "private",
    ownerId: namespacePart(ownerId, "ownerId"),
  });
}

export function groupMemoryNamespace(
  groupId: string,
  memberId: string | null = null,
): MemoryKnowledgeNamespace {
  return Object.freeze({
    kind: "group",
    groupId: namespacePart(groupId, "groupId"),
    memberId: memberId === null ? null : namespacePart(memberId, "memberId"),
  });
}

export function projectMemoryNamespace(
  workspaceKey: string,
  projectId: string,
): MemoryKnowledgeNamespace {
  return Object.freeze({
    kind: "project",
    workspaceKey: namespacePart(workspaceKey, "workspaceKey"),
    projectId: namespacePart(projectId, "projectId"),
  });
}

export function validateMemoryNamespace(
  namespace: MemoryKnowledgeNamespace,
): MemoryKnowledgeNamespace {
  if (!namespace || typeof namespace !== "object") {
    throw new Error("Namespace memory knowledge tidak sah.");
  }
  switch (namespace.kind) {
    case "private":
      return privateMemoryNamespace(namespace.ownerId);
    case "group":
      return groupMemoryNamespace(namespace.groupId, namespace.memberId);
    case "project":
      return projectMemoryNamespace(
        namespace.workspaceKey,
        namespace.projectId,
      );
    default:
      throw new Error("Jenis namespace memory knowledge tidak sah.");
  }
}

export function memoryNamespaceKey(
  namespace: MemoryKnowledgeNamespace,
): string {
  const valid = validateMemoryNamespace(namespace);
  switch (valid.kind) {
    case "private":
      return `v1:private:${encodeURIComponent(valid.ownerId)}`;
    case "group":
      return valid.memberId === null
        ? `v1:group:${encodeURIComponent(valid.groupId)}:shared`
        : `v1:group:${encodeURIComponent(valid.groupId)}:member:${encodeURIComponent(valid.memberId)}`;
    case "project":
      return `v1:project:${encodeURIComponent(valid.workspaceKey)}:${encodeURIComponent(valid.projectId)}`;
  }
}

export function memoryNamespaceOwnerId(
  namespace: MemoryKnowledgeNamespace,
): string {
  const valid = validateMemoryNamespace(namespace);
  switch (valid.kind) {
    case "private":
      return valid.ownerId;
    case "group":
      return valid.memberId === null
        ? `group:${valid.groupId}`
        : `group:${valid.groupId}:member:${valid.memberId}`;
    case "project":
      return `workspace:${valid.workspaceKey}:project:${valid.projectId}`;
  }
}

export function sameMemoryNamespace(
  left: MemoryKnowledgeNamespace,
  right: MemoryKnowledgeNamespace,
): boolean {
  return memoryNamespaceKey(left) === memoryNamespaceKey(right);
}

function namespacePart(value: string, field: string): string {
  const clean = typeof value === "string" ? value.trim() : "";
  if (
    !clean ||
    clean.length > MAX_NAMESPACE_PART_CHARACTERS ||
    /\p{Cc}/u.test(clean)
  ) {
    throw new Error(`${field} namespace memory knowledge tidak sah.`);
  }
  return clean;
}
