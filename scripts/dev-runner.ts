import { spawn, type ChildProcess } from "node:child_process";
import { statSync, watch, type FSWatcher } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const RESTART_DEBOUNCE_MS = 120;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 65_000;
const CONTROL_READY = "harvy-dev-control-ready";
const CONTROL_SHUTDOWN = "harvy-dev-shutdown";
const RUNNER_STOP = "harvy-dev-runner-stop";

interface DevRunnerOptions {
  cwd: string;
  entry: string;
  watchTargets?: string[];
  shutdownTimeoutMs: number;
}

export async function runDevRunner(options: DevRunnerOptions): Promise<number> {
  let child: ChildProcess | null = null;
  let controlReady = false;
  let restartQueued = false;
  let expectedExit: "restart" | "stop" | null = null;
  let stopping = false;
  let runnerFailed = false;
  let finished = false;
  let restartTimer: NodeJS.Timeout | undefined;
  let shutdownTimer: NodeJS.Timeout | undefined;
  const watchers: FSWatcher[] = [];

  let finishRun!: (code: number) => void;
  const runFinished = new Promise<number>((resolveRun) => {
    finishRun = resolveRun;
  });

  const log = (message: string): void => {
    process.stdout.write(`[harvy-dev] ${message}\n`);
  };

  const clearShutdownTimer = (): void => {
    if (!shutdownTimer) return;
    clearTimeout(shutdownTimer);
    shutdownTimer = undefined;
  };

  const closeWatchers = (): void => {
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = undefined;
    }
    for (const watcher of watchers.splice(0)) watcher.close();
  };

  const finish = (code: number): void => {
    if (finished) return;
    finished = true;
    closeWatchers();
    clearShutdownTimer();
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.off("message", onRunnerMessage);
    if (process.connected) {
      try {
        process.disconnect();
      } catch {
        // Parent runner sudah menutup channel.
      }
    }
    finishRun(code);
  };

  const armShutdownTimeout = (launched: ChildProcess): void => {
    clearShutdownTimer();
    shutdownTimer = setTimeout(() => {
      if (child !== launched || launched.exitCode !== null) return;
      log(
        `aplikasi tidak selesai dalam ${options.shutdownTimeoutMs} ms; ` +
          "watcher dihentikan tanpa restart",
      );
      stopping = true;
      runnerFailed = true;
      expectedExit = "stop";
      closeWatchers();
      launched.kill("SIGKILL");
    }, options.shutdownTimeoutMs);
  };

  const sendShutdown = (
    launched: ChildProcess,
    reason: "dev-restart" | "dev-stop",
  ): void => {
    if (!launched.connected) return;
    try {
      launched.send({ type: CONTROL_SHUTDOWN, reason }, (error) => {
        if (error && child === launched && launched.exitCode === null) {
          log("permintaan shutdown IPC gagal; menunggu batas shutdown");
        }
      });
    } catch {
      // Child dapat sedang keluar karena Ctrl+C yang diterimanya langsung.
    }
  };

  const beginRestart = (): void => {
    restartQueued = true;
    const launched = child;
    if (
      stopping ||
      !launched ||
      expectedExit !== null ||
      !controlReady
    ) {
      return;
    }
    restartQueued = false;
    expectedExit = "restart";
    log("perubahan terdeteksi; menunggu shutdown bersih sebelum restart");
    sendShutdown(launched, "dev-restart");
    armShutdownTimeout(launched);
  };

  const scheduleRestart = (changedPath: string): void => {
    if (stopping || finished) return;
    restartQueued = true;
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      log(`memuat ulang karena ${changedPath}`);
      beginRestart();
    }, RESTART_DEBOUNCE_MS);
    restartTimer.unref();
  };

  const spawnApp = (): void => {
    if (stopping || finished) return;
    controlReady = false;
    const launched = spawn(
      process.execPath,
      ["--import", "tsx", options.entry],
      {
        cwd: options.cwd,
        env: { ...process.env, HARVY_DEV_RUNNER: "1" },
        stdio: ["inherit", "inherit", "inherit", "ipc"],
      },
    );
    child = launched;

    launched.on("message", (message: unknown) => {
      if (
        child !== launched ||
        typeof message !== "object" ||
        message === null ||
        !("type" in message) ||
        message.type !== CONTROL_READY
      ) {
        return;
      }
      controlReady = true;
      if (restartQueued) beginRestart();
    });

    launched.once("error", () => {
      if (child !== launched) return;
      child = null;
      log("proses aplikasi gagal dibuat");
      finish(1);
    });

    launched.once("exit", (code, signal) => {
      if (child !== launched) return;
      child = null;
      controlReady = false;
      clearShutdownTimer();

      if (stopping || expectedExit === "stop") {
        finish(runnerFailed ? 1 : 0);
        return;
      }
      if (expectedExit === "restart" || restartQueued) {
        expectedExit = null;
        restartQueued = false;
        spawnApp();
        return;
      }

      log(
        `aplikasi berhenti tanpa restart (code=${code ?? "null"}, ` +
          `signal=${signal ?? "none"})`,
      );
      finish(code ?? 1);
    });
  };

  const stop = (source: "SIGINT" | "SIGTERM" | "ipc"): void => {
    if (stopping || finished) return;
    stopping = true;
    restartQueued = false;
    closeWatchers();
    const launched = child;
    if (!launched) {
      finish(0);
      return;
    }
    expectedExit = "stop";
    log(`shutdown diminta lewat ${source}; menunggu aplikasi melepas lock`);
    sendShutdown(launched, "dev-stop");
    armShutdownTimeout(launched);
  };

  function onSigint(): void {
    stop("SIGINT");
  }

  function onSigterm(): void {
    stop("SIGTERM");
  }

  function onRunnerMessage(message: unknown): void {
    if (
      typeof message === "object" &&
      message !== null &&
      "type" in message &&
      message.type === RUNNER_STOP
    ) {
      stop("ipc");
    }
  }

  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.on("message", onRunnerMessage);

  const onWatchError = (): void => {
    if (finished) return;
    log("watcher filesystem gagal; aplikasi dihentikan");
    runnerFailed = true;
    stop("ipc");
  };
  for (const watcher of createWatchers(options, scheduleRestart)) {
    watcher.on("error", onWatchError);
    watchers.push(watcher);
  }

  spawnApp();
  return runFinished;
}

function createWatchers(
  options: DevRunnerOptions,
  onChange: (changedPath: string) => void,
): FSWatcher[] {
  if (options.watchTargets && options.watchTargets.length > 0) {
    return options.watchTargets.map((target) => {
      const absolute = resolve(options.cwd, target);
      const recursive = statSync(absolute).isDirectory();
      return watch(absolute, { recursive }, (_event, filename) => {
        onChange(filename ? String(filename) : basename(absolute));
      });
    });
  }

  const sourceRoot = resolve(options.cwd, "src");
  const sourceWatcher = watch(
    sourceRoot,
    { recursive: true },
    (_event, filename) => onChange(filename ? String(filename) : "src"),
  );
  const rootFiles = new Set([".env", "package.json", "tsconfig.json"]);
  const rootWatcher = watch(options.cwd, (_event, filename) => {
    const changed = filename ? String(filename) : "";
    if (rootFiles.has(changed)) onChange(changed);
  });
  return [sourceWatcher, rootWatcher];
}

function parseOptions(argv: string[]): DevRunnerOptions {
  const cwd = process.cwd();
  let entry = resolve(cwd, "src/app.ts");
  let shutdownTimeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const watchTargets: string[] = [];

  for (const argument of argv) {
    if (argument.startsWith("--entry=")) {
      entry = resolve(cwd, argument.slice("--entry=".length));
    } else if (argument.startsWith("--watch=")) {
      watchTargets.push(argument.slice("--watch=".length));
    } else if (argument.startsWith("--shutdown-timeout-ms=")) {
      const value = Number(argument.slice("--shutdown-timeout-ms=".length));
      if (!Number.isSafeInteger(value) || value < 100) {
        throw new Error("--shutdown-timeout-ms harus integer minimal 100.");
      }
      shutdownTimeoutMs = value;
    } else {
      throw new Error(`Argumen dev runner tidak dikenal: ${argument}`);
    }
  }

  return {
    cwd,
    entry,
    shutdownTimeoutMs,
    ...(watchTargets.length > 0 ? { watchTargets } : {}),
  };
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isMainModule()) {
  try {
    process.exitCode = await runDevRunner(parseOptions(process.argv.slice(2)));
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    process.stderr.write(`[harvy-dev] runner gagal (${name})\n`);
    process.exitCode = 1;
  }
}
