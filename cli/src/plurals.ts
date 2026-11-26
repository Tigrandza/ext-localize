/**
 * CLDR plural key families in messages.json, for example
 *   items_one, items_other            (English source)
 *   items_one, items_few, items_many, items_other   (Russian)
 *   items_other                       (Japanese: no "one")
 *
 * Chrome has no plural support, so extensions often store one key per CLDR
 * category and pick it with Intl.PluralRules. Each language has its own set of
 * categories, so the keys differ per locale on purpose.
 *
 * A family is recognised automatically: the source has <base>_other and at least
 * one more <base>_<category> key. Matching is case-insensitive, like Chrome keys.
 */
export const PLURAL_CATEGORIES = ["zero", "one", "two", "few", "many", "other"] as const;
export type PluralCategory = (typeof PLURAL_CATEGORIES)[number];

const SUFFIX_RE = /^(.+)_(zero|one|two|few|many|other)$/i;

/** Split "items_few" into ["items", "few"] (base lower-cased), or null. */
export function splitPluralKey(key: string): { base: string; category: PluralCategory } | null {
  const m = SUFFIX_RE.exec(key);
  return m ? { base: (m[1] as string).toLowerCase(), category: (m[2] as string).toLowerCase() as PluralCategory } : null;
}

/** Lower-cased bases of the plural families in the source keys. */
export function pluralFamilies(sourceKeys: Iterable<string>): Set<string> {
  const byBase = new Map<string, Set<string>>();
  for (const key of sourceKeys) {
    const p = splitPluralKey(key);
    if (!p) continue;
    let set = byBase.get(p.base);
    if (!set) byBase.set(p.base, (set = new Set()));
    set.add(p.category);
  }
  const out = new Set<string>();
  for (const [base, cats] of byBase) if (cats.has("other") && cats.size >= 2) out.add(base);
  return out;
}

const cache = new Map<string, Set<string>>();

/** Plural categories of a Chrome locale ("pt_BR", "no", "zh_CN") from Intl.PluralRules. */
export function pluralCategories(locale: string): Set<string> {
  let cats = cache.get(locale);
  if (!cats) {
    const tag = locale.replace(/_/g, "-");
    try {
      cats = new Set(new Intl.PluralRules(tag).resolvedOptions().pluralCategories as string[]);
    } catch {
      cats = new Set(PLURAL_CATEGORIES);
    }
    cache.set(locale, cats);
  }
  return cats;
}

/** If `key` belongs to a source plural family: its category and whether `locale` uses it. */
export function familyMember(key: string, families: Set<string>, locale: string): { base: string; category: PluralCategory; used: boolean } | null {
  if (!families.size) return null;
  const p = splitPluralKey(key);
  if (!p || !families.has(p.base)) return null;
  return { ...p, used: pluralCategories(locale).has(p.category) };
}
