import type Anthropic from "@anthropic-ai/sdk";
import { RESPONSE_SCHEMA, buildUserPrompt, systemPromptFor, parseTranslations } from "./prompt.ts";
import type { BatchRequest, Provider } from "./types.ts";
import { LLM_LIMITS, OutputTruncatedError, ProviderError } from "./types.ts";

/** Current default Claude model (Claude Opus 5.5). Override with --model. */
export const ANTHROPIC_DEFAULT_MODEL = "claude-opus-5-5";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AnthropicOptions {
  model?: string;
  effort?: Effort;
  /** For tests: inject a client. */
  client?: Anthropic;
}

/**
 * Claude via the official SDK. Credentials come from the environment
 * (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile);
 * nothing is written to disk.
 *
 * - Structured outputs (output_config.format) give parseable JSON.
 * - The SDK retries 429 / 5xx / connection errors itself (maxRetries).
 * - Server-side refusal fallback is on ("default"); on models without
 *   fallback support the request simply runs on the requested model.
 */
export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  readonly label: string;
  readonly limits = LLM_LIMITS;
  private readonly model: string;
  private readonly effort: Effort;
  private client: Anthropic | undefined;

  constructor(opts: AnthropicOptions = {}) {
    this.model = opts.model ?? ANTHROPIC_DEFAULT_MODEL;
    this.effort = opts.effort ?? "medium";
    this.client = opts.client;
    this.label = `anthropic/${this.model}`;
  }

  private async getClient(): Promise<Anthropic> {
    if (!this.client) {
      const { default: AnthropicSdk } = await import("@anthropic-ai/sdk");
      this.client = new AnthropicSdk({ maxRetries: 6 });
    }
    return this.client;
  }

  async translateBatch(req: BatchRequest): Promise<Record<string, string>> {
    const client = await this.getClient();
    const response = await client.beta.messages.create({
      model: this.model,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: {
        effort: this.effort,
        format: { type: "json_schema", schema: RESPONSE_SCHEMA as unknown as Record<string, unknown> },
      },
      system: systemPromptFor(req.kind),
      messages: [{ role: "user", content: buildUserPrompt(req) }],
    });
    if (response.stop_reason === "refusal") {
      const category = response.stop_details?.category ?? "unknown";
      throw new ProviderError(`Claude declined this batch (category: ${category})`);
    }
    if (response.stop_reason === "max_tokens") throw new OutputTruncatedError();
    const text = response.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    return parseTranslations(text, req);
  }
}
