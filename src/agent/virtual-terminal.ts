import { posix as path } from "node:path";
import type {
  AgentCapabilityExecutor,
  AgentExecutionContext,
  AgentExecutorResult,
  AgentNativeToolDefinition,
} from "../harness/agent-harness.js";
import { MAX_AGENT_EXECUTOR_SUMMARY_CHARACTERS } from "../harness/agent-harness.js";

const MAX_COMMANDS = 12;
const MAX_TEXT_CHARACTERS = 8_000;
const MAX_TOTAL_FILE_CHARACTERS = 32_000;
const MAX_OUTPUT_CHARACTERS = 8_000;
const MAX_EXPRESSION_CHARACTERS = 240;
const MAX_CALCULATION_OPERATIONS = 100;

const VIRTUAL_TERMINAL_NATIVE_TOOL = {
  name: "harvy_terminal_run_v1",
  description:
    "Jalankan command pada terminal virtual kosong tanpa host, process, environment, atau network.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      commands: {
        type: "array",
        minItems: 1,
        maxItems: MAX_COMMANDS,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            op: {
              type: "string",
              enum: [
                "pwd",
                "date",
                "echo",
                "calculate",
                "write",
                "append",
                "cat",
                "list",
                "remove",
              ],
            },
            text: { type: "string", maxLength: MAX_TEXT_CHARACTERS },
            expression: {
              type: "string",
              maxLength: MAX_EXPRESSION_CHARACTERS,
            },
            path: { type: "string" },
            content: { type: "string", maxLength: MAX_TEXT_CHARACTERS },
          },
          required: ["op"],
        },
      },
    },
    required: ["commands"],
  },
} satisfies AgentNativeToolDefinition;

type VirtualTerminalCommand =
  | { op: "pwd" }
  | { op: "date" }
  | { op: "echo"; text: string }
  | { op: "calculate"; expression: string }
  | { op: "write"; path: string; content: string }
  | { op: "append"; path: string; content: string }
  | { op: "cat"; path: string }
  | { op: "list"; path?: string }
  | { op: "remove"; path: string };

interface VirtualTerminalInput {
  commands: VirtualTerminalCommand[];
}

/**
 * Terminal kecil yang sengaja bukan shell sistem operasi.
 *
 * Setiap execute mendapat filesystem kosong di memori. Tidak ada child process,
 * environment, network, host mount, TTY, background job, atau state lintas run.
 * Ini memberi Harvy scratchpad deterministik tanpa menjadikan prompt injection
 * sebagai akses ke token dan data privat proses bot.
 */
export class VirtualTerminalExecutor
implements AgentCapabilityExecutor<VirtualTerminalInput> {
  readonly capabilityId = "terminal.run";
  readonly capabilityVersion = "1";
  readonly nativeTool = VIRTUAL_TERMINAL_NATIVE_TOOL;

  constructor(private readonly now: () => Date = () => new Date()) {}

  validate(input: unknown) {
    if (!isRecordWithKeys(input, ["commands"])) {
      return { ok: false as const, reason: "Input terminal hanya boleh memuat commands." };
    }
    if (
      !Array.isArray(input.commands) ||
      input.commands.length === 0 ||
      input.commands.length > MAX_COMMANDS
    ) {
      return {
        ok: false as const,
        reason: `commands harus berisi 1–${MAX_COMMANDS} perintah.`,
      };
    }

    const commands: VirtualTerminalCommand[] = [];
    for (const raw of input.commands) {
      const command = parseCommand(raw);
      if (!command.ok) return command;
      commands.push(command.value);
    }
    return { ok: true as const, value: { commands } };
  }

  async execute(
    input: VirtualTerminalInput,
    context: AgentExecutionContext,
  ): Promise<AgentExecutorResult> {
    const files = new Map<string, string>();
    const output: string[] = [];

    try {
      for (const command of input.commands) {
        if (context.signal.aborted) {
          throw new DOMException("Terminal virtual dibatalkan.", "AbortError");
        }
        output.push(runCommand(command, files, this.now));
        if (totalCharacters(files) > MAX_TOTAL_FILE_CHARACTERS) {
          return {
            status: "error",
            summary: terminalSummary(
              output,
              "Batas total filesystem virtual 32.000 karakter terlampaui.",
            ),
          };
        }
      }
      return { status: "ok", summary: terminalSummary(output) };
    } catch (error) {
      if (context.signal.aborted) throw error;
      return {
        status: "error",
        summary: terminalSummary(output, safeErrorMessage(error)),
      };
    }
  }
}

function parseCommand(
  raw: unknown,
):
  | { ok: true; value: VirtualTerminalCommand }
  | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "Setiap command harus berupa objek." };
  }
  const record = raw as Record<string, unknown>;
  switch (record.op) {
    case "pwd":
    case "date":
      return exactKeys(record, ["op"])
        ? { ok: true, value: { op: record.op } }
        : { ok: false, reason: `${record.op} tidak menerima argumen.` };
    case "echo": {
      if (!exactKeys(record, ["op", "text"]) || !safeText(record.text)) {
        return { ok: false, reason: "echo membutuhkan text yang valid." };
      }
      return { ok: true, value: { op: "echo", text: record.text } };
    }
    case "calculate": {
      if (
        !exactKeys(record, ["op", "expression"]) ||
        typeof record.expression !== "string" ||
        !record.expression.trim() ||
        record.expression.length > MAX_EXPRESSION_CHARACTERS
      ) {
        return { ok: false, reason: "calculate membutuhkan expression pendek." };
      }
      try {
        calculate(record.expression);
      } catch (error) {
        return { ok: false, reason: safeErrorMessage(error) };
      }
      return {
        ok: true,
        value: { op: "calculate", expression: record.expression },
      };
    }
    case "write":
    case "append": {
      if (
        !exactKeys(record, ["op", "path", "content"]) ||
        typeof record.path !== "string" ||
        !safeText(record.content)
      ) {
        return { ok: false, reason: `${record.op} membutuhkan path dan content.` };
      }
      const normalized = safeVirtualPath(record.path);
      if (!normalized.ok) return normalized;
      return {
        ok: true,
        value: {
          op: record.op,
          path: normalized.value,
          content: record.content,
        },
      };
    }
    case "cat":
    case "remove": {
      if (
        !exactKeys(record, ["op", "path"]) ||
        typeof record.path !== "string"
      ) {
        return { ok: false, reason: `${record.op} membutuhkan path.` };
      }
      const normalized = safeVirtualPath(record.path);
      if (!normalized.ok) return normalized;
      return {
        ok: true,
        value: { op: record.op, path: normalized.value },
      };
    }
    case "list": {
      if (!exactKeys(record, ["op"], ["path"])) {
        return { ok: false, reason: "list hanya menerima path opsional." };
      }
      if (record.path === undefined) return { ok: true, value: { op: "list" } };
      if (typeof record.path !== "string") {
        return { ok: false, reason: "path list harus berupa string." };
      }
      const normalized = safeVirtualDirectory(record.path);
      if (!normalized.ok) return normalized;
      return { ok: true, value: { op: "list", path: normalized.value } };
    }
    default:
      return {
        ok: false,
        reason:
          "Perintah terminal tidak dikenal. Gunakan pwd, date, echo, calculate, write, append, cat, list, atau remove.",
      };
  }
}

function runCommand(
  command: VirtualTerminalCommand,
  files: Map<string, string>,
  now: () => Date,
): string {
  switch (command.op) {
    case "pwd":
      return "/workspace";
    case "date":
      return now().toISOString();
    case "echo":
      return command.text;
    case "calculate":
      return String(calculate(command.expression));
    case "write":
      files.set(command.path, command.content);
      return `wrote ${command.path} (${command.content.length} chars)`;
    case "append": {
      const next = `${files.get(command.path) ?? ""}${command.content}`;
      if (next.length > MAX_TEXT_CHARACTERS) {
        throw new Error("Satu berkas virtual melebihi 8.000 karakter.");
      }
      files.set(command.path, next);
      return `appended ${command.path} (${next.length} chars total)`;
    }
    case "cat": {
      const content = files.get(command.path);
      if (content === undefined) throw new Error(`Berkas ${command.path} tidak ada.`);
      return content;
    }
    case "list": {
      const directory = command.path ?? "/workspace";
      const prefix = directory === "/workspace" ? "/workspace/" : `${directory}/`;
      const matches = [...files.keys()]
        .filter((name) => name.startsWith(prefix))
        .sort();
      return matches.length > 0 ? matches.join("\n") : "(empty)";
    }
    case "remove":
      return files.delete(command.path)
        ? `removed ${command.path}`
        : `not found ${command.path}`;
  }
}

function terminalSummary(output: readonly string[], error?: string): string {
  const full = output.map((item, index) => `[${index + 1}] ${item}`).join("\n");
  const hardBounded = full.slice(0, MAX_OUTPUT_CHARACTERS);
  const base = {
    kind: "terminal.virtual.result",
    environment: {
      ephemeral: true,
      hostShell: false,
      network: false,
      hostFiles: false,
      environmentVariables: false,
      workspace: "/workspace",
    },
    ...(error ? { error: error.slice(0, 500) } : {}),
  };
  let low = 0;
  let high = hardBounded.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const serialized = JSON.stringify({
      ...base,
      output: hardBounded.slice(0, middle),
      truncated: middle < full.length,
    });
    if (serialized.length <= MAX_AGENT_EXECUTOR_SUMMARY_CHARACTERS) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return JSON.stringify({
    ...base,
    output: hardBounded.slice(0, low),
    truncated: low < full.length,
  });
}

function safeVirtualPath(
  raw: string,
): { ok: true; value: string } | { ok: false; reason: string } {
  const cleaned = raw.trim().replaceAll("\\", "/");
  if (!cleaned || /[\u0000-\u001f\u007f]/u.test(cleaned)) {
    return { ok: false, reason: "Path virtual kosong atau memuat karakter kontrol." };
  }
  const withoutRoot = cleaned.startsWith("/workspace/")
    ? cleaned.slice("/workspace/".length)
    : cleaned;
  const segments = withoutRoot.split("/");
  if (
    cleaned === "/workspace" ||
    cleaned.startsWith("/") && !cleaned.startsWith("/workspace/") ||
    segments.some((segment) => segment === ".." || segment === ".")
  ) {
    return { ok: false, reason: "Path harus tetap di dalam /workspace." };
  }
  if (segments.some((segment) => /^\.env(?:\.|$)/iu.test(segment))) {
    return {
      ok: false,
      reason: "Berkas environment tidak tersedia di terminal virtual.",
    };
  }
  if (
    !withoutRoot ||
    withoutRoot.length > 160 ||
    segments.some(
      (segment) => !segment || !/^[\p{L}\p{N}._ -]+$/u.test(segment),
    )
  ) {
    return { ok: false, reason: "Path virtual tidak sah." };
  }
  const normalized = path.normalize(`/workspace/${withoutRoot}`);
  if (!normalized.startsWith("/workspace/") || normalized === "/workspace") {
    return { ok: false, reason: "Path harus tetap di dalam /workspace." };
  }
  return { ok: true, value: normalized };
}

function safeVirtualDirectory(
  raw: string,
): { ok: true; value: string } | { ok: false; reason: string } {
  if (raw.trim() === "/workspace" || raw.trim() === "." || raw.trim() === "") {
    return { ok: true, value: "/workspace" };
  }
  return safeVirtualPath(raw);
}

function safeText(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_TEXT_CHARACTERS;
}

function totalCharacters(files: ReadonlyMap<string, string>): number {
  let total = 0;
  for (const value of files.values()) total += value.length;
  return total;
}

function isRecordWithKeys(
  value: unknown,
  required: readonly string[],
): value is Record<string, unknown> {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      exactKeys(value as Record<string, unknown>, required),
  );
}

function exactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(record);
  return required.every((key) => keys.includes(key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key));
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message.slice(0, 500)
    : "Perintah terminal virtual gagal.";
}

/** Parser aritmetika sendiri; tidak memakai eval/Function atau shell. */
export function calculate(expression: string): number {
  let index = 0;
  let operations = 0;

  const skipSpace = (): void => {
    while (/\s/u.test(expression[index] ?? "")) index += 1;
  };
  const apply = (operation: () => number): number => {
    operations += 1;
    if (operations > MAX_CALCULATION_OPERATIONS) {
      throw new Error("Ekspresi terlalu rumit.");
    }
    const value = operation();
    if (!Number.isFinite(value) || Math.abs(value) > 1e15) {
      throw new Error("Hasil perhitungan berada di luar batas aman.");
    }
    return value;
  };
  const parseNumber = (): number => {
    skipSpace();
    const match = /^(?:\d+(?:\.\d*)?|\.\d+)/u.exec(expression.slice(index));
    if (!match) throw new Error("Angka atau tanda kurung diharapkan.");
    index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) throw new Error("Angka tidak sah.");
    return value;
  };
  const parsePrimary = (): number => {
    skipSpace();
    if (expression[index] === "(") {
      index += 1;
      const value = parseAdditive();
      skipSpace();
      if (expression[index] !== ")") throw new Error("Tanda kurung belum ditutup.");
      index += 1;
      return value;
    }
    return parseNumber();
  };
  const parseUnary = (): number => {
    skipSpace();
    if (expression[index] === "+") {
      index += 1;
      return parseUnary();
    }
    if (expression[index] === "-") {
      index += 1;
      return apply(() => -parseUnary());
    }
    return parsePrimary();
  };
  const parsePower = (): number => {
    const left = parseUnary();
    skipSpace();
    if (expression[index] !== "^") return left;
    index += 1;
    const right = parsePower();
    return apply(() => left ** right);
  };
  const parseMultiplicative = (): number => {
    let value = parsePower();
    while (true) {
      skipSpace();
      const operator = expression[index];
      if (operator !== "*" && operator !== "/" && operator !== "%") return value;
      index += 1;
      const right = parsePower();
      if ((operator === "/" || operator === "%") && right === 0) {
        throw new Error("Pembagian dengan nol tidak diizinkan.");
      }
      value = apply(() => operator === "*"
        ? value * right
        : operator === "/"
          ? value / right
          : value % right);
    }
  };
  function parseAdditive(): number {
    let value = parseMultiplicative();
    while (true) {
      skipSpace();
      const operator = expression[index];
      if (operator !== "+" && operator !== "-") return value;
      index += 1;
      const right = parseMultiplicative();
      value = apply(() => operator === "+" ? value + right : value - right);
    }
  }

  if (!expression.trim() || expression.length > MAX_EXPRESSION_CHARACTERS) {
    throw new Error("Ekspresi kosong atau terlalu panjang.");
  }
  const result = parseAdditive();
  skipSpace();
  if (index !== expression.length) throw new Error("Ekspresi memuat token yang tidak dikenal.");
  return Object.is(result, -0) ? 0 : result;
}
