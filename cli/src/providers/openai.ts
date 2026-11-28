import { fetchJson, withRetry } from "../retry.ts";
import { RESPONSE_SCHEMA, buildUserPrompt, systemPromptFor, parseTranslations } from "./prompt.ts";
import type { BatchRequest, Provider } from "./types.ts";
import { LLM_LIMITS, OutputTruncatedError, ProviderError } from "./types.ts";

export interface OpenAIOptions {
  model: string;
  /** Default: OPENAI_BASE_URL or https://api.openai.com/v1. Any OpenAI-compatible server works. */
  baseUrl?: string;
  apiKey?: string;
}

/**
 * OpenAI Chat Completions with a strict JSON schema response format.
 * Also works with OpenAI-compatible local servers (LM Studio, vLLM, llama.cpp)
 * through OPENAI_BASE_URL. There is no default model: pass --model.
 */
export class OpenAIProvider implements Provider {
  readonly name = "openai";
  readonly label: string;
  readonly limits = LLM_LIMITS;
  readonly canShorten = true;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;

  constructor(opts: OpenAIOptions) {
    this.model = opts.model;
    this.baseUrl = (opts.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
    if (!this.apiKey && this.baseUrl.includes("api.openai.com")) {
      throw new ProviderError("OPENAI_API_KEY is not set");
    }
    this.label = `openai/${this.model}`;
  }

  async translateBatch(req: BatchRequest): Promise<Record<string, string>> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    const body = {
      model: this.model,
      messages: [
        { role: "system", content: systemPromptFor(req.kind) },
        { role: "user", content: buildUserPrompt(req) },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "translations", strict: true, schema: RESPONSE_SCHEMA },
      },
    };
    const data = (await withRetry(() =>
      fetchJson(`${this.baseUrl}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body) }),
    )) as { choices?: { finish_reason?: string; message?: { content?: string | null; refusal?: string | null } }[] };
    const choice = data.choices?.[0];
    if (!choice?.message) throw new ProviderError("response has no choices");
    if (choice.message.refusal) throw new ProviderError(`model refused: ${choice.message.refusal}`);
    if (choice.finish_reason === "length") throw new OutputTruncatedError();
    return parseTranslations(choice.message.content ?? "", req);
  }
}
