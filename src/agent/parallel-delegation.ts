import type {
  AgentCapabilityExecutor,
  AgentExecutionContext,
  AgentExecutorResult,
  AgentNativeToolDefinition,
} from "../harness/agent-harness.js";

export type AgentWorkerTier = "cheap" | "efficient";

export interface AgentWorkerTask {
  id: string;
  instruction: string;
  tier: AgentWorkerTier;
}

export interface AgentWorkerContext {
  runId: string;
  scopeKind: "private";
  channel: "telegram";
  /** Berasal dari scope executor tepercaya, bukan input planner. */
  ownerId: string;
  signal: AbortSignal;
}

export type AgentWorker = (
  task: AgentWorkerTask,
  context: AgentWorkerContext,
) => Promise<string>;

interface ParallelDelegationInput {
  tasks: AgentWorkerTask[];
}

const MAX_CHILDREN = 3;
const MAX_INSTRUCTION_CHARACTERS = 1_200;
// Tiga hasil + metadata harus tetap berada di bawah observation budget harness
// (4.000 karakter) tanpa memotong JSON atau menghilangkan worker terakhir.
const MAX_CHILD_OUTPUT_CHARACTERS = 800;
const MAX_SUMMARY_CHARACTERS = 3_600;

const PARALLEL_DELEGATION_NATIVE_TOOL = {
  name: "harvy_agent_delegate_parallel_v1",
  description:
    "Delegasikan 2–3 subpekerjaan independen kepada worker read-only tanpa tool atau memori.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      tasks: {
        type: "array",
        minItems: 2,
        maxItems: MAX_CHILDREN,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", minLength: 1, maxLength: 32 },
            instruction: {
              type: "string",
              minLength: 1,
              maxLength: MAX_INSTRUCTION_CHARACTERS,
            },
            tier: { type: "string", enum: ["cheap", "efficient"] },
          },
          required: ["id", "instruction", "tier"],
        },
      },
    },
    required: ["tasks"],
  },
} satisfies AgentNativeToolDefinition;

type DelegationChildResult =
  | {
      id: string;
      tier: AgentWorkerTier;
      status: "ok";
      output: string;
      truncated: boolean;
    }
  | {
      id: string;
      tier: AgentWorkerTier;
      status: "error";
      error: string;
    };

/**
 * Fan-out satu tingkat. Worker hanya menerima satu instruksi dan tidak
 * memperoleh harness, tool registry, memory, credential, atau API delegasi.
 */
export class ParallelDelegationExecutor
implements AgentCapabilityExecutor<ParallelDelegationInput> {
  readonly capabilityId = "agent.delegate.parallel";
  readonly capabilityVersion = "1";
  readonly nativeTool = PARALLEL_DELEGATION_NATIVE_TOOL;
  private readonly gate: ProviderSemaphore;

  constructor(
    private readonly worker: AgentWorker,
    maxConcurrentWorkers = MAX_CHILDREN,
  ) {
    this.gate = new ProviderSemaphore(maxConcurrentWorkers);
  }

  validate(input: unknown) {
    if (!exactRecord(input, ["tasks"]) || !Array.isArray(input.tasks)) {
      return { ok: false as const, reason: "Input delegasi hanya boleh memuat tasks." };
    }
    if (input.tasks.length < 2 || input.tasks.length > MAX_CHILDREN) {
      return {
        ok: false as const,
        reason: `Delegasi paralel membutuhkan 2–${MAX_CHILDREN} subpekerjaan independen.`,
      };
    }
    const tasks: AgentWorkerTask[] = [];
    const ids = new Set<string>();
    for (const raw of input.tasks) {
      if (
        !exactRecord(raw, ["id", "instruction", "tier"]) ||
        typeof raw.id !== "string" ||
        !/^[a-z][a-z0-9_-]{0,31}$/u.test(raw.id) ||
        ids.has(raw.id) ||
        typeof raw.instruction !== "string" ||
        !raw.instruction.trim() ||
        raw.instruction.length > MAX_INSTRUCTION_CHARACTERS ||
        (raw.tier !== "cheap" && raw.tier !== "efficient")
      ) {
        return {
          ok: false as const,
          reason:
            "Setiap task perlu id unik, instruction pendek, dan tier cheap atau efficient.",
        };
      }
      ids.add(raw.id);
      tasks.push({
        id: raw.id,
        instruction: raw.instruction.trim(),
        tier: raw.tier,
      });
    }
    return { ok: true as const, value: { tasks } };
  }

  async execute(
    input: ParallelDelegationInput,
    context: AgentExecutionContext,
  ): Promise<AgentExecutorResult> {
    if (context.scope.kind !== "private" || context.scope.channel !== "telegram") {
      return {
        status: "error",
        summary: JSON.stringify({
          kind: "agent.delegate.parallel.result",
          reason: "Delegasi hanya tersedia pada ruang privat Telegram.",
          results: [],
        }),
      };
    }
    if (context.step !== 0) {
      return {
        status: "error",
        summary: JSON.stringify({
          kind: "agent.delegate.parallel.result",
          reason:
            "Delegasi hanya boleh terjadi pada langkah pertama yang tidak menerima konteks tersimpan.",
          results: [],
        }),
      };
    }
    const ownerId = context.scope.userId;

    const settled = await Promise.allSettled(
      input.tasks.map(async (task) => {
        const release = await this.gate.acquire(context.signal);
        try {
          const output = await this.worker(task, {
            runId: context.runId,
            scopeKind: "private",
            channel: "telegram",
            ownerId,
            signal: context.signal,
          });
          if (context.signal.aborted) {
            throw new DOMException("Delegasi dibatalkan.", "AbortError");
          }
          const clean = output.trim();
          if (!clean) throw new Error("Worker mengembalikan keluaran kosong.");
          return {
            id: task.id,
            tier: task.tier,
            status: "ok" as const,
            output: clean.slice(0, MAX_CHILD_OUTPUT_CHARACTERS),
            truncated: clean.length > MAX_CHILD_OUTPUT_CHARACTERS,
          };
        } finally {
          release();
        }
      }),
    );

    if (context.signal.aborted) {
      throw new DOMException("Delegasi dibatalkan.", "AbortError");
    }
    const results: DelegationChildResult[] = settled.map((result, index) => {
      const task = input.tasks[index]!;
      return result.status === "fulfilled"
        ? result.value
        : {
            id: task.id,
            tier: task.tier,
            status: "error" as const,
            error: safeError(result.reason),
          };
    });
    const successes = results.filter((result) => result.status === "ok").length;
    return {
      status: successes === 0 ? "error" : "ok",
      summary: boundedDelegationSummary({
        kind: "agent.delegate.parallel.result",
        trust: "model-worker-output-untrusted",
        depth: 1,
        recursiveDelegation: false,
        requested: input.tasks.length,
        succeeded: successes,
        partial: successes !== input.tasks.length,
        results,
      }),
    };
  }
}

class ProviderSemaphore {
  private active = 0;
  private readonly waiters: Array<{
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    signal: AbortSignal;
    onAbort: () => void;
  }> = [];

  constructor(private readonly maximum: number) {
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 16) {
      throw new Error("Batas concurrency worker tidak sah.");
    }
  }

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) {
      return Promise.reject(new DOMException("Delegasi dibatalkan.", "AbortError"));
    }
    if (this.active < this.maximum) {
      this.active += 1;
      return Promise.resolve(this.releaseOnce());
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        signal,
        onAbort: (): void => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new DOMException("Delegasi dibatalkan.", "AbortError"));
        },
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next) {
        next.signal.removeEventListener("abort", next.onAbort);
        next.resolve(this.releaseOnce());
        return;
      }
      this.active -= 1;
    };
  }
}

function exactRecord(
  input: unknown,
  keys: readonly string[],
): input is Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const present = Object.keys(input);
  return keys.every((key) => present.includes(key)) &&
    present.every((key) => keys.includes(key));
}

function safeError(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, 200)
    : "Worker gagal tanpa detail yang dapat digunakan.";
}

function boundedDelegationSummary(payload: {
  kind: string;
  trust: string;
  depth: number;
  recursiveDelegation: boolean;
  requested: number;
  succeeded: number;
  partial: boolean;
  results: DelegationChildResult[];
}): string {
  const results = payload.results.map((result) => ({ ...result }));
  let serialized = JSON.stringify({ ...payload, results });
  for (let pass = 0; serialized.length > MAX_SUMMARY_CHARACTERS && pass < 12; pass += 1) {
    const outputs = results.filter(
      (result): result is Extract<DelegationChildResult, { status: "ok" }> =>
        result.status === "ok" && result.output.length > 0,
    );
    if (outputs.length === 0) break;
    const ratio = Math.max(
      0,
      Math.min(0.9, (MAX_SUMMARY_CHARACTERS / serialized.length) * 0.9),
    );
    for (const result of outputs) {
      const nextLength = Math.max(0, Math.floor(result.output.length * ratio));
      result.output = result.output.slice(0, nextLength);
      result.truncated = true;
    }
    serialized = JSON.stringify({ ...payload, results });
  }
  return serialized;
}
