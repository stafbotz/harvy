export interface OperatorSecretChannel {
  environment: string;
  interactive: boolean;
  stream: Pick<NodeJS.WritableStream, "write">;
}

/**
 * QR dan pairing code bukan log. Secret hanya boleh ditampilkan langsung ke
 * terminal operator lokal saat development; stdout produksi maupun pipe
 * non-interaktif dapat dikumpulkan oleh infrastruktur.
 */
export function operatorSecretChannelAvailable(
  environment: string,
  interactive: boolean,
): boolean {
  return environment !== "production" && interactive;
}

export function presentOperatorSecret(
  value: string,
  channel: OperatorSecretChannel,
): boolean {
  if (
    !operatorSecretChannelAvailable(
      channel.environment,
      channel.interactive,
    )
  ) {
    return false;
  }
  try {
    channel.stream.write(`${value}\n`);
    return true;
  } catch {
    return false;
  }
}
