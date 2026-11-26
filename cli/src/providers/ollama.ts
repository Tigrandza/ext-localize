import { fetchJson, withRetry } from "../retry.ts";
import { RESPONSE_SCHEMA, buildUserPrompt, systemPromptFor, parseTranslations } from "./prompt.ts";
import type { BatchRequest, BatchLimits, Provider } from "./types.ts";
import { OutputTruncatedError, ProviderError } from "./types.ts";

export interface OllamaOptions {
  model: string;
  /** Default: OLLAMA_HOST or http://localhost:11434 */
  host?: string;
}

function normalizeHost(host: string): string {
  const withScheme = /^https?:\/\//.test(host) ? host : `http://${host}`;
  return withScheme.replace(/\/+$/, "");
}

/**
 * A local model through Ollama's /api/chat with a JSON schema "format".
 * Nothing leaves your machine. Smaller batches, because small local models
 * lose track of long lists. There is no default model: pass --model.
 */
export class OllamaProvider implements Provider {
  readonly name = "ollama";
  readonly label: string;
  readonly limits: BatchLimits = { maxItems: 15, maxChars: 3000 };
  private readonly model: string;
  private readonly host: string;

  constructor(opts: OllamaOptions) {
    this.model = opts.model;
    this.host = normalizeHost(opts.host ?? process.env.OLLAMA_HOST ?? "http://localhost:11434");
    this.label = `ollama/${this.model}`;
  }

  async translateBatch(req: BatchRequest): Promise<Record<string, string>> {
    const body = {
      model: this.model,
      stream: false,
      format: RESPONSE_SCHEMA,
      options: { temperature: 0 },
      messages: [
        { role: "system", content: systemPromptFor(req.kind) },
        { role: "user", content: buildUserPrompt(req) },
      ],
    };
    let data: { message?: { content?: string }; done_reason?: string };
    try {
      data = (await withRetry(
        () => fetchJson(`${this.host}/api/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
        { retries: 2 },
      )) as typeof data;
    } catch (e) {
      if (e instanceof TypeError) throw new ProviderError(`cannot reach Ollama at ${this.host}. Is "ollama serve" running?`);
      throw e;
    }
    if (data.done_reason === "length") throw new OutputTruncatedError();
    return parseTranslations(data.message?.content ?? "", req);
  }
}
