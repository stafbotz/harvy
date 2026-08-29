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
  /** Tool baca state Harvy yang benar-benar mempunyai executor agent. */
  internalToolsInstalled?: boolean;
  /** Pencarian riwayat sendiri dan catatan durable milik pengguna. */
  recallToolsInstalled?: boolean;
  /** Terminal virtual sementara; tidak pernah berarti shell host. */
  virtualTerminalInstalled?: boolean;
  /** Fan-out read-only berbatas ke worker model cheap/efficient. */
  parallelDelegationInstalled?: boolean;
  /** Direct one-hop specialist memakai WorkBrief provider-neutral. */
  specialistDelegationInstalled?: boolean;
  /** Project-bound repository readers and structured patch executor. */
  codingWorkspaceInstalled?: boolean;
  /** Separately isolated SandboxRunner; never inferred from VirtualTerminal. */
  sandboxRunnerInstalled?: boolean;
  /** Controlled dependency artifact broker, separate from sandbox egress. */
  dependencyFetchInstalled?: boolean;
  /** Local git service in the coding trust domain. */
  localGitInstalled?: boolean;
  /** Credential-owning GitHub App broker with exact-effect executors. */
  githubBrokerInstalled?: boolean;
}

const DEFAULT_ACTIVE_SURFACES: readonly AgentSurface[] = [
  "private:telegram",
  "private:whatsapp",
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

  /**
   * ID capability yang benar-benar terpasang, lepas dari scope.
   *
   * Snapshot menambahkan pagar ruang, kanal, dan permission; daftar ini hanya
   * menjawab "apakah kemampuannya dipasang deployment ini". Itu yang diperlukan
   * pemeriksaan wiring, karena schema native tidak boleh bergantung pada siapa
   * yang kebetulan mengirim pesan.
   */
  installedIds(): readonly string[] {
    return [...this.definitions.values()]
      .filter((definition) => definition.installed)
      .map((definition) => definition.id);
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

/**
 * Bentuk minimum executor yang diperlukan pemeriksaan ini.
 *
 * Sengaja struktural, bukan `AgentCapabilityExecutor`, supaya modul katalog
 * tidak perlu mengimpor harness yang justru mengimpornya.
 */
export interface CapabilitySchemaCandidate {
  capabilityId: string;
  nativeTool?: unknown;
}

/**
 * Menolak capability yang terpasang tetapi executornya tanpa schema native.
 *
 * Kombinasi itu mematikan **seluruh** run agent di proses tersebut pada langkah
 * pertama: `agentNativeTools` melempar begitu satu capability callable tidak
 * punya schema, lemparannya terjadi di dalam planner, dan `abortReason`
 * menamainya `invalid_planner_output`. Pengguna diberi tahu Harvy gagal
 * menyusun jawaban, operator mencari cacat parser yang tidak ada, dan
 * penyebabnya tidak berlalu sendiri.
 *
 * Pemeriksaannya memakai irisan terpasang dan executor, bukan daftar executor
 * saja. Executor untuk capability yang tidak dipasang tidak pernah ditawarkan
 * ke planner, jadi menuntut schema darinya akan menolak fixture yang sah:
 * puluhan tes memakai executor tanpa schema bersama planner stub, dan di sana
 * schema memang tidak diperlukan.
 *
 * Dipanggil dari composition root, bukan dari jalur giliran. Kesalahan wiring
 * harus terlihat saat proses dinyalakan, bukan pada pesan pertama pengguna.
 */
export function assertCallableCapabilitySchemas(
  catalog: CapabilityCatalog,
  executors: readonly CapabilitySchemaCandidate[],
): void {
  const installed = new Set(catalog.installedIds());
  const missing = executors
    .filter((executor) =>
      installed.has(executor.capabilityId) && !executor.nativeTool
    )
    .map((executor) => executor.capabilityId)
    .sort();
  if (missing.length === 0) return;
  throw new Error(
    `Capability terpasang tanpa schema native: ${missing.join(", ")}. ` +
      "Tanpa schema, seluruh run agent di proses ini berhenti pada langkah " +
      "pertama dan dilaporkan sebagai keluaran planner yang tidak sah.",
  );
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
    if (INTERNAL_TOOL_IDS.has(definition.id)) {
      return {
        ...definition,
        installed: configured.internalToolsInstalled === true,
      };
    }
    if (RECALL_TOOL_IDS.has(definition.id)) {
      return {
        ...definition,
        installed: configured.recallToolsInstalled === true,
      };
    }
    if (definition.id === "terminal.run") {
      return {
        ...definition,
        installed: configured.virtualTerminalInstalled === true,
      };
    }
    if (definition.id === "agent.delegate.parallel") {
      return {
        ...definition,
        installed: configured.parallelDelegationInstalled === true,
      };
    }
    if (definition.id === "agent.delegate.specialist") {
      return {
        ...definition,
        installed: configured.specialistDelegationInstalled === true,
      };
    }
    if (CODING_WORKSPACE_IDS.has(definition.id)) {
      return {
        ...definition,
        installed: configured.codingWorkspaceInstalled === true,
      };
    }
    if (SANDBOX_IDS.has(definition.id)) {
      return {
        ...definition,
        installed: configured.sandboxRunnerInstalled === true,
      };
    }
    if (definition.id === "dependency.fetch") {
      return {
        ...definition,
        installed: configured.dependencyFetchInstalled === true,
      };
    }
    if (LOCAL_GIT_IDS.has(definition.id)) {
      return {
        ...definition,
        installed: configured.localGitInstalled === true,
      };
    }
    if (GITHUB_BROKER_IDS.has(definition.id)) {
      return {
        ...definition,
        installed: configured.githubBrokerInstalled === true,
      };
    }
    return definition;
  });
  return new CapabilityCatalog(
    definitions,
    legacySurfaces ?? configured.activeSurfaces ?? DEFAULT_ACTIVE_SURFACES,
  );
}

const INTERNAL_TOOL_IDS = new Set([
  "task.list_active",
  "task.get",
  "session.status",
  "settings.time.get",
  "calendar.agenda",
]);

const RECALL_TOOL_IDS = new Set([
  "history.search",
  "memory.list",
  "memory.remember",
]);

const CODING_WORKSPACE_IDS = new Set([
  "workspace.tree",
  "workspace.read",
  "workspace.search",
  "workspace.symbols",
  "workspace.references",
  "workspace.diff",
  "workspace.apply_patch",
]);

const SANDBOX_IDS = new Set(["sandbox.exec", "sandbox.test"]);
const LOCAL_GIT_IDS = new Set([
  "git.status",
  "git.diff",
  "git.log",
  "git.commit",
]);
const GITHUB_BROKER_IDS = new Set([
  "github.branch.create",
  "github.push_branch",
  "github.workflow.write",
  "github.pr.create",
]);

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
    channels: ["telegram", "whatsapp"],
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
    channels: ["telegram", "whatsapp"],
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
    channels: ["telegram", "whatsapp"],
    installed: true,
  },
  {
    id: "task.list_active",
    version: "1",
    title: "Daftar tugas aktif",
    description:
      "membaca paling banyak 20 tugas aktif milik pengguna pada ruang privat ini",
    effect: "read",
    confirmation: "none",
    idempotency: "read-only",
    spaces: ["private"],
    channels: ["telegram", "whatsapp"],
    installed: false,
    unavailableReason: "Executor baca tugas internal belum dipasang.",
  },
  {
    id: "task.get",
    version: "1",
    title: "Detail tugas",
    description:
      "membaca satu tugas berdasarkan ID dari state Harvy milik pengguna ini",
    effect: "read",
    confirmation: "none",
    idempotency: "read-only",
    spaces: ["private"],
    channels: ["telegram", "whatsapp"],
    installed: false,
    unavailableReason: "Executor baca tugas internal belum dipasang.",
  },
  {
    id: "session.status",
    version: "1",
    title: "Status sesi",
    description:
      "membaca status sesi fokus, tutor, atau rencana yang masih aktif",
    effect: "read",
    confirmation: "none",
    idempotency: "read-only",
    spaces: ["private"],
    channels: ["telegram", "whatsapp"],
    installed: false,
    unavailableReason: "Executor status sesi internal belum dipasang.",
  },
  {
    id: "settings.time.get",
    version: "1",
    title: "Jam dan zona waktu",
    description:
      "membaca jam deterministik, zona waktu, dan jam tenang pengguna saat ini",
    effect: "read",
    confirmation: "none",
    idempotency: "read-only",
    spaces: ["private"],
    channels: ["telegram", "whatsapp"],
    installed: false,
    unavailableReason: "Executor waktu internal belum dipasang.",
  },
  {
    id: "calendar.agenda",
    version: "1",
    title: "Agenda internal Harvy",
    description:
      "membaca tenggat, pengingat tugas, dan check-in Harvy untuk 1–31 hari atau satu tanggal lokal; bukan kalender Google atau Outlook",
    effect: "read",
    confirmation: "none",
    idempotency: "read-only",
    spaces: ["private"],
    channels: ["telegram", "whatsapp"],
    installed: false,
    unavailableReason: "Executor agenda internal belum dipasang.",
  },
  {
    id: "history.search",
    version: "1",
    title: "Cari percakapan lama",
    description:
      "mencari percakapan lama pengguna sendiri di ruang privat ini berdasarkan kata kunci; bukan pencarian web atau aplikasi luar",
    effect: "read",
    confirmation: "none",
    idempotency: "read-only",
    spaces: ["private"],
    channels: ["telegram", "whatsapp"],
    installed: false,
    unavailableReason: "Executor pencarian riwayat belum dipasang.",
  },
  {
    id: "memory.list",
    version: "1",
    title: "Baca catatan tersimpan",
    description:
      "membaca catatan durable yang Harvy simpan tentang pengguna pada ruang privat ini",
    effect: "read",
    confirmation: "none",
    idempotency: "read-only",
    spaces: ["private"],
    channels: ["telegram", "whatsapp"],
    installed: false,
    unavailableReason: "Executor baca catatan belum dipasang.",
  },
  {
    id: "memory.remember",
    version: "1",
    title: "Simpan catatan",
    description:
      "menyimpan satu catatan durable tentang pengguna; jenis sensitif dan credential tidak dapat disimpan lewat jalur ini",
    effect: "write",
    confirmation: "contextual",
    idempotency: "keyed",
    spaces: ["private"],
    channels: ["telegram", "whatsapp"],
    installed: false,
    unavailableReason: "Executor tulis catatan belum dipasang.",
  },
  {
    id: "terminal.run",
    version: "1",
    title: "Terminal virtual sementara",
    description:
      "menjalankan perintah terstruktur aman pada workspace virtual kosong tanpa shell host, network, environment, atau berkas Harvy",
    effect: "none",
    confirmation: "none",
    idempotency: "read-only",
    spaces: ["private"],
    channels: ["telegram", "whatsapp"],
    installed: false,
    unavailableReason: "Terminal virtual terisolasi belum dipasang.",
  },
  {
    id: "agent.delegate.parallel",
    version: "1",
    title: "Delegasi paralel berbatas",
    description:
      "mendelegasikan paling banyak tiga subpekerjaan independen read-only ke worker cheap atau efficient dalam scope yang sama",
    effect: "none",
    confirmation: "none",
    idempotency: "read-only",
    spaces: ["private"],
    channels: ["telegram", "whatsapp"],
    installed: false,
    unavailableReason: "Koordinator sub-agent paralel belum dipasang.",
  },
  {
    id: "agent.delegate.specialist",
    version: "1",
    title: "Specialist satu-hop",
    description:
      "meminta satu strong worker, heavy executor, verifier, atau challenger secara langsung melalui WorkBrief terstruktur tanpa reasoning privat",
    effect: "none",
    confirmation: "none",
    idempotency: "read-only",
    spaces: ["private"],
    channels: ["telegram", "whatsapp"],
    installed: false,
    unavailableReason: "Worker specialist dan binding role belum dipasang.",
  },
  {
    id: "workspace.tree",
    version: "1",
    title: "Struktur project",
    description: "membaca struktur project terpilih secara iteratif dan berbatas",
    effect: "read",
    confirmation: "none",
    idempotency: "read-only",
    spaces: ["workspace"],
    channels: ["telegram", "whatsapp"],
    requiredWorkspacePermissions: ["code.read"],
    installed: false,
    unavailableReason: "Executor ProjectWorkspace belum dipasang pada surface ini.",
  },
  {
    id: "workspace.read",
    version: "1",
    title: "Baca file project",
    description: "membaca rentang file teks dari snapshot project yang terikat run",
    effect: "read",
    confirmation: "none",
    idempotency: "read-only",
    spaces: ["workspace"],
    channels: ["telegram", "whatsapp"],
    requiredWorkspacePermissions: ["code.read"],
    installed: false,
    unavailableReason: "Executor ProjectWorkspace belum dipasang pada surface ini.",
  },
  {
    id: "workspace.search",
    version: "1",
    title: "Cari dalam project",
    description: "mencari teks berbatas tanpa memasukkan seluruh repository ke konteks",
    effect: "read",
    confirmation: "none",
    idempotency: "read-only",
    spaces: ["workspace"],
    channels: ["telegram", "whatsapp"],
    requiredWorkspacePermissions: ["code.read"],
    installed: false,
    unavailableReason: "Executor ProjectWorkspace belum dipasang pada surface ini.",
  },
  {
    id: "workspace.symbols",
    version: "1",
    title: "Simbol project",
    description: "memetakan deklarasi simbol dari snapshot project secara baca-saja",
    effect: "read",
    confirmation: "none",
    idempotency: "read-only",
    spaces: ["workspace"],
    channels: ["telegram", "whatsapp"],
    requiredWorkspacePermissions: ["code.read"],
    installed: false,
    unavailableReason: "Executor ProjectWorkspace belum dipasang pada surface ini.",
  },
  {
    id: "workspace.references",
    version: "1",
    title: "Referensi simbol",
    description: "mencari penggunaan identifier dalam project secara baca-saja",
    effect: "read",
    confirmation: "none",
    idempotency: "read-only",
    spaces: ["workspace"],
    channels: ["telegram", "whatsapp"],
    requiredWorkspacePermissions: ["code.read"],
    installed: false,
    unavailableReason: "Executor ProjectWorkspace belum dipasang pada surface ini.",
  },
  {
    id: "workspace.diff",
    version: "1",
    title: "Diff project",
    description: "membandingkan working snapshot dengan immutable base snapshot",
    effect: "read",
    confirmation: "none",
    idempotency: "read-only",
    spaces: ["workspace"],
    channels: ["telegram", "whatsapp"],
    requiredWorkspacePermissions: ["code.read"],
    installed: false,
    unavailableReason: "Executor ProjectWorkspace belum dipasang pada surface ini.",
  },
  {
    id: "workspace.apply_patch",
    version: "1",
    title: "Patch project",
    description: "menerapkan patch teks terstruktur dengan hash precondition melalui single writer",
    effect: "write",
    confirmation: "contextual",
    idempotency: "keyed",
    spaces: ["workspace"],
    channels: ["telegram", "whatsapp"],
    requiredWorkspacePermissions: ["code.write"],
    installed: false,
    unavailableReason: "Executor single-writer ProjectWorkspace belum dipasang.",
  },
  {
    id: "sandbox.exec",
    version: "1",
    title: "Eksekusi coding terisolasi",
    description: "menjalankan argv di SandboxRunner disposable dengan network off dan quota",
    effect: "write",
    confirmation: "contextual",
    idempotency: "keyed",
    spaces: ["workspace"],
    channels: ["telegram", "whatsapp"],
    requiredWorkspacePermissions: ["sandbox.execute"],
    installed: false,
    unavailableReason: "Backend SandboxRunner terisolasi belum terverifikasi/terpasang.",
  },
  {
    id: "sandbox.test",
    version: "1",
    title: "Test project terisolasi",
    description: "menjalankan validator test/lint/typecheck/build di sandbox terikat snapshot",
    effect: "read",
    confirmation: "none",
    idempotency: "keyed",
    spaces: ["workspace"],
    channels: ["telegram", "whatsapp"],
    requiredWorkspacePermissions: ["sandbox.execute"],
    installed: false,
    unavailableReason: "Backend SandboxRunner terisolasi belum terverifikasi/terpasang.",
  },
  {
    id: "dependency.fetch",
    version: "1",
    title: "Ambil dependency terkontrol",
    description: "mengambil artifact dependency dari lockfile melalui broker egress terpisah",
    effect: "external",
    confirmation: "contextual",
    idempotency: "keyed",
    spaces: ["workspace"],
    channels: ["telegram", "whatsapp"],
    requiredWorkspacePermissions: ["sandbox.network"],
    installed: false,
    unavailableReason: "Broker dependency terkontrol belum dipasang.",
  },
  {
    id: "git.status",
    version: "1",
    title: "Status git lokal",
    description: "membaca status git lokal yang terikat project tanpa remote credential",
    effect: "read",
    confirmation: "none",
    idempotency: "read-only",
    spaces: ["workspace"],
    channels: ["telegram", "whatsapp"],
    requiredWorkspacePermissions: ["code.read"],
    installed: false,
    unavailableReason: "Service git lokal project belum dipasang.",
  },
  {
    id: "git.diff",
    version: "1",
    title: "Diff git lokal",
    description: "membaca diff git lokal tanpa menghubungi remote",
    effect: "read",
    confirmation: "none",
    idempotency: "read-only",
    spaces: ["workspace"],
    channels: ["telegram", "whatsapp"],
    requiredWorkspacePermissions: ["code.read"],
    installed: false,
    unavailableReason: "Service git lokal project belum dipasang.",
  },
  {
    id: "git.log",
    version: "1",
    title: "Log git lokal",
    description: "membaca histori git lokal project secara berbatas",
    effect: "read",
    confirmation: "none",
    idempotency: "read-only",
    spaces: ["workspace"],
    channels: ["telegram", "whatsapp"],
    requiredWorkspacePermissions: ["code.read"],
    installed: false,
    unavailableReason: "Service git lokal project belum dipasang.",
  },
  {
    id: "git.commit",
    version: "1",
    title: "Commit git lokal",
    description: "membuat commit lokal dengan identitas bot transparan tanpa melakukan push",
    effect: "write",
    confirmation: "always",
    idempotency: "reconcile",
    spaces: ["workspace"],
    channels: ["telegram", "whatsapp"],
    requiredWorkspacePermissions: ["git.commit"],
    installed: false,
    unavailableReason: "Service git lokal project belum dipasang.",
  },
  {
    id: "github.branch.create",
    version: "1",
    title: "Buat branch GitHub",
    description: "membuat branch harvy/* melalui GitHub App untuk exact base commit",
    effect: "external",
    confirmation: "always",
    idempotency: "reconcile",
    spaces: ["workspace"],
    channels: ["telegram", "whatsapp"],
    requiredWorkspacePermissions: ["github.push"],
    installed: false,
    unavailableReason: "GitHub App Broker belum dipasang.",
  },
  {
    id: "github.push_branch",
    version: "1",
    title: "Push exact commit",
    description: "mendorong exact commit ke branch harvy/* melalui broker tanpa credential sandbox",
    effect: "external",
    confirmation: "always",
    idempotency: "reconcile",
    spaces: ["workspace"],
    channels: ["telegram", "whatsapp"],
    requiredWorkspacePermissions: ["github.push"],
    installed: false,
    unavailableReason: "GitHub App Broker belum dipasang.",
  },
  {
    id: "github.workflow.write",
    version: "1",
    title: "Push perubahan workflow GitHub",
    description:
      "mendorong exact commit yang mengubah .github/workflows melalui approval terpisah",
    effect: "external",
    confirmation: "always",
    idempotency: "reconcile",
    spaces: ["workspace"],
    channels: ["telegram", "whatsapp"],
    requiredWorkspacePermissions: ["github.push", "github.workflow.write"],
    installed: false,
    unavailableReason: "GitHub App Broker belum dipasang.",
  },
  {
    id: "github.pr.create",
    version: "1",
    title: "Buat draft pull request",
    description: "membuka draft PR untuk branch dan commit yang sudah disetujui persis",
    effect: "external",
    confirmation: "always",
    idempotency: "reconcile",
    spaces: ["workspace"],
    channels: ["telegram", "whatsapp"],
    requiredWorkspacePermissions: ["github.pr.create"],
    installed: false,
    unavailableReason: "GitHub App Broker belum dipasang.",
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
  if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/u.test(definition.id)) {
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
