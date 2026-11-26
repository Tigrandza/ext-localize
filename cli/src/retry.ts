/** HTTP error with enough detail to decide whether to retry. */
export class HttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;
  constructor(status: number, message: string, retryAfterMs: number | null = null) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Parse a Retry-After header (seconds or HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

/** 429 (rate limit), 408, 5xx and network failures are worth retrying. */
export function isRetryable(err: unknown): boolean {
  if (err instanceof HttpError) return err.status === 429 || err.status === 408 || err.status >= 500;
  // fetch() throws TypeError on network failures (DNS, connection reset).
  return err instanceof TypeError;
}

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run fn, retrying on rate limits and transient errors with exponential
 * backoff and jitter. A Retry-After header wins over the computed delay.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 5;
  const base = opts.baseDelayMs ?? 1000;
  const max = opts.maxDelayMs ?? 60_000;
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) throw err;
      const backoff = Math.min(max, base * 2 ** attempt) * (0.5 + Math.random() / 2);
      const delay = err instanceof HttpError && err.retryAfterMs !== null ? Math.min(max, err.retryAfterMs) : backoff;
      opts.onRetry?.(attempt + 1, delay, err);
      await sleep(delay);
    }
  }
}

/** fetch + JSON with HttpError on non-2xx. */
export async function fetchJson(url: string, init: RequestInit): Promise<unknown> {
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) {
    throw new HttpError(res.status, `${init.method ?? "GET"} ${url} -> HTTP ${res.status}: ${text.slice(0, 300)}`, parseRetryAfter(res.headers.get("retry-after")));
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${url}: response is not JSON: ${text.slice(0, 200)}`);
  }
}
