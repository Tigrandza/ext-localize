import type { BatchLimits, TranslationItem } from "./providers/types.ts";

export function itemSize(item: TranslationItem): number {
  return item.text.length + (item.description?.length ?? 0) + (item.markerHints?.join("").length ?? 0);
}

/**
 * Group items into batches: at most maxItems per batch and roughly maxChars
 * of text. An item bigger than maxChars gets its own batch.
 */
export function makeBatches(items: TranslationItem[], limits: BatchLimits): TranslationItem[][] {
  const batches: TranslationItem[][] = [];
  let current: TranslationItem[] = [];
  let size = 0;
  for (const item of items) {
    const s = itemSize(item);
    if (current.length > 0 && (current.length >= limits.maxItems || size + s > limits.maxChars)) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += s;
  }
  if (current.length) batches.push(current);
  return batches;
}
