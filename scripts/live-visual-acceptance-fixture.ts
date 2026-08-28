import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";

export type VisualAcceptanceColor = "red" | "green" | "blue";

export const VISUAL_ACCEPTANCE_COLORS: readonly VisualAcceptanceColor[] = [
  "red",
  "green",
  "blue",
];

export interface VisualAcceptanceFixture {
  data: Buffer;
  expectedColor: VisualAcceptanceColor;
  prompt: string;
}

const COLORS: ReadonlyArray<{
  name: VisualAcceptanceColor;
  rgb: readonly [number, number, number];
  words: readonly string[];
}> = [
  { name: "red", rgb: [236, 55, 62], words: ["merah", "red"] },
  { name: "green", rgb: [31, 164, 99], words: ["hijau", "green"] },
  { name: "blue", rgb: [49, 105, 218], words: ["biru", "blue"] },
];

/**
 * Gambar deterministic tetapi hasilnya tidak disebut dalam caption. Variasi
 * berdasarkan run label mencegah harness lulus karena jawaban statis Harvy.
 */
export function createVisualAcceptanceFixture(
  runLabel: string,
): VisualAcceptanceFixture {
  const selector = createHash("sha256")
    .update(`harvy-live-visual\0${runLabel}`, "utf8")
    .digest()[0]! % COLORS.length;
  return createVisualAcceptanceFixtureForColor(COLORS[selector]!.name);
}

export function createVisualAcceptanceFixtureForColor(
  expectedColor: VisualAcceptanceColor,
): VisualAcceptanceFixture {
  const color = COLORS.find((candidate) => candidate.name === expectedColor);
  if (!color) throw new Error("VISUAL_ACCEPTANCE_COLOR_INVALID");
  return {
    // Bidang warna polos dapat dinormalisasi sebagai blank/placeholder oleh
    // vision encoder. Pola geometris ini memberi tepi dan tekstur nyata sambil
    // menjaga warna target dominan secara objektif, termasuk setelah Telegram
    // mengubah PNG menjadi JPEG.
    data: dominantColorPatternPng(384, 384, ...color.rgb),
    expectedColor: color.name,
    prompt: [
      "Lihat gambar yang terlampir.",
      "Jawab satu kalimat pendek: warna apa yang paling dominan?",
      "Sebut satu warna saja dan jangan menebak dari nama file.",
    ].join(" "),
  };
}

export function matchesVisualAcceptanceResponse(
  text: string,
  expected: VisualAcceptanceColor,
): boolean {
  const observed = observedVisualAcceptanceColors(text);
  return observed.length === 1 && observed[0] === expected;
}

/**
 * Klasifikasi sempit ini aman dimasukkan ke evidence live: hanya nama warna
 * fixture yang dikembalikan, bukan isi balasan tester atau pengguna.
 */
export function observedVisualAcceptanceColors(
  text: string,
): VisualAcceptanceColor[] {
  const normalized = text.normalize("NFKC").toLocaleLowerCase("id-ID");
  return COLORS.filter((color) =>
    color.words.some((word) =>
      new RegExp(`(?:^|[^\\p{L}])${word}(?:$|[^\\p{L}])`, "u").test(normalized)
    )
  ).map((color) => color.name);
}

export function solidPng(
  width: number,
  height: number,
  red: number,
  green: number,
  blue: number,
): Buffer {
  return rgbPng(width, height, () => [red, green, blue]);
}

function assertPngDimensions(width: number, height: number): void {
  if (
    !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
    width < 1 || height < 1 || width > 512 || height > 512
  ) throw new Error("VISUAL_ACCEPTANCE_IMAGE_DIMENSIONS_INVALID");
}

function assertPngChannel(channel: number): void {
  if (!Number.isSafeInteger(channel) || channel < 0 || channel > 255) {
    throw new Error("VISUAL_ACCEPTANCE_IMAGE_COLOR_INVALID");
  }
}

function encodeRgbPng(width: number, height: number, raw: Buffer): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function dominantColorPatternPng(
  width: number,
  height: number,
  red: number,
  green: number,
  blue: number,
): Buffer {
  return rgbPng(width, height, (x, y) => {
    const border = 12;
    if (
      x < border || y < border || x >= width - border ||
      y >= height - border
    ) return [245, 247, 250];

    // Petak 48px memakai dua shade dari hue yang sama. Sekitar 84% area
    // interior tetap merupakan warna target; bentuk netral hanya memberi
    // struktur yang dapat dilihat encoder.
    const alternate = (Math.floor(x / 48) + Math.floor(y / 48)) % 2 === 0;
    const base: readonly [number, number, number] = alternate
      ? [red, green, blue]
      : [
          blendChannel(red, 255, 0.16),
          blendChannel(green, 255, 0.16),
          blendChannel(blue, 255, 0.16),
        ];

    const localX = x % 96;
    const localY = y % 96;
    if (localX >= 34 && localX < 48 && localY >= 34 && localY < 48) {
      return [33, 39, 48];
    }
    if (localX >= 70 && localX < 82 && localY >= 14 && localY < 26) {
      return [245, 247, 250];
    }
    return base;
  });
}

function blendChannel(from: number, to: number, amount: number): number {
  return Math.round(from + (to - from) * amount);
}

function rgbPng(
  width: number,
  height: number,
  pixelAt: (x: number, y: number) => readonly [number, number, number],
): Buffer {
  assertPngDimensions(width, height);
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const pixel = row + 1 + x * 3;
      const [red, green, blue] = pixelAt(x, y);
      for (const channel of [red, green, blue]) assertPngChannel(channel);
      raw[pixel] = red;
      raw[pixel + 1] = green;
      raw[pixel + 2] = blue;
    }
  }
  return encodeRgbPng(width, height, raw);
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const payload = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.byteLength, 0);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, payload])), 0);
  return Buffer.concat([length, typeBytes, payload, checksum]);
}

function crc32(data: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}
