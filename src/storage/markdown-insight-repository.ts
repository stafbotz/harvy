import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isRiskLevel, type RiskLevel } from "../core/safety-policy.js";
import {
  emptyInsight,
  type InsightRepository,
  type SafetyNote,
  type UserInsight,
} from "../domain/insight.js";
import { safeFolderName } from "./markdown-memory-repository.js";

/**
 * Catatan keselamatan dan pemahaman, satu berkas per pengguna.
 *
 * Berada di folder yang sama dengan memorinya supaya "hapus semua data
 * pengguna" berarti satu tempat, bukan perburuan lintas berkas. Namanya
 * sengaja jelas: siapa pun yang membuka direktori data harus langsung tahu
 * berkas ini ada dan apa isinya. Yang tidak melihatnya hanya penggunanya,
 * sesuai Pasal 4 nomor 6 — dan itu keputusan yang tercatat, bukan kebetulan.
 */
const FILE = "pemahaman-dan-keselamatan.md";

export class MarkdownInsightRepository implements InsightRepository {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly root: string) {}

  async load(ownerId: string): Promise<UserInsight | null> {
    try {
      const raw = await readFile(this.pathOf(ownerId), "utf8");
      return parseInsight(raw, ownerId);
    } catch {
      return null;
    }
  }

  async save(insight: UserInsight): Promise<void> {
    await this.exclusive(async () => {
      const folder = join(this.root, safeFolderName(insight.ownerId));
      await mkdir(folder, { recursive: true });

      const path = join(folder, FILE);
      const temporary = `${path}.tmp`;
      await writeFile(temporary, renderInsight(insight), "utf8");
      await rename(temporary, path);
    });
  }

  async remove(ownerId: string): Promise<boolean> {
    return this.exclusive(async () => {
      try {
        await unlink(this.pathOf(ownerId));
        return true;
      } catch {
        return false;
      }
    });
  }

  private pathOf(ownerId: string): string {
    return join(this.root, safeFolderName(ownerId), FILE);
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

const FIELD = /^([A-Za-z ]+):\s*(.*)$/u;
const NOTE_LINE =
  /^- \[(\S+)\]\s*\((\S+)\)\s*(.*?)\s*\|\s*(.*)$/u;

export function parseInsight(raw: string, ownerId: string): UserInsight {
  const insight = emptyInsight(ownerId);

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();

    const note = NOTE_LINE.exec(trimmed);
    if (note) {
      const [, at = "", level = "", ringkasan = "", tindakan = ""] = note;
      insight.catatan.push({
        at,
        level: isRiskLevel(level) ? level : ("dukungan" as RiskLevel),
        ringkasan,
        tindakan,
      });
      continue;
    }

    const field = FIELD.exec(trimmed);
    if (!field) continue;

    const [, key = "", value = ""] = field;
    const clean = value === "-" ? null : value;

    switch (key.toLowerCase()) {
      case "gaya":
        insight.gaya = clean;
        break;
      case "tahap":
        insight.tahap = clean;
        break;
      case "kerentanan":
        insight.kerentanan = clean;
        break;
      case "terakhir menyarankan bantuan":
        insight.terakhirMenyarankanBantuan = clean;
        break;
      case "diperbarui":
        insight.updatedAt = clean;
        break;
      default:
        break;
    }
  }

  return insight;
}

export function renderInsight(insight: UserInsight): string {
  const lines = [
    "# Pemahaman dan keselamatan",
    "",
    "> Catatan ini tidak ditampilkan kepada penggunanya. Konstitusi v0.3,",
    "> Pasal 4 nomor 6. Isinya hanya boleh dipakai untuk melindunginya dan",
    "> menyesuaikan cara menemani — tidak untuk personalisasi yang menaikkan",
    "> keterlibatan, analitik, atau pemasaran.",
    "",
    `Gaya: ${insight.gaya ?? "-"}`,
    `Tahap: ${insight.tahap ?? "-"}`,
    `Kerentanan: ${insight.kerentanan ?? "-"}`,
    `Terakhir menyarankan bantuan: ${insight.terakhirMenyarankanBantuan ?? "-"}`,
    `Diperbarui: ${insight.updatedAt ?? "-"}`,
    "",
    "## Riwayat giliran berisiko",
    "",
  ];

  if (insight.catatan.length === 0) {
    lines.push("_Belum ada._", "");
    return lines.join("\n");
  }

  for (const note of insight.catatan) {
    lines.push(noteLine(note));
  }
  lines.push("");

  return lines.join("\n");
}

function noteLine(note: SafetyNote): string {
  return `- [${note.at}] (${note.level}) ${note.ringkasan} | ${note.tindakan}`;
}
