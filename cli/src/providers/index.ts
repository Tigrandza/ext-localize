import { AnthropicProvider, type Effort } from "./anthropic.ts";
import { DeepLProvider } from "./deepl.ts";
import { OllamaProvider } from "./ollama.ts";
import { OpenAIProvider } from "./openai.ts";
import type { BatchLimits, Provider } from "./types.ts";
import { LLM_LIMITS, ProviderError } from "./types.ts";

export const PROVIDER_NAMES = ["anthropic", "openai", "deepl", "ollama"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

export interface ProviderConfig {
  name: string;
  model?: string;
  effort?: string;
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export function createProvider(cfg: ProviderConfig): Provider {
  switch (cfg.name) {
    case "anthropic": {
      if (cfg.effort && !EFFORTS.includes(cfg.effort)) throw new ProviderError(`--effort must be one of ${EFFORTS.join(", ")}`);
      return new AnthropicProvider({ model: cfg.model, effort: cfg.effort as Effort | undefined });
    }
    case "openai": {
      const model = cfg.model ?? process.env.OPENAI_MODEL;
      if (!model) throw new ProviderError("openai needs a model: pass --model (or set OPENAI_MODEL)");
      return new OpenAIProvider({ model });
    }
    case "ollama": {
      const model = cfg.model ?? process.env.OLLAMA_MODEL;
      if (!model) throw new ProviderError('ollama needs a model: pass --model (see "ollama list")');
      return new OllamaProvider({ model });
    }
    case "deepl":
      return new DeepLProvider();
    default:
      throw new ProviderError(`unknown provider "${cfg.name}". Use one of: ${PROVIDER_NAMES.join(", ")}`);
  }
}

/** Batch limits without building a provider (no key needed). Used by --dry-run. */
export function limitsFor(name: string | undefined): BatchLimits {
  if (name === "deepl") return { maxItems: 50, maxChars: 30000 };
  if (name === "ollama") return { maxItems: 15, maxChars: 3000 };
  return LLM_LIMITS;
}

export type { Provider } from "./types.ts";
