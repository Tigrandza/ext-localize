/** One string to translate. `text` already has markers instead of format tokens. */
export interface TranslationItem {
  key: string;
  text: string;
  /** The message "description" from messages.json, passed as context. */
  description?: string;
  /** What each marker stands for, e.g. `<x id="0"/> = $count$ (example: "3")`. */
  markerHints?: string[];
}

/** DeepL's formality values. LLM providers get them as a tone instruction. */
export const FORMALITIES = ["default", "more", "less", "prefer_more", "prefer_less"] as const;
export type Formality = (typeof FORMALITIES)[number];

/** Everything about a request except the strings. */
export interface LocaleRequest {
  sourceLocale: string;
  targetLocale: string;
  /** Fixed glossary translations for this locale: [term, translation]. */
  terms: [string, string][];
  formality?: Formality;
  /** What is translated: UI messages (default) or store listing text. Changes the instructions. */
  kind?: "messages" | "listing";
}

export interface BatchRequest extends LocaleRequest {
  items: TranslationItem[];
}

export interface BatchLimits {
  /** Max strings per request. */
  maxItems: number;
  /** Max characters of text + description per request (rough size guard). */
  maxChars: number;
}

export interface Provider {
  /** Short id: "anthropic", "openai", "deepl", "ollama". */
  readonly name: string;
  /** Recorded in state.json as "by", e.g. "anthropic/claude-opus-5-5". */
  readonly label: string;
  readonly limits: BatchLimits;
  /** Optional: return false for locales the provider cannot translate into. */
  supportsLocale?(locale: string): Promise<boolean>;
  /**
   * Optional: called once per locale before its first batch (for example to
   * create a server-side glossary). Returns notes to show the user.
   */
  prepareLocale?(req: LocaleRequest): Promise<string[]>;
  /**
   * Translate a batch. Returns key -> translated text (still with markers).
   * Keys may be missing from the result; the caller retries or reports them.
   */
  translateBatch(req: BatchRequest): Promise<Record<string, string>>;
}

/** The response was cut off (output token limit). The caller splits the batch. */
export class OutputTruncatedError extends Error {
  constructor(message = "response was cut off before the end") {
    super(message);
    this.name = "OutputTruncatedError";
  }
}

/** Provider refused or returned something unusable. Not retried as-is. */
export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Default limits for LLM providers: many keys per call, bounded output size. */
export const LLM_LIMITS: BatchLimits = { maxItems: 40, maxChars: 8000 };
