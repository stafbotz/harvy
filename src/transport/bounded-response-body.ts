const MAXIMUM_RESPONSE_BODY_BYTES = 128 * 1024 * 1024;

export type BoundedResponseBodyFailure =
  | "invalid_content_length"
  | "too_large";

/**
 * Error bebas payload/URL untuk boundary HTTP. Caller memetakan error ini ke
 * domainnya sendiri tanpa berisiko mencetak body atau credential provider.
 */
export class BoundedResponseBodyError extends Error {
  constructor(
    readonly reason: BoundedResponseBodyFailure,
    readonly maximumBytes: number,
  ) {
    super(
      reason === "too_large"
        ? "Response HTTP melewati batas byte."
        : "Content-Length response HTTP tidak sah.",
    );
    this.name = "BoundedResponseBodyError";
  }
}

/**
 * Membaca response sebagai byte stream dengan hard cap sebelum buffering.
 * Content-Length hanya dipakai sebagai early rejection; ukuran akhir tidak
 * dibandingkan dengannya karena fetch dapat men-decompress body secara
 * transparan sementara header masih mencerminkan wire size.
 */
export async function readBoundedResponseBody(
  response: Response,
  maximumBytes: number,
): Promise<Buffer> {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > MAXIMUM_RESPONSE_BODY_BYTES
  ) {
    throw new Error("Batas response HTTP tidak sah.");
  }

  const declared = response.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d{1,12}$/u.test(declared)) {
      await cancelBody(response);
      throw new BoundedResponseBodyError(
        "invalid_content_length",
        maximumBytes,
      );
    }
    const declaredBytes = Number(declared);
    if (!Number.isSafeInteger(declaredBytes)) {
      await cancelBody(response);
      throw new BoundedResponseBodyError(
        "invalid_content_length",
        maximumBytes,
      );
    }
    if (declaredBytes > maximumBytes) {
      await cancelBody(response);
      throw new BoundedResponseBodyError("too_large", maximumBytes);
    }
  }

  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  let complete = false;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      if (!(chunk instanceof Uint8Array) || chunk.byteLength < 1) continue;
      if (chunk.byteLength > maximumBytes - size) {
        throw new BoundedResponseBodyError("too_large", maximumBytes);
      }
      chunks.push(Buffer.from(chunk));
      size += chunk.byteLength;
    }
    complete = true;
    return Buffer.concat(chunks, size);
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}
