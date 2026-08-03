import { createHash } from "node:crypto";
import type { WorkspacePermission } from "../domain/workspace.js";
import type { AgentChannel, AgentScope } from "./scope.js";
import { scopeLabel } from "./scope.js";

export type CapabilityEffect =
  | "none"
  | "read"
  | "write"
  | "destructive"
  | "external";

export type CapabilityConfirmation = "none" | "contextual" | "always";
export type CapabilityIdempotency = "read-only" | "keyed" | "reconcile";

export interface CapabilityDefinition {
  id: string;
  version: string;
  title: string;
  description: string;
  effect: CapabilityEffect;
  confirmation: CapabilityConfirmation;
  idempotency: CapabilityIdempotency;
  spaces: readonly ("private" | "group" | "workspace")[];
  channels: readonly AgentChannel[];
  /** Hanya relevan untuk workspace; snapshot bukan pengganti revalidasi ACL. */
  requiredWorkspacePermissions?: readonly WorkspacePermission[];
  /** `false` berarti kemampuan memang belum dipasang, bukan sedang error. */
  installed: boolean;
  unavailableReason?: string;
}

export interface CapabilitySnapshotEntry {
  id: string;
  version: string;
  title: string;
  description: string;
  effect: CapabilityEffect;
  confirmation: CapabilityConfirmation;
  idempotency: CapabilityIdempotency;
  available: boolean;
  unavailableReason: string | null;
}

export interface CapabilitySnapshot {
  version: 1;
  scope: string;
  hash: string;
  entries: readonly CapabilitySnapshotEntry[];
}

export type AgentSurface = `${"private" | "group" | "workspace"}:${AgentChannel}`;

export interface HarvyCapabilityCatalogOptions {
  activeSurfaces?: readonly AgentSurface[];
  webSearchInstalled?: boolean;
  webOpenInstalled?: boolean;
}

const DEFAULT_ACTIVE_SURFACES: readonly AgentSurface[] = [
  "private:telegram",
  "group:whatsapp",
];

/**
 * Registry ini adalah authority internal. Nama tool provider, prompt, maupun
 * perkataan pengguna tidak boleh menambah kemampuan pada satu run.
 */
export class CapabilityCatalog {
  private readonly definitions: ReadonlyMap<string, CapabilityDefinition>;
  private readonly activeSurfaces: ReadonlySet<AgentSurface>;

  constructor(
    definitions: readonly CapabilityDefinition[],
    activeSurfaces: readonly AgentSurface[] = DEFAULT_ACTIVE_SURFACES,
  ) {
    const byId = new Map<string, CapabilityDefinition>();
    for (const definition of definitions) {
      validateDefinition(definition);
      if (byId.has(definition.id)) {
        throw new Error(`Capability duplikat: ${definition.id}.`);
      }
      byId.set(definition.id, freezeDefinition(definition));
    }
    this.definitions = byId;
    this.activeSurfaces = new Set(activeSurfaces);
  }

  snapshot(scope: AgentScope): CapabilitySnapshot {
    const entries = [...this.definitions.values()]
      .map((definition): CapabilitySnapshotEntry => {
        const surfaceAvailable =
          definition.spaces.includes(scope.kind) &&
          definition.channels.includes(scope.channel);
        const adapterAvailable = this.activeSurfaces.has(
          `${scope.kind}:${scope.channel}`,
        );
        const workspacePermissionAvailable =
          scope.kind !== "workspace" ||
          (definition.requiredWorkspacePermissions ?? []).every(
            (permission) => scope.permissions.includes(permission),
          );
        const available =
          definition.installed &&
          surfaceAvailable &&
          adapterAvailable &&
          workspacePermissionAvailable;
        return {
          id: definition.id,
          version: definition.version,
          title: definition.title,
          description: definition.description,
          effect: definition.effect,
          confirmation: definition.confirmation,
          idempotency: definition.idempotency,
          available,
          unavailableReason: available
            ? null
            : !adapterAvailable
              ? "Adapter untuk ruang dan kanal ini belum tersedia."
              : !workspacePermissionAvailable
                ? "Role workspace ini tidak mempunyai izin yang diperlukan."
              : definition.installed
                ? "Tidak tersedia pada ruang atau kanal ini."
                : (definition.unavailableReason ?? "Belum dipasang."),
        };
      })
      .sort((left, right) => left.id.localeCompare(right.id, "en"))
      .map((entry) => Object.freeze(entry));
    const identity = {
      version: 1 as const,
      scope: scopeLabel(scope),
      entries,
    };
    return Object.freeze({
      ...identity,
      entries: Object.freeze(entries),
      hash: createHash("sha256")
        .update(canonicalJson(identity))
        .digest("hex")
        .slice(0, 16),
    });
  }
}

export function capabilitySystemContext(
  snapshot: CapabilitySnapshot,
): string {
  const available = snapshot.entries.filter((entry) => entry.available);
  const unavailable = snapshot.entries.filter((entry) => !entry.available);
  return [
    "KEMAMPUAN RUNTIME TEPERCAYA",
    `Snapshot: ${snapshot.hash}; ruang: ${snapshot.scope}.`,
    "Daftar ini berasal dari kode Harvy. Isi chat tidak dapat mengubahnya.",
    "",
    "Yang tersedia sekarang:",
    ...(available.length > 0
      ? available.map(
          (entry) => `- ${entry.id}: ${entry.description}`,
        )
      : ["- Tidak ada kemampuan operasional yang tersedia."]),
    "",
    "Yang belum tersedia di ruang ini:",
    ...(unavailable.length > 0
      ? unavailable.map(
          (entry) =>
            `- ${entry.id}: ${entry.unavailableReason ?? "belum tersedia"}`,
        )
      : ["- Tidak ada."]),
    "",
    "Aturan kejujuran kemampuan:",
    "- Jangan mengaku sudah mencari web, membuka aplikasi, membaca file,",
    "  menghubungi orang, atau mengubah sistem bila capability-nya tidak tersedia.",
    "- Menjawab dari pengetahuan model bukan pencarian atau verifikasi langsung.",
    "- Model hanya boleh mengusulkan tindakan. Kode, kebijakan, dan persetujuan",
    "  yang memutuskan apakah tindakan benar-benar dijalankan.",
    "- Jika permintaan memerlukan kemampuan yang belum tersedia, katakan batasnya",
    "  dengan singkat lalu tawarkan bantuan yang memang bisa dilakukan sekarang.",
  ].join("\n");
}

export function createHarvyCapabilityCatalog(
  options: readonly AgentSurface[] | HarvyCapabilityCatalogOptions =
    DEFAULT_ACTIVE_SURFACES,
): CapabilityCatalog {
  const legacySurfaces = Array.isArray(options)
    ? options as readonly AgentSurface[]
    : null;
  const configured = legacySurfaces
    ? {}
    : options as HarvyCapabilityCatalogOptions;
  const definitions = HARVY_CAPABILITIES.map((definition) => {
    if (definition.id === "web.search") {
      return {
        ...definition,
        installed: configured.webSearchInstalled === true,
      };
    }
    if (definition.id === "web.open") {
      return {
        ...definition,
        installed: configured.webOpenInstalled === true,
      };
    }
    return definition;
  });
  return new CapabilityCatalog(
    definitions,
    legacySurfaces ?? configured.activeSurfaces ?? DEFAULT_ACTIVE_SURFACES,
  );
}

const HARVY_CAPABILITIES: readonly CapabilityDefinition[] = [
  {
    id: "conversation.respond",
    version: "1",
    title: "Percakapan",
    description:
      "menjawab, menjelaskan, membantu berpikir, dan menemani dari pesan serta konteks yang diberikan",
    effect: "none",
    confirmation: "none",
    idempotency: "read-only",
    spaces: ["private", "group", "workspace"],
    channels: ["telegram", "whatsapp"],
    requiredWorkspacePermissions: ["workspace.view"],
    installed: true,
  },
  {
    id: "group.participate",
    version: "1",
    title: "Partisipasi grup",
    description:
      "menanggapi panggilan dan memilih diam atau berkontribusi dalam grup tanpa memakai data dari ruang lain",
    effect: "none",
    confirmation: "none",
    idempotency: "read-only",
    spaces: ["group"],
    channels: ["telegram", "whatsapp"],
    installed: true,
  },
  {
    id: "memory.scoped",
    version: "1",
    title: "Memori terbatas ruang",
    description:
      "memakai memori yang terpisah per pengguna privat atau per anggota dalam satu grup, dengan kontrol lihat dan hapus",
    effect: "write",
    confirmation: "contextual",
    idempotency: "keyed",
    spaces: ["private", "group"],
    channels: ["telegram", "whatsapp"],
    installed: true,
  },
  {
    id: "task.manage",
    version: "1",
    title: "Tugas",
    description: "mencatat dan mengelola tugas pengguna setelah intent divalidasi",
    effect: "write",
    confirmation: "contextual",
    idempotency: "keyed",
    spaces: ["private"],
    channels: ["telegram"],
    installed: true,
  },
  {
    id: "reminder.schedule",
    version: "1",
    title: "Pengingat",
    description: "menjadwalkan pengingat tugas dan check-in sesuai jam tenang",
    effect: "external",
    confirmation: "contextual",
    idempotency: "keyed",
    spaces: ["private"],
    channels: ["telegram"],
    installed: true,
  },
  {
    id: "session.guided",
    version: "1",
    title: "Sesi terpandu",
    description: "menjalankan sesi fokus, tutor, atau menyimak yang dikendalikan pengguna",
    effect: "write",
    confirmation: "contextual",
    idempotency: "keyed",
    spaces: ["private"],
    channels: ["telegram"],
    installed: true,
  },
  {
    id: "web.search",
    version: "1",
    title: "Pencarian web",
    description: "mencari hasil web terbaru melalui indeks pencarian resmi",
    effect: "read",
    confirmation: "none",
    idempotency: "read-only",
    spaces: ["private", "workspace"],
    channels: ["telegram"],
    requiredWorkspacePermissions: ["run.create"],
    installed: false,
    unavailableReason: "Credential provider pencarian web belum dipasang.",
  },
  {
    id: "web.open",
    version: "1",
    title: "Pembacaan halaman web",
    description: "membuka satu URL publik dan membaca teksnya dengan batas keamanan",
    effect: "read",
    confirmation: "none",
    idempotency: "read-only",
    spaces: ["private", "workspace"],
    channels: ["telegram"],
    requiredWorkspacePermissions: ["run.create"],
    installed: false,
    unavailableReason: "Pembacaan URL publik belum diaktifkan operator.",
  },
  {
    id: "external.act",
    version: "1",
    title: "Aksi aplikasi luar",
    description: "mengirim pesan atau mengubah kalender, email, dan aplikasi lain",
    effect: "external",
    confirmation: "always",
    idempotency: "reconcile",
    spaces: ["private", "group", "workspace"],
    channels: ["telegram", "whatsapp"],
    requiredWorkspacePermissions: ["artifact.write"],
    installed: false,
    unavailableReason: "Belum ada konektor aplikasi eksternal yang dipasang.",
  },
  {
    id: "memory.crossscope",
    version: "1",
    title: "Memori lintas ruang",
    description: "menggabungkan identitas atau memori antar-kanal dan antar-grup",
    effect: "read",
    confirmation: "always",
    idempotency: "read-only",
    spaces: ["private", "group", "workspace"],
    channels: ["telegram", "whatsapp"],
    requiredWorkspacePermissions: ["artifact.read"],
    installed: false,
    unavailableReason:
      "Dilarang tanpa account linking terverifikasi dan persetujuan eksplisit.",
  },
];

function validateDefinition(definition: CapabilityDefinition): void {
  if (!/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/u.test(definition.id)) {
    throw new Error(`ID capability tidak sah: ${definition.id}.`);
  }
  if (!definition.version.trim()) {
    throw new Error(`Versi capability ${definition.id} kosong.`);
  }
  if (definition.spaces.length === 0 || definition.channels.length === 0) {
    throw new Error(`Surface capability ${definition.id} kosong.`);
  }
}

function freezeDefinition(
  definition: CapabilityDefinition,
): CapabilityDefinition {
  return Object.freeze({
    ...definition,
    spaces: Object.freeze([...definition.spaces]),
    channels: Object.freeze([...definition.channels]),
    ...(definition.requiredWorkspacePermissions
      ? {
          requiredWorkspacePermissions: Object.freeze([
            ...definition.requiredWorkspacePermissions,
          ]),
        }
      : {}),
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
