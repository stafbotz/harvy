import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  ControlPlaneRepository,
  ControlPlaneState,
} from "../domain/control-plane.js";

export class FileControlPlaneRepository implements ControlPlaneRepository {
  private queue: Promise<unknown> = Promise.resolve();
  private state: Promise<ControlPlaneState> | null = null;

  constructor(private readonly filePath: string) {}

  async snapshot(): Promise<ControlPlaneState> {
    return structuredClone(await this.readState());
  }

  async mutate<T>(operation: (draft: ControlPlaneState) => T): Promise<T> {
    return this.exclusive(async () => {
      const draft = structuredClone(await this.readState());
      const result = operation(draft);
      await this.writeState(draft);
      return result;
    });
  }

  private async readState(): Promise<ControlPlaneState> {
    this.state ??= this.loadState();
    return this.state;
  }

  private async loadState(): Promise<ControlPlaneState> {
    try {
      const parsed = JSON.parse(
        await readFile(this.filePath, "utf8"),
      ) as Partial<ControlPlaneState>;
      if (
        parsed.version !== 1 ||
        typeof parsed.installationKey !== "string" ||
        !Array.isArray(parsed.plans) ||
        !Array.isArray(parsed.prices) ||
        !Array.isArray(parsed.enrollments) ||
        !Array.isArray(parsed.principals) ||
        !Array.isArray(parsed.audit)
      ) {
        throw new Error("Format control plane tidak dikenali.");
      }
      const state = parsed as ControlPlaneState;
      state.enrollments = state.enrollments.map((enrollment) => ({
        ...enrollment,
        operatorLabel:
          typeof enrollment.operatorLabel === "string"
            ? enrollment.operatorLabel
            : null,
      }));
      return state;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return {
          version: 1,
          installationKey: randomBytes(32).toString("base64url"),
          plans: [],
          prices: [],
          enrollments: [],
          principals: [],
          audit: [],
        };
      }
      throw error;
    }
  }

  private async writeState(state: ControlPlaneState): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.filePath);
    this.state = Promise.resolve(state);
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
