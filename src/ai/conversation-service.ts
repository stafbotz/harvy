import OpenAI from "openai";
import { HARVY_INSTRUCTIONS } from "./harvy-instructions.js";

export const MAX_AI_OUTPUT_TOKENS = 600;

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ConversationRequest {
  message: string;
  history: ConversationMessage[];
}

export interface ConversationService {
  reply(request: ConversationRequest): Promise<string>;
}

export interface OpenAIConversationOptions {
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export interface OpenAIResponseRequest {
  model: string;
  instructions: string;
  input: ConversationMessage[];
  store: false;
  max_output_tokens: number;
  reasoning: {
    effort: "low";
  };
  moderation: {
    model: "omni-moderation-latest";
    policy: {
      input: {
        mode: "score";
      };
      output: {
        mode: "block";
      };
    };
  };
}

export interface OpenAIResponsesClient {
  create(request: OpenAIResponseRequest): Promise<{
    output_text: string;
  }>;
}

export class OpenAIConversationService implements ConversationService {
  private readonly responses: OpenAIResponsesClient;

  constructor(
    private readonly options: OpenAIConversationOptions,
    responses?: OpenAIResponsesClient,
  ) {
    this.responses = responses ?? createResponsesClient(options);
  }

  async reply(request: ConversationRequest): Promise<string> {
    const response = await this.responses.create({
      model: this.options.model,
      instructions: HARVY_INSTRUCTIONS,
      input: [
        ...request.history,
        { role: "user", content: request.message },
      ],
      store: false,
      max_output_tokens: MAX_AI_OUTPUT_TOKENS,
      reasoning: { effort: "low" },
      moderation: {
        model: "omni-moderation-latest",
        policy: {
          input: { mode: "score" },
          output: { mode: "block" },
        },
      },
    });

    const text = response.output_text.trim();
    if (!text) {
      throw new Error("Model mengembalikan respons kosong.");
    }
    return text;
  }
}

export class UnavailableConversationService implements ConversationService {
  async reply(_request: ConversationRequest): Promise<string> {
    throw new Error("Layanan AI belum dikonfigurasi.");
  }
}

function createResponsesClient(
  options: OpenAIConversationOptions,
): OpenAIResponsesClient {
  const client = new OpenAI({
    apiKey: options.apiKey,
    timeout: options.timeoutMs,
    maxRetries: 1,
  });

  return {
    async create(request) {
      return client.responses.create(request);
    },
  };
}
