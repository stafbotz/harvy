import type { ExecutionPlan } from "../core/execution-policy.js";
import type {
  AssistantContinuation,
  ChatAssistantToolMessage,
  ChatInputImagePart,
  ChatMessage,
  ChatToolCall,
} from "./client.js";
import type { ModelProfile } from "./model-profile.js";

const MAX_REASONING_CONTINUATION_CHARACTERS = 256_000;
const MAX_REASONING_DETAILS_CHARACTERS = 512_000;
const MAX_REASONING_DETAILS_DEPTH = 32;
const MAX_REASONING_DETAILS_NODES = 8_192;

interface ProviderBinding {
  providerId: string;
  modelId: string;
  profile?: ModelProfile | null;
  imageInputs?: readonly ChatInputImagePart[];
}

const TOOL_CALL_BINDINGS = new WeakMap<object, Readonly<ProviderBinding>>();

/** Binding out-of-band menjaga kompatibilitas shape publik ChatToolCall. */
export function bindProviderToolCall(
  call: ChatToolCall,
  binding: ProviderBinding,
): void {
  TOOL_CALL_BINDINGS.set(call, Object.freeze({ ...binding }));
}

interface ProviderOptionInput extends ProviderBinding {
  profile: ModelProfile | null;
  execution: ExecutionPlan | null;
  temperature: number;
}

/** Serializer tunggal untuk message wire; object internal tidak dikirim mentah. */
export function serializeProviderMessages(
  messages: readonly ChatMessage[],
  binding: ProviderBinding,
): readonly Record<string, unknown>[] {
  const images = binding.imageInputs ?? [];
  let imageUserIndex = -1;
  if (images.length > 0) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === "user") {
        imageUserIndex = index;
        break;
      }
    }
    if (imageUserIndex < 0) {
      throw new Error("Input gambar memerlukan giliran user terakhir.");
    }
  }
  return messages.map((message, index) => {
    if (message.role === "assistant" && "tool_calls" in message) {
      return serializeAssistantToolMessage(message, binding);
    }
    if (message.role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.tool_call_id,
        ...(message.name !== undefined ? { name: message.name } : {}),
        content: message.content,
      };
    }
    if (index === imageUserIndex) {
      return {
        role: "user",
        content: serializeMultimodalContent(message.content, images, binding),
      };
    }
    return {
      role: message.role,
      content: message.content,
    };
  });
}

function serializeMultimodalContent(
  text: string,
  images: readonly ChatInputImagePart[],
  binding: ProviderBinding,
): readonly Record<string, unknown>[] {
  if (
    binding.profile?.verification !== "explicit" ||
    !binding.profile.supports.imageInput
  ) {
    throw new Error("Profile provider tidak mengizinkan input gambar.");
  }
  return [
    ...images.map(serializeImagePart),
    // GMI/MiniMax-M3 hanya mengikat media secara andal ketika image part
    // mendahului pertanyaan. Urutan ini tetap sah pada wire OpenAI-compatible
    // dan membuat teks terakhir merujuk jelas pada media yang baru dilihat.
    { type: "text", text },
  ];
}

function serializeImagePart(part: ChatInputImagePart): Record<string, unknown> {
  const encoded = Buffer.from(
    part.data.buffer,
    part.data.byteOffset,
    part.data.byteLength,
  ).toString("base64");
  return {
    type: "image_url",
    image_url: {
      url: `data:${part.mediaType};base64,${encoded}`,
      ...(part.detail ? { detail: part.detail } : {}),
    },
  };
}

/** Provider-specific effort serialization; verbosity tetap metadata policy. */
export function serializeProviderOptions(
  input: ProviderOptionInput,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (!input.profile || input.profile.supports.temperature) {
    fields["temperature"] = input.temperature;
  }
  const effort = input.execution?.effectiveEffort ?? null;
  if (effort === null) return fields;
  const profile = input.profile;
  if (
    !profile ||
    profile.provider !== input.providerId ||
    profile.id !== input.modelId ||
    !profile.reasoning.supportedEfforts.includes(effort)
  ) {
    throw new Error("Profile reasoning tidak cocok dengan request provider.");
  }

  switch (profile.reasoning.wireFormat) {
    case "openrouter-reasoning":
      fields["reasoning"] = { effort, exclude: false };
      return fields;
    case "openai-reasoning-effort":
      fields["reasoning_effort"] = effort;
      return fields;
    case "deepseek-thinking":
      fields["reasoning_effort"] = effort;
      fields["thinking"] = { type: "enabled" };
      return fields;
    case "none":
      throw new Error("Profile tanpa wire reasoning menerima effort aktif.");
  }
}

function serializeAssistantToolMessage(
  message: ChatAssistantToolMessage,
  binding: ProviderBinding,
): Record<string, unknown> {
  const serialized: Record<string, unknown> = {
    role: "assistant",
    content: message.content,
    tool_calls: message.tool_calls.map((call) =>
      serializeToolCall(call, binding)),
  };
  if (!message.continuation) return serialized;
  assertContinuation(message.continuation, binding);
  if (message.continuation.reasoning !== undefined) {
    serialized["reasoning"] = message.continuation.reasoning;
  }
  if (message.continuation.reasoningContent !== undefined) {
    serialized["reasoning_content"] = message.continuation.reasoningContent;
  }
  if (message.continuation.reasoningDetails !== undefined) {
    serialized["reasoning_details"] = structuredClone(
      message.continuation.reasoningDetails,
    );
  }
  return serialized;
}

function serializeToolCall(
  call: ChatToolCall,
  binding: ProviderBinding,
): Record<string, unknown> {
  const callBinding = TOOL_CALL_BINDINGS.get(call);
  if (
    callBinding &&
    (callBinding.providerId !== binding.providerId ||
      callBinding.modelId !== binding.modelId)
  ) {
    throw new Error("Native tool call terikat provider/model lain.");
  }
  if (call.extra_content && !callBinding) {
    throw new Error("Metadata opaque native tool tidak mempunyai provider binding.");
  }
  return {
    id: call.id,
    type: "function",
    function: {
      name: call.function.name,
      arguments: call.function.arguments,
    },
    ...(call.extra_content
      ? { extra_content: structuredClone(call.extra_content) }
      : {}),
  };
}

function assertContinuation(
  continuation: AssistantContinuation,
  binding: ProviderBinding,
): void {
  if (
    continuation.providerId !== binding.providerId ||
    continuation.modelId !== binding.modelId
  ) {
    throw new Error("Reasoning continuation terikat provider/model lain.");
  }
  const hasReasoning =
    continuation.reasoning !== undefined ||
    continuation.reasoningContent !== undefined ||
    continuation.reasoningDetails !== undefined;
  if (
    hasReasoning &&
    (binding.profile?.verification !== "explicit" ||
      !binding.profile.continuation.preserveReasoning)
  ) {
    throw new Error("Profile tidak mengizinkan replay reasoning continuation.");
  }
  for (const value of [
    continuation.reasoning,
    continuation.reasoningContent,
  ]) {
    if (
      value !== undefined &&
      (typeof value !== "string" ||
        value.length > MAX_REASONING_CONTINUATION_CHARACTERS)
    ) {
      throw new Error("Reasoning continuation tidak sah atau terlalu besar.");
    }
  }
  if (continuation.reasoningDetails !== undefined) {
    if (
      !Array.isArray(continuation.reasoningDetails) ||
      !isBoundedJsonData(continuation.reasoningDetails)
    ) {
      throw new Error("Reasoning details harus berupa array JSON.");
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(continuation.reasoningDetails);
    } catch {
      throw new Error("Reasoning details bukan JSON yang aman.");
    }
    if (serialized.length > MAX_REASONING_DETAILS_CHARACTERS) {
      throw new Error("Reasoning details tidak sah atau terlalu besar.");
    }
  }
}

function isBoundedJsonData(root: unknown): boolean {
  const seen = new WeakSet<object>();
  const stack: { value: unknown; depth: number }[] = [{ value: root, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_REASONING_DETAILS_NODES || current.depth > MAX_REASONING_DETAILS_DEPTH) {
      return false;
    }
    const value = current.value;
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      continue;
    }
    if (!value || typeof value !== "object") return false;
    if (seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const entry of value) {
        stack.push({ value: entry, depth: current.depth + 1 });
      }
      continue;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    for (const entry of Object.values(value)) {
      stack.push({ value: entry, depth: current.depth + 1 });
    }
  }
  return true;
}
