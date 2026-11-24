/**
 * madplan MCP (stdio): the household's meal plan, own recipes and shopping list in
 * Opskrifter (the family's recipe site on Supabase). Logs in as a dedicated bot user, so Row
 * Level Security applies: it only sees what the household shares.
 * Credentials: environment (inherited from the bot), else the env file in MADPLAN_ENV or
 * ~/.config/madplan-agent/env (chmod 600). See ../../.env.example.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { findMissing } from './verify.ts';


const LIST_NAME = 'Indkøbsliste';
const TZ = 'Europe/Copenhagen';
const DAYS = ['mandag', 'tirsdag', 'onsdag', 'torsdag', 'fredag', 'lørdag', 'søndag'];
// "Ingen aftensmad" marker (Opskrifter migration 006): a meal_plans row that is not a meal.
const NO_DINNER_SOURCE = 'ingen';
const NO_DINNER_TITLE = 'Ingen aftensmad';
const isNoDinner = (m: { source?: string | null }) => m.source === NO_DINNER_SOURCE;

// ---------- config + auth ----------
const env: Record<string, string> = {};
try {
  const file = process.env.MADPLAN_ENV ?? join(homedir(), '.config', 'madplan-agent', 'env');
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0 && !line.trimStart().startsWith('#')) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
} catch { /* no file: rely on process.env */ }
for (const k of ['SUPABASE_URL', 'SUPABASE_KEY', 'MADPLAN_EMAIL', 'MADPLAN_PASSWORD', 'MADPLAN_SITE'])
  if (process.env[k]) env[k] = process.env[k]!;
const SITE = (env.MADPLAN_SITE ?? 'https://example.com').replace(/\/$/, '');

const sb: SupabaseClient = createClient(env.SUPABASE_URL!, env.SUPABASE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: true },
});
let userId: string | null = null;

async function db(): Promise<SupabaseClient> {
  if (!userId) {
    const { data, error } = await sb.auth.signInWithPassword({
      email: env.MADPLAN_EMAIL!, password: env.MADPLAN_PASSWORD!,
    });
    if (error || !data.user) throw new Error(`Supabase login failed: ${error?.message}`);
    userId = data.user.id;
  }
  return sb;
}

// ---------- dates (all in Copenhagen) ----------
function todayKey(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date()); // YYYY-MM-DD
}
function addDays(key: string, n: number): string {
  const d = new Date(`${key}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function weekday(key: string): number {
  return (new Date(`${key}T12:00:00Z`).getUTCDay() + 6) % 7; // 0 = mandag
}
function mondayOf(key: string): string {
  return addDays(key, -weekday(key));
}
const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

// ---------- helpers ----------
type Ingredient = { name: string; amount: number | null; unit: string | null; notes?: string | null };

const ok = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 1) }] });
const fail = (msg: string) => ({ content: [{ type: 'text' as const, text: msg }], isError: true });

function wrap<A>(fn: (args: A) => Promise<unknown>) {
  return async (args: A) => {
    try {
      return ok(await fn(args));
    } catch (e) {
      return fail(String(e instanceof Error ? e.message : e));
    }
  };
}

async function memberNames(c: SupabaseClient): Promise<Map<string, string>> {
  const { data } = await c.from('profiles').select('id, name');
  return new Map((data ?? []).map((p) => [p.id as string, (p.name as string) ?? 'ukendt']));
}

async function defaultListId(c: SupabaseClient, create: boolean): Promise<string | null> {
  const { data, error } = await c.from('shopping_lists').select('id').eq('name', LIST_NAME)
    .order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (error) throw new Error(error.message);
  if (data) return data.id as string;
  if (!create) return null;
  const ins = await c.from('shopping_lists').insert({ user_id: userId, name: LIST_NAME }).select('id').single();
  if (ins.error) throw new Error(ins.error.message);
  return ins.data.id as string;
}

const MEAL_SELECT =
  'id, date, servings, title, source, external_id, source_url, notes, user_id, created_at, ' +
  'recipes (id, title, servings, prep_time, cook_time)';

function shapeMeal(m: any, names: Map<string, string>) {
  return {
    id: m.id,
    date: m.date,
    dag: DAYS[weekday(m.date)],
    title: m.recipes?.title ?? m.title,
    source: m.source,
    recipe_id: m.recipes?.id ?? null,
    link: m.recipes ? `${SITE}/recipes/${m.recipes.id}` : m.source_url,
    external_id: m.external_id,
    servings: m.servings ?? m.recipes?.servings ?? null,
    minutes: m.recipes ? (m.recipes.prep_time ?? 0) + (m.recipes.cook_time ?? 0) || null : null,
    notes: m.notes,
    added_by: names.get(m.user_id) ?? 'ukendt',
  };
}

// ---------- weekly flow state (shared with madplan-bot) ----------
// The bot writes last_turn.json before every claude run ({ who, kind: 'human' | 'system', at }).
// Approvals are only accepted when the current turn is a human's.
const STATE_DIR = join(homedir(), '.local', 'state', 'madplan');
const WEEKLY = join(STATE_DIR, 'weekly.json');
const LAST_TURN = join(STATE_DIR, 'last_turn.json');
const STAGES = ['idle', 'plan_proposed', 'plan_approved', 'list_proposed', 'list_approved', 'cart_filled', 'done'] as const;
type Stage = (typeof STAGES)[number];
type Weekly = {
  week_start: string | null; stage: Stage; updated_at: string | null;
  plan_summary?: string | null; final_store?: string | null; final_total?: number | null; cart_url?: string | null;
  history: { stage: Stage; at: string; by: string }[];
};

function readJson<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return fallback; }
}
function readWeekly(): Weekly {
  return readJson<Weekly>(WEEKLY, { week_start: null, stage: 'idle', updated_at: null, history: [] });
}
function writeWeekly(w: Weekly) {
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${WEEKLY}.tmp`;
  writeFileSync(tmp, JSON.stringify(w, null, 1), { mode: 0o600 });
  renameSync(tmp, WEEKLY);
}

/** Every Mon–Fri of the week must have a real recipe: own (recipe_id) or a store recipe with an id/link. */
async function checkWeekPlan(c: SupabaseClient, start: string): Promise<string[]> {
  const { data, error } = await c.from('meal_plans').select('date, recipe_id, source, external_id, source_url, title')
    .gte('date', start).lte('date', addDays(start, 4));
  if (error) throw new Error(error.message);
  const problems: string[] = [];
  for (let i = 0; i < 5; i++) {
    const d = addDays(start, i);
    const meals = (data ?? []).filter((m: any) => m.date === d);
    if (meals.some(isNoDinner)) {
      // A day marked "Ingen aftensmad" needs no recipe, but must not also hold dishes.
      const others = meals.filter((m: any) => !isNoDinner(m));
      if (others.length) problems.push(`${DAYS[i]} ${d}: marked "${NO_DINNER_TITLE}" but also has: ${others.map((m: any) => m.title ?? 'own recipe').join(', ')} – remove one`);
      continue;
    }
    const real = meals.filter((m: any) => m.recipe_id ||
      (['nemlig', 'bilkatogo'].includes(m.source) && (m.external_id || m.source_url)));
    if (!real.length) problems.push(`${DAYS[i]} ${d}: no store recipe (nemlig/bilkatogo with external_id/source_url) or own recipe`);
    const fake = meals.filter((m: any) => !real.includes(m));
    if (fake.length) problems.push(`${DAYS[i]} ${d}: remove non-recipe meal(s): ${fake.map((m: any) => m.title).join(', ')}`);
  }
  return problems;
}

// ---------- server ----------
const server = new McpServer({ name: 'madplan', version: '1.0.0' }, {
  instructions:
    "The household's meal plan, own recipes (Opskrifter) and shared shopping list. " +
    'Dates are Europe/Copenhagen, weeks run mandag–søndag. A meal is either an own recipe (recipe_id) ' +
    'or a store/free-text meal (title + source nemlig|bilkatogo|rema1000|fri, optionally external_id ' +
    'and source_url from the handle tools). A row with source "ingen" / title "' + NO_DINNER_TITLE + '" is not a meal: ' +
    'it marks a day with no dinner (set with mark_no_dinner, undo with remove_meal). Put ingredient swaps and tweaks in notes ("kylling → tofu"), ' +
    'never edit the recipe itself. Recipe links: ' + SITE + '/recipes/<id>.',
});

server.registerTool('get_week', {
  description: 'Meal plan for one week (mandag–søndag). week_offset 0 = this week, 1 = next week, -1 = last week.',
  inputSchema: { week_offset: z.number().int().min(-8).max(8).default(0) },
}, wrap(async ({ week_offset }: { week_offset: number }) => {
  const c = await db();
  const start = addDays(mondayOf(todayKey()), 7 * week_offset);
  const end = addDays(start, 6);
  const [{ data, error }, names] = await Promise.all([
    c.from('meal_plans').select(MEAL_SELECT).gte('date', start).lte('date', end)
      .order('date').order('created_at'),
    memberNames(c),
  ]);
  if (error) throw new Error(error.message);
  return { today: todayKey(), week: { start, end }, meals: (data ?? []).map((m) => shapeMeal(m, names)) };
}));

server.registerTool('search_own_recipes', {
  description: "Search the household's own recipes (Opskrifter). Matches title/description/ingredient names; " +
    'optional tag (e.g. Aftensmad, Vegetarisk, Pasta, Fisk, Kylling). Empty query lists recipes.',
  inputSchema: {
    query: z.string().max(100).default(''),
    tag: z.string().max(50).optional(),
    limit: z.number().int().min(1).max(60).default(20),
  },
}, wrap(async ({ query, tag, limit }: { query: string; tag?: string; limit: number }) => {
  const c = await db();
  const { data, error } = await c.from('recipes')
    .select('id, title, description, prep_time, cook_time, servings, is_favorite, ingredients (name), recipe_tags (tags (name))')
    .eq('type', 'standard').order('title');
  if (error) throw new Error(error.message);
  const q = query.trim().toLowerCase();
  const t = tag?.trim().toLowerCase();
  const hits = (data ?? []).filter((r: any) => {
    const tags: string[] = r.recipe_tags.map((x: any) => x.tags?.name).filter(Boolean);
    if (t && !tags.some((x) => x.toLowerCase() === t)) return false;
    if (!q) return true;
    const hay = [r.title, r.description ?? '', ...r.ingredients.map((i: any) => i.name)].join(' ').toLowerCase();
    return q.split(/\s+/).every((w) => hay.includes(w));
  });
  return hits.slice(0, limit).map((r: any) => ({
    id: r.id, title: r.title,
    tags: r.recipe_tags.map((x: any) => x.tags?.name).filter(Boolean),
    minutes: (r.prep_time ?? 0) + (r.cook_time ?? 0) || null,
    servings: r.servings, favorite: r.is_favorite, link: `${SITE}/recipes/${r.id}`,
  }));
}));

server.registerTool('get_own_recipe', {
  description: 'Full own recipe: ingredients (with amounts), instructions, servings, link.',
  inputSchema: { recipe_id: z.string().uuid() },
}, wrap(async ({ recipe_id }: { recipe_id: string }) => {
  const c = await db();
  const { data, error } = await c.from('recipes')
    .select('id, title, description, prep_time, cook_time, servings, instructions, ingredients (name, amount, unit, notes, position)')
    .eq('id', recipe_id).single();
  if (error) throw new Error(error.message);
  const ingredients = [...(data.ingredients as any[])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map(({ name, amount, unit, notes }) => ({ name, amount, unit, notes }));
  return { ...data, ingredients, link: `${SITE}/recipes/${data.id}` };
}));

server.registerTool('plan_meal', {
  description: 'Add a meal to a date. Either recipe_id (own recipe) OR title (+ source, external_id, source_url ' +
    'for store recipes from the handle tools; source "fri" for e.g. "Rester", "Pizza ude"). notes = tweaks/swaps.',
  inputSchema: {
    date: dateKey,
    recipe_id: z.string().uuid().optional(),
    title: z.string().min(1).max(200).optional(),
    source: z.enum(['opskrifter', 'nemlig', 'bilkatogo', 'rema1000', 'fri']).optional(),
    external_id: z.string().max(200).optional(),
    source_url: z.string().url().regex(/^https?:\/\//).optional(),
    servings: z.number().int().min(1).max(30).optional(),
    notes: z.string().max(500).optional(),
  },
}, wrap(async (a: any) => {
  if (!a.recipe_id && !a.title) throw new Error('Give either recipe_id or title.');
  const c = await db();
  await refuseIfNoDinner(c, a.date);
  const row = {
    user_id: userId, date: a.date, recipe_id: a.recipe_id ?? null,
    title: a.recipe_id ? null : a.title,
    source: a.recipe_id ? 'opskrifter' : (a.source && a.source !== 'opskrifter' ? a.source : 'fri'),
    external_id: a.external_id ?? null, source_url: a.source_url ?? null,
    servings: a.servings ?? null, notes: a.notes ?? null,
  };
  const { data, error } = await c.from('meal_plans').insert(row).select(MEAL_SELECT).single();
  if (error) throw new Error(error.code === '23505' ? 'That recipe is already planned on that date.' : error.message);
  return shapeMeal(data, await memberNames(c));
}));

server.registerTool('update_meal', {
  description: 'Change a planned meal: move date, change servings, set notes (swaps/tweaks; replaces existing notes), ' +
    'or replace the dish (recipe_id, or title/source/external_id/source_url). Use the meal id from get_week.',
  inputSchema: {
    meal_id: z.string().uuid(),
    date: dateKey.optional(),
    servings: z.number().int().min(1).max(30).nullable().optional(),
    notes: z.string().max(500).nullable().optional(),
    recipe_id: z.string().uuid().optional(),
    title: z.string().min(1).max(200).optional(),
    source: z.enum(['nemlig', 'bilkatogo', 'rema1000', 'fri']).optional(),
    external_id: z.string().max(200).nullable().optional(),
    source_url: z.string().url().regex(/^https?:\/\//).nullable().optional(),
  },
}, wrap(async (a: any) => {
  const c = await db();
  const patch: Record<string, unknown> = {};
  for (const k of ['date', 'servings', 'notes'] as const) if (a[k] !== undefined) patch[k] = a[k];
  if (a.recipe_id) Object.assign(patch, { recipe_id: a.recipe_id, title: null, source: 'opskrifter', external_id: null, source_url: null });
  else if (a.title) Object.assign(patch, {
    recipe_id: null, title: a.title, source: a.source ?? 'fri',
    external_id: a.external_id ?? null, source_url: a.source_url ?? null,
  });
  if (!Object.keys(patch).length) throw new Error('Nothing to change.');
  const cur = await c.from('meal_plans').select('source').eq('id', a.meal_id).maybeSingle();
  if (cur.error) throw new Error(cur.error.message);
  if (cur.data && isNoDinner(cur.data))
    throw new Error(`That is a "${NO_DINNER_TITLE}" marker, not a meal. Remove it with remove_meal first, then plan_meal.`);
  if (a.date) await refuseIfNoDinner(c, a.date);
  const { data, error } = await c.from('meal_plans').update(patch).eq('id', a.meal_id).select(MEAL_SELECT).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error('Meal not found.');
  return shapeMeal(data, await memberNames(c));
}));

server.registerTool('mark_no_dinner', {
  description: `Mark a date as "${NO_DINNER_TITLE}" (alone at home, eating out, away). The day then needs no recipe ` +
    'in the weekly plan and adds nothing to the shopping list. Only when a human asked for it in this message. ' +
    'The day must be empty: remove its meal first (remove_meal). Undo: remove_meal on the marker id from get_week.',
  inputSchema: { date: dateKey },
}, wrap(async ({ date }: { date: string }) => {
  const turn = readJson<{ kind?: string }>(LAST_TURN, {});
  if (turn.kind !== 'human') throw new Error('Refused: only when a human asks for a day without dinner. Ask them.');
  const c = await db();
  const { data: existing, error: e1 } = await c.from('meal_plans').select('id, title, source').eq('date', date);
  if (e1) throw new Error(e1.message);
  if (existing?.some(isNoDinner)) return { already_marked: date };
  if (existing?.length)
    throw new Error(`${date} already has: ${existing.map((m: any) => m.title ?? 'own recipe').join(', ')}. Remove it first (remove_meal) if they want no dinner.`);
  const { data, error } = await c.from('meal_plans')
    .insert({ user_id: userId, date, source: NO_DINNER_SOURCE, title: NO_DINNER_TITLE })
    .select(MEAL_SELECT).single();
  if (error) throw new Error(error.message);
  return shapeMeal(data, await memberNames(c));
}));

async function refuseIfNoDinner(c: SupabaseClient, date: string) {
  const { data, error } = await c.from('meal_plans').select('id').eq('date', date).eq('source', NO_DINNER_SOURCE).limit(1);
  if (error) throw new Error(error.message);
  if (data?.length)
    throw new Error(`${date} is marked "${NO_DINNER_TITLE}". Only if a human wants a dish there: remove_meal(${data[0].id}) first.`);
}

server.registerTool('remove_meal', {
  description: 'Remove a planned meal by id.',
  inputSchema: { meal_id: z.string().uuid() },
}, wrap(async ({ meal_id }: { meal_id: string }) => {
  const c = await db();
  const { data, error } = await c.from('meal_plans').delete().eq('id', meal_id).select('id');
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error('Meal not found.');
  return { removed: meal_id };
}));

server.registerTool('week_ingredients', {
  description: 'Aggregated ingredients for the own-recipe meals of a week, scaled to servings. Does NOT change ' +
    'anything. Store/free-text meals are listed separately (get their ingredients via the handle tools). ' +
    'Apply swaps from notes yourself before adding to the shopping list.',
  inputSchema: { week_offset: z.number().int().min(-8).max(8).default(0) },
}, wrap(async ({ week_offset }: { week_offset: number }) => {
  const c = await db();
  const start = addDays(mondayOf(todayKey()), 7 * week_offset);
  const { data, error } = await c.from('meal_plans')
    .select('date, servings, title, source, external_id, notes, recipes (title, servings, ingredients (name, amount, unit))')
    .gte('date', start).lte('date', addDays(start, 6)).order('date');
  if (error) throw new Error(error.message);
  const agg = new Map<string, Ingredient & { for: string[] }>();
  const other: unknown[] = [];
  const notes: unknown[] = [];
  for (const m of (data ?? []) as any[]) {
    if (isNoDinner(m)) continue;
    if (m.notes) notes.push({ date: m.date, meal: m.recipes?.title ?? m.title, notes: m.notes });
    if (!m.recipes) { other.push({ date: m.date, title: m.title, source: m.source, external_id: m.external_id }); continue; }
    const k = m.servings && m.recipes.servings ? m.servings / m.recipes.servings : 1;
    for (const i of m.recipes.ingredients as Ingredient[]) {
      const key = `${i.name.toLowerCase()}|${i.unit ?? ''}`;
      const cur = agg.get(key);
      const amt = i.amount == null ? null : Math.round(i.amount * k * 100) / 100;
      if (cur) {
        cur.amount = cur.amount != null && amt != null ? Math.round((cur.amount + amt) * 100) / 100 : cur.amount ?? amt;
        if (!cur.for.includes(m.recipes.title)) cur.for.push(m.recipes.title);
      } else agg.set(key, { name: i.name, amount: amt, unit: i.unit, for: [m.recipes.title] });
    }
  }
  return { week_start: start, ingredients: [...agg.values()], notes_to_apply: notes, non_recipe_meals: other };
}));

server.registerTool('get_shopping_list', {
  description: "The household's shared shopping list (also shown on " + SITE + '/shopping-list).',
  inputSchema: { include_checked: z.boolean().default(false) },
}, wrap(async ({ include_checked }: { include_checked: boolean }) => {
  const c = await db();
  const listId = await defaultListId(c, false);
  if (!listId) return { items: [] };
  let q = c.from('shopping_list_items').select('id, name, amount, unit, is_checked').eq('shopping_list_id', listId).order('position');
  if (!include_checked) q = q.eq('is_checked', false);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return { items: data };
}));

server.registerTool('add_to_shopping_list', {
  description: 'Add items to the shared shopping list. Same name+unit as an unchecked item is merged (amounts summed).',
  inputSchema: {
    items: z.array(z.object({
      name: z.string().min(1).max(120),
      amount: z.number().positive().nullable().optional(),
      unit: z.string().max(30).nullable().optional(),
    })).min(1).max(100),
  },
}, wrap(async ({ items }: { items: { name: string; amount?: number | null; unit?: string | null }[] }) => {
  const c = await db();
  const listId = (await defaultListId(c, true))!;
  const { data: existing, error } = await c.from('shopping_list_items')
    .select('id, name, unit, amount, position, is_checked').eq('shopping_list_id', listId);
  if (error) throw new Error(error.message);
  let pos = (existing ?? []).reduce((m, i: any) => Math.max(m, i.position ?? 0), -1) + 1;
  let added = 0, merged = 0;
  for (const it of items) {
    const unit = it.unit || null;
    const amount = it.amount ?? null;
    const hit = (existing ?? []).find((e: any) => !e.is_checked &&
      e.name.toLowerCase() === it.name.toLowerCase() && (e.unit || null) === unit) as any;
    if (hit) {
      if (hit.amount != null && amount != null) {
        hit.amount = Math.round((Number(hit.amount) + amount) * 100) / 100;
        const u = await c.from('shopping_list_items').update({ amount: hit.amount }).eq('id', hit.id);
        if (u.error) throw new Error(u.error.message);
      }
      merged++;
    } else {
      const ins = await c.from('shopping_list_items').insert({
        shopping_list_id: listId, name: it.name, amount, unit, position: pos++,
      }).select('id, name, unit, amount, position, is_checked').single();
      if (ins.error) throw new Error(ins.error.message);
      existing!.push(ins.data);
      added++;
    }
  }
  return { added, merged };
}));

server.registerTool('update_shopping_items', {
  description: 'Check off, uncheck or remove shopping list items by id (ids from get_shopping_list).',
  inputSchema: {
    item_ids: z.array(z.string().uuid()).min(1).max(100),
    action: z.enum(['check', 'uncheck', 'remove']),
  },
}, wrap(async ({ item_ids, action }: { item_ids: string[]; action: 'check' | 'uncheck' | 'remove' }) => {
  const c = await db();
  const q = action === 'remove'
    ? c.from('shopping_list_items').delete().in('id', item_ids).select('id')
    : c.from('shopping_list_items').update({ is_checked: action === 'check' }).in('id', item_ids).select('id');
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return { [action]: data?.length ?? 0 };
}));

server.registerTool('get_weekly_status', {
  description: 'State of the weekly Friday flow (plan → approve → shopping list → approve → cart). ' +
    'week_start is the Monday being planned.',
  inputSchema: {},
}, wrap(async () => ({ ...readWeekly(), today: todayKey(), next_week_start: addDays(mondayOf(todayKey()), 7) })));

server.registerTool('set_weekly_stage', {
  description: 'Advance the weekly flow. Order: plan_proposed → plan_approved → list_proposed → list_approved → ' +
    'cart_filled → done (going back, e.g. list_proposed → plan_proposed after a meal change, is allowed). ' +
    'plan_* stages are refused unless Mon–Fri of week_start each have a real store/own recipe. ' +
    '*_approved stages are only accepted while answering a human message that approves. ' +
    'Store plan_summary (meals + price per store) at plan_proposed; final_store/final_total/cart_url at cart_filled.',
  inputSchema: {
    stage: z.enum(STAGES),
    week_start: dateKey.optional(),
    plan_summary: z.string().max(2000).optional(),
    final_store: z.enum(['nemlig', 'bilkatogo', 'rema1000']).optional(),
    final_total: z.number().nonnegative().optional(),
    cart_url: z.string().url().optional(),
  },
}, wrap(async (a: any) => {
  const w = readWeekly();
  const turn = readJson<{ who?: string; kind?: string }>(LAST_TURN, {});
  const stage = a.stage as Stage;
  const week = a.week_start ?? w.week_start ?? addDays(mondayOf(todayKey()), 7);
  if (weekday(week) !== 0) throw new Error('week_start must be a Monday.');
  if (week !== w.week_start && stage !== 'plan_proposed' && stage !== 'idle')
    throw new Error(`A new week (${week}) must start at plan_proposed.`);
  if (stage.endsWith('_approved') && turn.kind !== 'human')
    throw new Error('Approval refused: only a human message can approve. Ask them.');
  const from = week === w.week_start ? STAGES.indexOf(w.stage) : 0;
  const to = STAGES.indexOf(stage);
  if (to > from + 1 && stage !== 'done' && stage !== 'idle')
    throw new Error(`Cannot jump from ${w.stage} to ${stage}.`);
  if (stage === 'cart_filled' && (!a.final_store || !a.cart_url))
    throw new Error('cart_filled needs final_store and cart_url.');
  if (stage.startsWith('plan_') || stage === 'list_proposed') {
    const problems = await checkWeekPlan(await db(), week);
    if (problems.length) throw new Error('Plan not valid:\n' + problems.join('\n'));
  }
  const now = new Date().toISOString();
  const next: Weekly = {
    ...(week === w.week_start ? w : { history: [] }),
    week_start: week, stage, updated_at: now,
    history: [...(week === w.week_start ? w.history : []), { stage, at: now, by: turn.who ?? 'ukendt' }],
  } as Weekly;
  for (const k of ['plan_summary', 'final_store', 'final_total', 'cart_url'] as const) if (a[k] !== undefined) (next as any)[k] = a[k];
  writeWeekly(next);
  return next;
}));

server.registerTool('recent_meals', {
  description: 'Meals planned in the last N weeks (to avoid repeating recipes).',
  inputSchema: { weeks: z.number().int().min(1).max(12).default(4) },
}, wrap(async ({ weeks }: { weeks: number }) => {
  const c = await db();
  const { data, error } = await c.from('meal_plans').select('date, title, source, external_id, recipes (title)')
    .gte('date', addDays(mondayOf(todayKey()), -7 * weeks)).order('date');
  if (error) throw new Error(error.message);
  return (data ?? []).filter((m: any) => !isNoDinner(m)).map((m: any) => ({ date: m.date, title: m.recipes?.title ?? m.title, source: m.source, external_id: m.external_id }));
}));

server.registerTool('remove_checked_shopping_items', {
  description: 'Remove all checked-off items from the shared shopping list (leftovers from last week). Unchecked items stay.',
  inputSchema: {},
}, wrap(async () => {
  const c = await db();
  const listId = await defaultListId(c, false);
  if (!listId) return { removed: 0 };
  const { data, error } = await c.from('shopping_list_items').delete().eq('shopping_list_id', listId).eq('is_checked', true).select('id');
  if (error) throw new Error(error.message);
  return { removed: data?.length ?? 0 };
}));

// ---------- recipe import ----------
function slugify(t: string): string {
  return t.toLowerCase().replace(/æ/g, 'ae').replace(/ø/g, 'oe').replace(/å/g, 'aa')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
}

server.registerTool('import_store_recipe', {
  description: 'Save a store recipe (from handle get_recipe) as a real recipe in Opskrifter, so it shows in the app. ' +
    'Copy title, description, image, times, servings, ingredients (name/amount/unit as the recipe lists them, scaled ' +
    'to `servings`) and the method steps EXACTLY from get_recipe — do not invent or rewrite. Tags must be existing ' +
    'tag names (unknown ones are ignored). Idempotent per (source, external_id): returns the existing recipe if ' +
    'already imported. Then link the meal with update_meal(meal_id, recipe_id).',
  inputSchema: {
    source: z.enum(['nemlig', 'bilkatogo', 'rema1000']),
    external_id: z.string().min(1).max(200),
    source_url: z.string().url().regex(/^https?:\/\//),
    title: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    image_url: z.string().url().regex(/^https:\/\//).optional(),
    prep_time: z.number().int().min(0).max(1440).optional(),
    cook_time: z.number().int().min(0).max(1440).optional(),
    servings: z.number().int().min(1).max(30),
    ingredients: z.array(z.object({
      name: z.string().min(1).max(120),
      amount: z.number().positive().nullable().optional(),
      unit: z.string().max(30).nullable().optional(),
      notes: z.string().max(200).nullable().optional(),
    })).min(1).max(80),
    instructions: z.array(z.string().min(1).max(2000)).min(1).max(40),
    tags: z.array(z.string().max(50)).max(10).default([]),
  },
}, wrap(async (a: any) => {
  const c = await db();
  const existing = await c.from('recipes').select('id, title').eq('source', a.source).eq('external_id', a.external_id).maybeSingle();
  if (existing.error) throw new Error(existing.error.message);
  if (existing.data) return { recipe_id: existing.data.id, title: existing.data.title, already_imported: true, link: `${SITE}/recipes/${existing.data.id}` };

  const { data: allTags, error: tagErr } = await c.from('tags').select('id, name');
  if (tagErr) throw new Error(tagErr.message);
  const byName = new Map((allTags ?? []).map((t: any) => [t.name.toLowerCase(), t.id as string]));
  const tagIds = [...new Set((a.tags as string[]).map((t) => byName.get(t.toLowerCase())).filter(Boolean))] as string[];
  const ignored = (a.tags as string[]).filter((t) => !byName.has(t.toLowerCase()));

  let recipe: any = null;
  for (let attempt = 0; attempt < 3 && !recipe; attempt++) {
    const slug = `${slugify(a.title)}-${Math.random().toString(36).slice(2, 8)}`;
    const ins = await c.from('recipes').insert({
      title: a.title, slug, description: a.description ?? null, instructions: a.instructions,
      prep_time: a.prep_time ?? null, cook_time: a.cook_time ?? null, servings: a.servings,
      image_url: a.image_url ?? null, author_id: userId, type: 'standard',
      source: a.source, external_id: a.external_id, source_url: a.source_url,
    }).select('id').single();
    if (ins.error && ins.error.code !== '23505') throw new Error(ins.error.message);
    if (ins.error?.message.includes('external_id')) throw new Error('Already imported (race) — call again.');
    recipe = ins.data;
  }
  if (!recipe) throw new Error('Could not create a unique slug.');

  const ingr = await c.from('ingredients').insert((a.ingredients as Ingredient[]).map((i, pos) => ({
    recipe_id: recipe.id, name: i.name, amount: i.amount ?? null, unit: i.unit ?? null, notes: i.notes ?? null, position: pos,
  })));
  if (ingr.error) {
    await c.from('recipes').delete().eq('id', recipe.id);
    throw new Error(`Ingredients failed, recipe rolled back: ${ingr.error.message}`);
  }
  if (tagIds.length) {
    const rt = await c.from('recipe_tags').insert(tagIds.map((tag_id) => ({ recipe_id: recipe.id, tag_id })));
    if (rt.error) return { recipe_id: recipe.id, warning: `Tags not linked: ${rt.error.message}`, link: `${SITE}/recipes/${recipe.id}` };
  }
  return { recipe_id: recipe.id, link: `${SITE}/recipes/${recipe.id}`, tags_ignored: ignored };
}));

server.registerTool('list_tags', {
  description: 'Existing recipe tags (use these names when importing).',
  inputSchema: {},
}, wrap(async () => {
  const { data, error } = await (await db()).from('tags').select('name, category').order('name');
  if (error) throw new Error(error.message);
  return data;
}));

// ---------- staples + purchases ----------
let householdId: string | null = null;
async function myHousehold(c: SupabaseClient): Promise<string> {
  if (householdId) return householdId;
  const { data, error } = await c.from('household_members').select('household_id').eq('user_id', userId).limit(1).single();
  if (error) throw new Error(`No household: ${error.message}`);
  return (householdId = data.household_id as string);
}
const daysBetween = (a: string, b: string) => (Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Learned rate: needs ≥3 purchase days over ≥14 days; consumption = everything bought before the last day / span. */
async function relearn(c: SupabaseClient, stapleId: string) {
  const { data } = await c.from('purchases').select('purchased_on, quantity').eq('staple_id', stapleId)
    .not('quantity', 'is', null).order('purchased_on');
  const byDay = new Map<string, number>();
  for (const p of data ?? []) byDay.set(p.purchased_on as string, (byDay.get(p.purchased_on as string) ?? 0) + Number(p.quantity));
  const days = [...byDay.keys()].sort();
  if (days.length < 3 || daysBetween(days[0]!, days.at(-1)!) < 14) return null;
  const consumed = days.slice(0, -1).reduce((s, d) => s + byDay.get(d)!, 0);
  const rate = consumed / daysBetween(days[0]!, days.at(-1)!);
  await c.from('staples').update({ learned_per_day: rate, learned_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', stapleId);
  return rate;
}

server.registerTool('get_staples', {
  description: 'Recurring household items (milk, skyr, …) with their consumption rate (learned from purchases, ' +
    'else what the family told us) and a suggested quantity for the next `days` days, minus the estimated ' +
    'leftover from the last purchase. Add the suggestions to the shopping list as "Faste varer"; ' +
    'round up to whole packs and prefer preferred_product.',
  inputSchema: { days: z.number().int().min(1).max(21).default(7) },
}, wrap(async ({ days }: { days: number }) => {
  const c = await db();
  const hid = await myHousehold(c);
  const { data: staples, error } = await c.from('staples').select('*').eq('household_id', hid).eq('active', true).order('name');
  if (error) throw new Error(error.message);
  const today = todayKey();
  const out = [];
  for (const s of staples ?? []) {
    const learned = s.learned_per_day != null;
    const rate = learned ? Number(s.learned_per_day) : Number(s.seed_quantity) / Number(s.seed_days);
    const { data: last } = await c.from('purchases').select('purchased_on, quantity').eq('staple_id', s.id)
      .not('quantity', 'is', null).order('purchased_on', { ascending: false }).limit(20);
    const lastDay = last?.[0]?.purchased_on as string | undefined;
    const lastQty = (last ?? []).filter((p) => p.purchased_on === lastDay).reduce((n, p) => n + Number(p.quantity), 0);
    const leftover = lastDay ? Math.max(0, lastQty - rate * daysBetween(lastDay, today)) : 0;
    out.push({
      name: s.name, unit: s.unit, per_week: r2(rate * 7), rate_from: learned ? 'learned' : 'told',
      told: `${s.seed_quantity} ${s.unit} per ${s.seed_days} dage`,
      last_bought: lastDay ? `${lastQty} ${s.unit} on ${lastDay}` : null,
      est_leftover: r2(leftover), suggest: r2(Math.max(0, rate * days - leftover)),
      preferred_product: s.preferred_product,
    });
  }
  return { days, staples: out };
}));

server.registerTool('set_staple', {
  description: 'Add or change a recurring item when the family says so ("vi drikker 4 l mælk på 3 dage", "stop med kefir"). ' +
    'Resets the told rate; the learned rate stays unless reset_learned.',
  inputSchema: {
    name: z.string().min(1).max(80), unit: z.string().min(1).max(20),
    quantity: z.number().positive(), per_days: z.number().positive(),
    active: z.boolean().default(true), reset_learned: z.boolean().default(false),
    preferred_product: z.string().max(200).optional(),
  },
}, wrap(async (a: any) => {
  const c = await db();
  const hid = await myHousehold(c);
  const row: Record<string, unknown> = {
    household_id: hid, name: a.name.toLowerCase(), unit: a.unit, seed_quantity: a.quantity, seed_days: a.per_days,
    active: a.active, updated_at: new Date().toISOString(),
  };
  if (a.reset_learned) Object.assign(row, { learned_per_day: null, learned_at: null });
  if (a.preferred_product !== undefined) row.preferred_product = a.preferred_product;
  const { data, error } = await c.from('staples').upsert(row, { onConflict: 'household_id,name' }).select('name, unit, seed_quantity, seed_days, active').single();
  if (error) throw new Error(error.message);
  return data;
}));

server.registerTool('log_purchase', {
  description: 'Record what was actually bought (from handle get_order after the family ordered, or the approved ' +
    'list for REMA). One line per product. For lines that are a staple, set `staple` (its name) and `quantity` in ' +
    "the staple's unit (e.g. 3 × 1 l mælk → quantity 3). Re-learns staple rates; remembers the product only if the staple has no preferred_product yet. " +
    'Lines with the same order_id + product are not logged twice.',
  inputSchema: {
    store: z.enum(['nemlig', 'bilkatogo', 'rema1000', 'andet']),
    order_id: z.string().max(100).optional(),
    purchased_on: dateKey.optional(),
    lines: z.array(z.object({
      product_name: z.string().min(1).max(200),
      product_id: z.string().max(100).optional(),
      packs: z.number().positive().default(1),
      quantity: z.number().positive().optional(),
      unit: z.string().max(20).optional(),
      price: z.number().nonnegative().optional(),
      staple: z.string().max(80).optional(),
    })).min(1).max(200),
  },
}, wrap(async (a: any) => {
  const c = await db();
  const hid = await myHousehold(c);
  const { data: staples } = await c.from('staples').select('id, name').eq('household_id', hid);
  const sid = new Map((staples ?? []).map((s: any) => [s.name, s.id as string]));
  const unknown: string[] = [];
  const rows = a.lines.map((l: any) => {
    const staple_id = l.staple ? sid.get(l.staple.toLowerCase()) ?? null : null;
    if (l.staple && !staple_id) unknown.push(l.staple);
    return {
      household_id: hid, purchased_on: a.purchased_on ?? todayKey(), store: a.store, order_id: a.order_id ?? null,
      product_name: l.product_name, product_id: l.product_id ?? null, packs: l.packs, quantity: l.quantity ?? null,
      unit: l.unit ?? null, price: l.price ?? null, staple_id,
    };
  });
  const q = a.order_id
    ? c.from('purchases').upsert(rows, { onConflict: 'household_id,store,order_id,product_name', ignoreDuplicates: true })
    : c.from('purchases').insert(rows);
  const { error } = await q;
  if (error) throw new Error(error.message);
  const learned: Record<string, number | null> = {};
  for (const r of rows.filter((r: any) => r.staple_id)) {
    // Only remember a product when none is set: a preference the family stated wins over what got bought.
    await c.from('staples').update({ preferred_product: r.product_name }).eq('id', r.staple_id).is('preferred_product', null);
    const name = [...sid].find(([, id]) => id === r.staple_id)![0];
    const rate = await relearn(c, r.staple_id);
    learned[name] = rate == null ? null : r2(rate * 7);
  }
  return { logged: rows.length, staples_per_week_learned: learned, unknown_staples: unknown };
}));

// ---------- user recipes from Discord ----------
// The bot puts { recipe_import: { text, message_id, at, who } } in last_turn.json ONLY when an authorised
// user's message starts with "gem opskrift"/"opret opskrift". Everything saved must be found in that text.
server.registerTool('import_user_recipe', {
  description: 'Save a recipe that a family member POSTED IN DISCORD into Opskrifter. Only works in the turn the bot ' +
    'opened for a "gem opskrift" command; anything else is refused. Every field must come from their text: the ' +
    'title, each ingredient name (and amount if given) and each instruction step must appear in it (steps may be ' +
    'split into sentences, never reworded or added). Missing info stays empty — never fill it in. ' +
    'Tags must be existing tag names (list_tags).',
  inputSchema: {
    title: z.string().min(1).max(200),
    description: z.string().max(2000).optional(),
    servings: z.number().int().min(1).max(30).optional(),
    prep_time: z.number().int().min(0).max(1440).optional(),
    cook_time: z.number().int().min(0).max(1440).optional(),
    ingredients: z.array(z.object({
      name: z.string().min(1).max(120),
      amount: z.number().positive().nullable().optional(),
      unit: z.string().max(30).nullable().optional(),
    })).min(1).max(80),
    instructions: z.array(z.string().min(1).max(2000)).min(1).max(40),
    tags: z.array(z.string().max(50)).max(10).default([]),
  },
}, wrap(async (a: any) => {
  const turn = readJson<any>(LAST_TURN, {});
  const imp = turn.recipe_import;
  if (turn.kind !== 'human' || !imp?.text || !imp.message_id)
    throw new Error('Refused: no "gem opskrift" command from a family member in this turn. Do not save anything.');
  if (Date.now() - Date.parse(imp.at) > 15 * 60_000) throw new Error('Refused: the "gem opskrift" command expired (15 min).');
  if (imp.used) throw new Error('Refused: this "gem opskrift" command already saved a recipe.');

  const missing = findMissing(imp.text, a);
  if (missing.length)
    throw new Error('Refused – not in their message (copy it exactly, or leave it out):\n' + missing.join('\n'));

  const c = await db();
  const externalId = `discord:${imp.message_id}`;
  const existing = await c.from('recipes').select('id').eq('source', 'opskrifter').eq('external_id', externalId).maybeSingle();
  if (existing.data) return { recipe_id: existing.data.id, already_saved: true, link: `${SITE}/recipes/${existing.data.id}` };

  const { data: allTags } = await c.from('tags').select('id, name');
  const byName = new Map((allTags ?? []).map((t: any) => [t.name.toLowerCase(), t.id as string]));
  const tagIds = [...new Set((a.tags as string[]).map((t) => byName.get(t.toLowerCase())).filter(Boolean))] as string[];

  const ins = await c.from('recipes').insert({
    title: a.title, slug: `${slugify(a.title)}-${Math.random().toString(36).slice(2, 8)}`,
    description: a.description ?? null, instructions: a.instructions, servings: a.servings ?? null,
    prep_time: a.prep_time ?? null, cook_time: a.cook_time ?? null, author_id: userId, type: 'standard',
    source: 'opskrifter', external_id: externalId,
  }).select('id').single();
  if (ins.error) throw new Error(ins.error.message);
  const ingr = await c.from('ingredients').insert(a.ingredients.map((i: any, pos: number) => ({
    recipe_id: ins.data.id, name: i.name, amount: i.amount ?? null, unit: i.unit ?? null, position: pos,
  })));
  if (ingr.error) {
    await c.from('recipes').delete().eq('id', ins.data.id);
    throw new Error(`Ingredients failed, recipe rolled back: ${ingr.error.message}`);
  }
  if (tagIds.length) await c.from('recipe_tags').insert(tagIds.map((tag_id) => ({ recipe_id: ins.data.id, tag_id })));
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(LAST_TURN, JSON.stringify({ ...turn, recipe_import: { ...imp, used: true } }), { mode: 0o600 });
  return { recipe_id: ins.data.id, link: `${SITE}/recipes/${ins.data.id}`, saved_for: imp.who };
}));

server.registerTool('update_own_recipe', {
  description: 'Edit an existing recipe in Opskrifter (own or imported) when a family member ASKS to change the recipe ' +
    'itself ("ret opskriften", "skift X ud med Y i opskriften", "tilføj et trin", "sæt tiden til 30 min"). Only works in ' +
    "a turn from a family member allowed to edit recipes. Read it with get_own_recipe first. Send only the fields to " +
    'change; `ingredients` / `instructions` / `tags` REPLACE the whole list, so send the full updated list. ' +
    'Change only what they asked for. Tweaks for one meal in the plan still go in the meal notes, not here.',
  inputSchema: {
    recipe_id: z.string().uuid(),
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    servings: z.number().int().min(1).max(30).nullable().optional(),
    prep_time: z.number().int().min(0).max(1440).nullable().optional(),
    cook_time: z.number().int().min(0).max(1440).nullable().optional(),
    ingredients: z.array(z.object({
      name: z.string().min(1).max(120),
      amount: z.number().positive().nullable().optional(),
      unit: z.string().max(30).nullable().optional(),
      notes: z.string().max(200).nullable().optional(),
    })).min(1).max(80).optional(),
    instructions: z.array(z.string().min(1).max(2000)).min(1).max(40).optional(),
    tags: z.array(z.string().max(50)).max(10).optional(),
  },
}, wrap(async (a: any) => {
  const turn = readJson<any>(LAST_TURN, {});
  if (turn.kind !== 'human' || turn.recipe_edit !== true)
    throw new Error('Refused: recipes can only be edited when a family member allowed to edit recipes asks in this turn.');
  const c = await db();
  const cur = await c.from('recipes').select('id, title, ingredients (name, amount, unit, notes, position)').eq('id', a.recipe_id).single();
  if (cur.error) throw new Error(cur.error.message);

  const patch: Record<string, unknown> = {};
  for (const k of ['title', 'description', 'servings', 'prep_time', 'cook_time', 'instructions'])
    if (a[k] !== undefined) patch[k] = a[k];
  const changed: string[] = Object.keys(patch);
  if (changed.length) {
    patch.updated_at = new Date().toISOString();
    const up = await c.from('recipes').update(patch).eq('id', a.recipe_id).select('id');
    if (up.error) throw new Error(up.error.message);
    if (!up.data?.length) throw new Error('Not allowed to edit this recipe (not in the household).');
  }

  if (a.ingredients) {
    const old = [...(cur.data.ingredients as any[])].sort((x, y) => (x.position ?? 0) - (y.position ?? 0));
    const rows = (list: any[]) => list.map((i, pos) => ({
      recipe_id: a.recipe_id, name: i.name, amount: i.amount ?? null, unit: i.unit ?? null, notes: i.notes ?? null, position: pos,
    }));
    const del = await c.from('ingredients').delete().eq('recipe_id', a.recipe_id);
    if (del.error) throw new Error(`Ingredients not changed: ${del.error.message}`);
    const ins = await c.from('ingredients').insert(rows(a.ingredients));
    if (ins.error) {
      if (old.length) await c.from('ingredients').insert(rows(old));
      throw new Error(`Ingredients failed, old list restored: ${ins.error.message}`);
    }
    changed.push('ingredients');
  }

  let ignored: string[] = [];
  if (a.tags) {
    const { data: allTags, error: tagErr } = await c.from('tags').select('id, name');
    if (tagErr) throw new Error(tagErr.message);
    const byName = new Map((allTags ?? []).map((t: any) => [t.name.toLowerCase(), t.id as string]));
    const tagIds = [...new Set((a.tags as string[]).map((t) => byName.get(t.toLowerCase())).filter(Boolean))] as string[];
    ignored = (a.tags as string[]).filter((t) => !byName.has(t.toLowerCase()));
    const del = await c.from('recipe_tags').delete().eq('recipe_id', a.recipe_id);
    if (del.error) throw new Error(`Tags not changed: ${del.error.message}`);
    if (tagIds.length) {
      const rt = await c.from('recipe_tags').insert(tagIds.map((tag_id) => ({ recipe_id: a.recipe_id, tag_id })));
      if (rt.error) throw new Error(`Tags removed but new ones failed: ${rt.error.message}`);
    }
    changed.push('tags');
  }
  if (!changed.length) throw new Error('Nothing to change — send at least one field.');
  return { recipe_id: a.recipe_id, changed, tags_ignored: ignored, edited_for: turn.who, link: `${SITE}/recipes/${a.recipe_id}` };
}));

await server.connect(new StdioServerTransport());
