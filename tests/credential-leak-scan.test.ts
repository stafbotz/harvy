import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

/**
 * Pemindai credential atas berkas yang ditulis manusia dan agent.
 *
 * Pemindai serupa pernah ada sebagai bagian mesin tata-kelola agent dan ikut
 * terhapus di `6ea5a13`. Mesinnya memang layak dihapus—1.286 baris skrip, hook,
 * dan tes yang tugasnya memvalidasi berkas instruksi—tetapi perlindungannya
 * tidak. Sejak itu satu-satunya penjaga adalah `.gitignore`, dan `.gitignore`
 * hanya menjaga `.env`: ia tidak melihat token yang tersalin ke dalam dokumen,
 * laporan, atau skrip probe.
 *
 * Bentuknya kini tes, bukan hook. Tes ikut `npm test`, tidak dapat terlewat
 * karena lupa dipasang, dan tidak menambah perkakas baru untuk dirawat.
 */

const SECRET_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ["private key", /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/u],
  ["OpenAI-style key", /\bsk-[A-Za-z0-9_-]{16,}\b/u],
  ["Google API key", /\bAIza[A-Za-z0-9_-]{20,}\b/u],
  ["Authorization header", /Authorization:\s*Bearer\s+(?!\[REDACTED\])\S+/iu],
  [
    "credential assignment",
    /\b(?:api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*["']?[A-Za-z0-9_./+-]{16,}/iu,
  ],
  ["Telegram bot token", /\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/u],
  [
    "JWT",
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u,
  ],
  [
    "WhatsApp JID",
    /(?<![A-Za-z0-9])[\d-]+(?::\d+)?@(?:s\.whatsapp\.net|g\.us|lid|broadcast)\b/iu,
  ],
  [
    "environment secret",
    /\b[A-Z][A-Z0-9_]*(?:TOKEN|API_KEY|SECRET|PASSWORD)\s*[:=]\s*["']?(?!\[REDACTED\])[^\s"']{8,}/u,
  ],
  [
    "secret in URL",
    /[?&](?:token|key|api_?key|secret|password|code)=(?!\[REDACTED\])[^&\s]+/iu,
  ],
  ["Indonesian phone number", /(?<![A-Za-z0-9])(?:\+62|62|08)\d{9,13}(?!\d)/u],
  [
    "user identifier",
    /\b(?:user|owner|chat|account|group)[_-]?id\s*[:=]\s*\d{9,}\b/iu,
  ],
];

/**
 * Nilai sintetis yang sudah diperiksa satu per satu.
 *
 * Sengaja berpasangan dengan berkasnya dan berupa literal persis, bukan
 * pengecualian tingkat berkas. Mematikan seluruh berkas berarti token nyata
 * yang ditempel di sana besok tidak akan tertangkap; daftar ini hanya
 * memaafkan baris yang memang sudah dibaca manusia.
 */
const REVIEWED_SYNTHETIC: readonly (readonly [string, string, string])[] = [
  ["README.md", "6281234567890", "contoh WHATSAPP_ACCOUNTS di dokumentasi"],
  ["README.md", "6281111111111", "contoh akun kedua di dokumentasi"],
  [
    "scripts/console-browser-smoke.ts",
    "console-browser-smoke-token-with-safe-length",
    "token operator smoke test, panjangnya dipilih agar lolos validasi",
  ],
  [
    "scripts/console-browser-smoke.ts",
    "github-client-secret-browser-smoke",
    "client secret palsu untuk audit form coding",
  ],
  [
    "scripts/console-browser-smoke.ts",
    "123456789:abcdefghijklmnopqrstuvwxyz_ABCDE",
    "bot token palsu berpola urut, bukan token Telegram nyata",
  ],
  [
    "scripts/console-browser-smoke.ts",
    "-----BEGIN RSA PRIVATE KEY-----",
    "header PEM fixture; badannya base64 dari teks penanda palsu",
  ],
  [
    "scripts/console-browser-smoke.ts",
    "628123456789",
    "nomor placeholder untuk memeriksa penyamaran di UI konsol",
  ],
];

function reviewedSynthetic(path: string, line: string): boolean {
  return REVIEWED_SYNTHETIC.some(([file, literal]) =>
    path.endsWith(file) && line.includes(literal)
  );
}

/** Berkas yang manusia dan agent tulis, tempat credential paling mungkin tersalin. */
function trackedTextFiles(): string[] {
  const listed = execFileSync("git", ["ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return listed
    .split("\0")
    .filter((path) => path.length > 0)
    .filter((path) =>
      path.endsWith(".md") ||
      path.startsWith("scripts/") ||
      path.startsWith("docs/")
    )
    // Berkas ini memuat polanya sendiri; mencocokkannya dengan dirinya sendiri
    // hanya menghasilkan temuan yang selalu ada.
    .filter((path) => path !== "tests/credential-leak-scan.test.ts");
}

describe("pemindai credential pada berkas terlacak", () => {
  it("tidak menemukan credential, token, atau identifier pengguna nyata", () => {
    const findings: string[] = [];
    for (const path of trackedTextFiles()) {
      let content: string;
      try {
        content = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/u);
      for (const [label, pattern] of SECRET_PATTERNS) {
        for (const [index, line] of lines.entries()) {
          if (pattern.test(line) && !reviewedSynthetic(path, line)) {
            findings.push(`${path}:${index + 1} — ${label}`);
          }
        }
      }
    }
    assert.deepEqual(findings, [], findings.join("\n"));
  });

  // Daftar pengecualian yang tidak pernah diperiksa ulang akan tumbuh sampai
  // pemindainya tidak menjaga apa pun. Entri yang sudah tidak menunjuk baris
  // mana pun berarti berkasnya berubah, dan pengecualiannya harus ikut hilang.
  it("tidak menyimpan pengecualian yang sudah tidak menunjuk apa pun", () => {
    const stale = REVIEWED_SYNTHETIC.filter(([file, literal]) => {
      try {
        return !readFileSync(file, "utf8").includes(literal);
      } catch {
        return true;
      }
    }).map(([file, , reason]) => `${file} — ${reason}`);
    assert.deepEqual(stale, [], stale.join("\n"));
  });

  // Pemindai yang tidak pernah menyala tidak dapat dibedakan dari pemindai yang
  // rusak. Kasus ini membuktikan polanya masih menangkap bentuk yang dicari.
  it("masih mengenali bentuk yang dicarinya", () => {
    const samples: readonly (readonly [string, string])[] = [
      ["OpenAI-style key", "const key = 'sk-abcd1234efgh5678ijkl';"],
      ["Telegram bot token", "TELEGRAM=123456789:AAG9xYzabcdefghijklmnopqrstuvwx"],
      ["WhatsApp JID", "pengirim 6281234567890@s.whatsapp.net menulis"],
      ["Authorization header", "Authorization: Bearer abc123def456"],
      ["secret in URL", "https://contoh.test/callback?token=rahasiabanget"],
    ];
    for (const [label, sample] of samples) {
      const pattern = SECRET_PATTERNS.find((entry) => entry[0] === label)?.[1];
      assert.ok(pattern, label);
      assert.ok(pattern.test(sample), `${label} tidak cocok: ${sample}`);
    }
  });
});

/**
 * Karakter kontrol yang tidak terlihat di dalam sumber.
 *
 * Bukan soal kerapian. Pada 30 Agustus 2026 pagar register bahasa ternyata
 * memuat karakter backspace (0x08) di tempat `\b` seharusnya berada—sisa escape
 * yang termakan shell ketika pagar itu ditulis lewat skrip patch. Akibatnya
 * pemeriksa perpindahan ke bahasa Inggris **tidak pernah bisa menyala**: ia
 * hanya cocok pada karakter kontrol yang tak pernah ada di balasan mana pun.
 * Selama berhari-hari ia dilaporkan "belum pernah menangkap apa pun", dan itu
 * dibaca sebagai kabar baik.
 *
 * Kelas kesalahan ini tidak terlihat pada diff, tidak menggagalkan type-check,
 * dan tidak menghasilkan pesan apa pun. Satu-satunya cara menemukannya adalah
 * memindainya, dan satu-satunya cara mencegahnya kembali adalah memindainya
 * terus.
 */
describe("karakter kontrol tak terlihat di sumber", () => {
  it("tidak ada di berkas sumber maupun dokumen mana pun", () => {
    const offenders: string[] = [];
    for (const path of scannedFiles()) {
      const content = readFileSync(path, "utf8");
      for (const [index, character] of [...content].entries()) {
        const code = character.codePointAt(0) ?? 0;
        const forbidden = code < 9 ||
          (code >= 11 && code <= 12) ||
          (code >= 14 && code < 32);
        if (forbidden) {
          const line = content.slice(0, index).split("\n").length;
          offenders.push(
            `${path}:${line} memuat U+${code.toString(16).padStart(4, "0")}`,
          );
          break;
        }
      }
    }

    assert.deepEqual(offenders, []);
  });
});

/**
 * Berkas yang dipindai: sumber **dan** dokumen.
 *
 * Markdown ikut sejak 31 Agustus 2026. `SCRATCHPAD.md` ternyata memuat dua
 * karakter backspace sungguhan—di dalam paragraf yang justru menjelaskan bug
 * karakter backspace, tempat `\b` seharusnya berada. Ia bertahan berhari-hari
 * karena pemindainya hanya melihat TypeScript.
 *
 * Penyebabnya selalu sama: skrip patch ditulis lewat beberapa lapis shell, dan
 * salah satu lapisan memakan backslash-nya. Cara aman menuliskan karakter
 * seperti ini dari skrip adalah membangunnya dari kodenya, bukan mengetik
 * escape-nya.
 */
function scannedFiles(): string[] {
  const listed = execFileSync("git", ["ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return listed
    .split("\0")
    .filter((path) =>
      path.endsWith(".ts") || path.endsWith(".mjs") || path.endsWith(".md")
    );
}
