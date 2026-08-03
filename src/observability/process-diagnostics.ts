import type {
  OperationalLogger,
  OperationalLogSystem,
} from "./operational-logger.js";

let installed = false;

/**
 * Exception/rejection fatal ditulis sinkron lalu proses langsung dihentikan.
 * Handler eksplisit mencegah Node mencetak stack mentah ke console, tetapi
 * tidak pernah mencoba melanjutkan state proses yang mungkin sudah rusak.
 */
export function installProcessDiagnostics(
  system: OperationalLogSystem,
  logger: OperationalLogger,
): () => void {
  if (installed) {
    throw new Error("Process diagnostics hanya boleh dipasang satu kali.");
  }
  installed = true;

  const onUncaughtException = (
    error: Error,
    origin: NodeJS.UncaughtExceptionOrigin,
  ): void => {
    system.fatalSync(
      "process_uncaught_exception",
      "Proses berhenti karena exception yang tidak tertangani.",
      error,
      { origin },
    );
    process.exit(1);
  };
  const onUnhandledRejection = (reason: unknown): void => {
    system.fatalSync(
      "process_unhandled_rejection",
      "Proses berhenti karena promise rejection yang tidak tertangani.",
      reason,
    );
    process.exit(1);
  };
  const onWarning = (warning: Error): void => {
    const withCode = warning as Error & { code?: unknown };
    logger.warn(
      "process_warning",
      "Runtime Node mengeluarkan peringatan.",
      {
        warningType: warning.name,
        code:
          typeof withCode.code === "string" ||
          typeof withCode.code === "number"
            ? withCode.code
            : undefined,
      },
    );
  };

  process.on("uncaughtException", onUncaughtException);
  process.on("unhandledRejection", onUnhandledRejection);
  process.on("warning", onWarning);

  return () => {
    process.off("uncaughtException", onUncaughtException);
    process.off("unhandledRejection", onUnhandledRejection);
    process.off("warning", onWarning);
    installed = false;
  };
}
