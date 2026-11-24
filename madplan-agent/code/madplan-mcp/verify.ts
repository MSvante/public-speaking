/** Checks that a recipe to be saved is fully contained in the text the family member posted. */
export function norm(t: string): string {
  return t.normalize('NFKC').toLowerCase()
    .replace(/[‘’“”"'`´]/g, '').replace(/[–—−]/g, '-')
    .split('\n').map((l) => l.replace(/^\s*(?:\d+\s*[.):]|[-*•–])\s+/, '')).join(' ')
    .replace(/[*_~#>]/g, '').replace(/\s+/g, ' ').trim();
}
export const FRACTIONS: Record<string, string[]> = { '0.5': ['½', '1/2'], '0.25': ['¼', '1/4'], '0.75': ['¾', '3/4'], '1.5': ['1½', '1 1/2'], '0.33': ['⅓', '1/3'] };
export function amountForms(n: number): string[] {
  const s = String(n);
  return [s, s.replace('.', ','), ...(FRACTIONS[s] ?? [])].map(norm);
}


export type UserRecipe = {
  title: string; description?: string; servings?: number; prep_time?: number; cook_time?: number;
  ingredients: { name: string; amount?: number | null; unit?: string | null }[];
  instructions: string[];
};

/** Everything in `r` that cannot be found in `source`; empty = OK. */
export function findMissing(source: string, r: UserRecipe): string[] {
  const text = norm(source);
  const missing: string[] = [];
  if (!text.includes(norm(r.title))) missing.push(`title "${r.title}"`);
  if (r.description && !text.includes(norm(r.description))) missing.push('description (must be their words)');
  for (const i of r.ingredients) {
    if (!text.includes(norm(i.name))) missing.push(`ingredient "${i.name}"`);
    if (i.amount != null && !amountForms(i.amount).some((f) => text.includes(f))) missing.push(`amount ${i.amount} for "${i.name}"`);
    if (i.unit && !text.includes(norm(i.unit))) missing.push(`unit "${i.unit}" for "${i.name}"`);
  }
  for (const [n, step] of r.instructions.entries())
    if (!text.includes(norm(step))) missing.push(`step ${n + 1} "${step.slice(0, 60)}"`);
  for (const [k, v] of [['servings', r.servings], ['prep_time', r.prep_time], ['cook_time', r.cook_time]] as const)
    if (v != null && !new RegExp(`(^|\\D)${v}(\\D|$)`).test(text)) missing.push(`${k} ${v}`);
  return missing;
}
