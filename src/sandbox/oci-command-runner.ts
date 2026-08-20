import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";

export interface OciCommandRequest {
  executable: string;
  args: readonly string[];
  timeoutMs: number;
  maxOutputBytes: number;
  env: Readonly<Record<string, string>>;
  cwd?: string;
  stdinPath?: string;
  signal?: AbortSignal;
}

export interface OciCommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
  aborted: boolean;
  outputExceeded: boolean;
  wallClockMs: number;
}

export interface OciCommandRunner {
  run(request: OciCommandRequest): Promise<OciCommandResult>;
}

/**
 * Structured argv process boundary used only by the separately deployed Linux
 * executor service. `shell` is always false and the child receives an explicit
 * allowlisted environment instead of the service process environment.
 */
export class SpawnOciCommandRunner implements OciCommandRunner {
  async run(request: OciCommandRequest): Promise<OciCommandResult> {
    validateRequest(request);
    const started = Date.now();
    return new Promise<OciCommandResult>((resolve, reject) => {
      let settled = false;
      let timedOut = false;
      let aborted = false;
      let outputExceeded = false;
      let outputBytes = 0;
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const child = spawn(request.executable, [...request.args], {
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: [request.stdinPath ? "pipe" : "ignore", "pipe", "pipe"],
        env: { ...request.env },
        ...(request.cwd ? { cwd: request.cwd } : {}),
      });

      const kill = (): void => {
        if (child.pid === undefined || child.killed) return;
        try {
          if (process.platform === "win32") child.kill("SIGKILL");
          else process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        kill();
      }, request.timeoutMs);
      timeout.unref?.();
      const onAbort = (): void => {
        aborted = true;
        kill();
      };
      request.signal?.addEventListener("abort", onAbort, { once: true });

      if (request.stdinPath && child.stdin) {
        const input = createReadStream(request.stdinPath);
        input.once("error", (error) => child.stdin?.destroy(error));
        child.stdin.once("error", () => input.destroy());
        input.pipe(child.stdin);
      }

      const collect = (destination: Buffer[], chunk: Buffer, stream: "stdout" | "stderr"): void => {
        if (outputExceeded) return;
        const available = request.maxOutputBytes - outputBytes;
        if (available <= 0) {
          outputExceeded = true;
          kill();
          return;
        }
        const accepted = chunk.byteLength > available ? chunk.subarray(0, available) : chunk;
        destination.push(Buffer.from(accepted));
        outputBytes += accepted.byteLength;
        if (stream === "stdout") stdoutBytes += accepted.byteLength;
        else stderrBytes += accepted.byteLength;
        if (accepted.byteLength !== chunk.byteLength) {
          outputExceeded = true;
          kill();
        }
      };
      child.stdout?.on("data", (value: Buffer) => collect(stdout, value, "stdout"));
      child.stderr?.on("data", (value: Buffer) => collect(stderr, value, "stderr"));
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        request.signal?.removeEventListener("abort", onAbort);
        reject(error);
      });
      child.once("close", (exitCode, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        request.signal?.removeEventListener("abort", onAbort);
        resolve({
          exitCode,
          signal,
          stdout: Buffer.concat(stdout, stdoutBytes),
          stderr: Buffer.concat(stderr, stderrBytes),
          timedOut,
          aborted,
          outputExceeded,
          wallClockMs: Math.max(0, Date.now() - started),
        });
      });
    });
  }
}

function validateRequest(request: OciCommandRequest): void {
  if (!safeCommandPart(request.executable) || !Array.isArray(request.args) ||
    request.args.length > 512 || request.args.some((part) => !safeCommandPart(part)) ||
    !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 ||
    request.timeoutMs > 24 * 60 * 60 * 1_000 ||
    !Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes < 1 ||
    request.maxOutputBytes > 2 * 1_024 * 1_024 * 1_024 ||
    (request.stdinPath !== undefined && !safeCommandPart(request.stdinPath)) ||
    !request.env || Object.entries(request.env).some(([key, value]) =>
      !/^[A-Z_][A-Z0-9_]{0,63}$/u.test(key) || typeof value !== "string" ||
      value.length > 8_192 || value.includes("\0")
    )) {
    throw new Error("Request proses OCI tidak sah.");
  }
}

function safeCommandPart(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 32_768 &&
    !value.includes("\0") && !/[\r\n]/u.test(value);
}
