/**
 * Discord listener for the household meal plan in #madplan. Runs `claude -p` with only the
 * madplan (Opskrifter/Supabase) and handle (grocery stores) MCP servers.
 *
 * Weekly flow (Friday, for next Mon–Fri), state in ~/.local/state/madplan/weekly.json (owned by
 * the madplan MCP's set_weekly_stage):
 *   kickoff (timer) → plan_proposed → [human ok] plan_approved → list_proposed
 *   → [human ok] list_approved → (bot runs the cart turn) cart_filled → done
 * Cart tools are disallowed except in the dedicated cart turn and outside the weekly flow.
 *
 * Only users in the config file are answered; unlisted user ids are logged (never content).
 * Config is re-read on every message/tick. Logs status/lengths only.
 *
 * Environment (see ../../.env.example):
 *   DISCORD_BOT_TOKEN, MADPLAN_CONFIG (optional, default ~/.config/madplan-agent/config.json),
 *   CLAUDE_BIN (optional)
 */
import { Client, GatewayIntentBits, Events, type Message, type SendableChannels } from 'discord.js';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

type Weekly = {
  enabled: boolean; kickoff: { weekday: string; time: string }; reminder_time: string;
  persons: number; household: string; max_minutes: number; no_repeat_weeks: number;
  min_fish: number; min_vegetarian: number; dislikes: string[]; pantry: string[];
  stores: string[]; rema_pickup_ok: boolean; single_store: boolean;
  /** Optional: where REMA Køb & Hent pickup is fine, e.g. "Aarhus N" */
  pickup_note?: string;
};
type Config = {
  channel_name: string; channel_id: string | null; users: Record<string, string>; weekly: Weekly;
  /** Discord user ids allowed to save recipes with "gem opskrift" and to edit recipes (no trigger word). */
  recipe_import_users?: string[];
};
type RecipeImport = { text: string; message_id: string; at: string; who: string };
type FlowState = { week_start: string | null; stage: string; final_store?: string; final_total?: number; cart_url?: string };

const HOME = homedir();
const need = (k: string) => {
  const v = process.env[k]?.trim();
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};
const CONFIG = process.env.MADPLAN_CONFIG ?? join(HOME, '.config', 'madplan-agent', 'config.json');
const TOKEN = need('DISCORD_BOT_TOKEN');
const CLAUDE = process.env.CLAUDE_BIN ?? join(HOME, '.local', 'bin', 'claude');
const MCP_CONFIG = join(import.meta.dir, 'mcp.json');
const WORKDIR = '/var/tmp/madplan-bot-work'; // neutral cwd so no project CLAUDE.md gets loaded
const STATE_DIR = join(HOME, '.local', 'state', 'madplan');
const WEEKLY_STATE = join(STATE_DIR, 'weekly.json');
const LAST_TURN = join(STATE_DIR, 'last_turn.json');
const SCHED_STATE = join(STATE_DIR, 'scheduler.json');
const TZ = 'Europe/Copenhagen';
const TIMEOUT_MS = 420_000;
const LONG_TIMEOUT_MS = 1_200_000; // kickoff / cart turns do many store calls
const SESSION_TTL_MS = 30 * 60_000;
const CART_TOOLS = ['mcp__handle__set_cart_quantities', 'mcp__handle__add_recipe_to_cart'];
const FLOW_ACTIVE = new Set(['plan_proposed', 'plan_approved', 'list_proposed', 'list_approved']);

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);
const readJson = <T>(p: string, fb: T): T => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fb; } };
function writeJson(p: string, v: unknown) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(`${p}.tmp`, JSON.stringify(v, null, 1), { mode: 0o600 });
  renameSync(`${p}.tmp`, p);
}
const loadConfig = (): Config => JSON.parse(readFileSync(CONFIG, 'utf8'));
const flow = (): FlowState => readJson<FlowState>(WEEKLY_STATE, { week_start: null, stage: 'idle' });

// ---------- Copenhagen time ----------
function cph(d = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).map((p) => [p.type, p.value]));
  return { weekday: parts.weekday!.toLowerCase(), date: `${parts.year}-${parts.month}-${parts.day}`, hm: `${parts.hour}:${parts.minute}` };
}
function nextMonday(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // 0 = mandag
  d.setUTCDate(d.getUTCDate() + (7 - dow));
  return d.toISOString().slice(0, 10);
}

// ---------- prompts ----------
function systemPrompt(w: Weekly): string {
  return [
    'Du er familiens madplan-assistent i Discord-kanalen #madplan.',
    'Madplanen, egne opskrifter og den fælles indkøbsliste ligger i Opskrifter (familiens opskriftsside) via madplan-værktøjerne.',
    'Butikkernes opskrifter, varer, tilbud, priser og kurve (nemlig.com, BilkaToGo, REMA 1000) via handle-værktøjerne.',
    '',
    `Husstand: ${w.household} – ${w.persons} portioner. Hverdagsretter max ${w.max_minutes} min. ` +
      `Mindst ${w.min_fish} fiskeret og ${w.min_vegetarian} vegetarret per uge. Ingen gentagelse inden for ${w.no_repeat_weeks} uger.` +
      (w.dislikes.length ? ` Undgå: ${w.dislikes.join(', ')}.` : ''),
    `Har altid hjemme (skal ikke på listen, men spørg kort hvis en ret kræver meget af noget): ${w.pantry.join(', ')}.`,
    '',
    'Faste regler:',
    '- OPFIND ALDRIG OPSKRIFTER. Retter i ugeplanen skal være butiksopskrifter fundet med handle (search_recipes/list_recipes/get_recipe) ' +
      'og gemmes med source (nemlig|bilkatogo), external_id (opskriftens id/link fra handle) og source_url. ' +
      'Egne opskrifter fra Opskrifter (recipe_id) kun når nogen beder om det.',
    '- Ændringer til ét måltid i planen ("kyllingebryst i stedet for lår denne gang", "uden svampe") skrives i måltidets notes og på indkøbslisten. ' +
      'Beder nogen derimod om at rette SELVE OPSKRIFTEN ("ret opskriften", "skift X ud med Y i opskriften", "tilføj et trin", "opskriften skal være til 4"), ' +
      'så find den (search_own_recipes/get_own_recipe), ret KUN det de beder om med update_own_recipe, og bekræft kort hvad der er ændret + link. ' +
      'Er det uklart om de mener opskriften eller kun denne uge, så spørg. Kan værktøjet ikke bruges (ikke tilladt for personen), så sig det kort.',
    '- Ingen aftensmad: siger nogen at en dag ikke skal have aftensmad (alene hjemme, spiser ude, væk), så mark_no_dinner(dato). ' +
      'Står der allerede en ret den dag, så remove_meal den først. Sådan en dag skal ikke have en ret og giver intet til indkøbslisten; ' +
      'vis den som "<dag>: Ingen aftensmad" i planen. Markér ALDRIG en dag af dig selv for at slippe for at finde en ret.',
    '- Godkendelse ("ok", "godkendt", "ja", "👍", "ser godt ud") må KUN komme fra et menneske. Godkend aldrig selv.',
    '- Læg kun varer i en butikskurv når værktøjerne er tilgængelige for dig; du kan aldrig bestille eller betale.',
    '- Ugen går mandag–søndag, Europe/Copenhagen. Skriv datoer som "mandag 17. nov".',
    '- Discord-markdown, ingen tabeller (brug punktlister), links i <> så Discord ikke laver previews. Svar på dansk, kort og venligt.',
    '- Hold hvert svar under 1800 tegn hvis muligt; en fuld indkøbsliste må gerne være længere (den deles automatisk).',
    '- Hvis et værktøj fejler (fx udløbet butikslogin), så sig det kort i stedet for at gætte.',
    '',
    'Ugens flow (status står øverst i hver besked som [Ugeplan: …]):',
    '• plan_proposed – vi venter på godkendelse af retterne. Ønsker de ændringer: find en ny butiksopskrift, opdatér med update_meal, ' +
      'sæt set_weekly_stage("plan_proposed") igen med opdateret plan_summary, og vis den nye plan. ' +
      'Når et menneske godkender: set_weekly_stage("plan_approved"), og så straks: ' +
      `(a) GEM RETTERNE I OPSKRIFTER: for hver butiksret get_recipe(store, external_id eller source_url, persons=${w.persons}), ` +
      'list_tags, import_store_recipe med titel, beskrivelse, billede, tider, servings, ingredienser og fremgangsmåde KOPIERET fra get_recipe ' +
      '(+ passende eksisterende tags, fx Aftensmad, Fisk, Vegetarisk, Kylling), og update_meal(meal_id, recipe_id=…) – notes bevares. ' +
      '(b) INDKØBSLISTE: remove_checked_shopping_items; week_ingredients for ugen (week_offset for den planlagte uge) og anvend notes; ' +
      'udelad "har hjemme"-varer; get_staples(days=7) og tilføj forslagene som faste varer (rundet op til hele pakker); ' +
      'add_to_shopping_list; set_weekly_stage("list_proposed"); ' +
      'post HELE listen grupperet (frugt/grønt, kød/fisk, mejeri, kolonial, **Faste varer (ud fra forbrug)**, andet), ' +
      'inkl. varer der allerede stod på listen (marker dem "(stod allerede på listen)"). ' +
      'Slut med: "Ret, tilføj (fx bleer) eller skriv ok for at godkende listen."',
    '• list_proposed – de retter/tilføjer varer: brug update_shopping_items / add_to_shopping_list og bekræft kort hvad der er ændret. ' +
      'Når et menneske godkender listen: set_weekly_stage("list_approved") og svar kun "👍 Sammenligner priser og fylder kurven – et øjeblik." (kurven fyldes i næste trin).',
    '• cart_filled – kurven er fyldt; svar på spørgsmål. Skriver de at de har bestilt: LOG KØBET: ' +
      'nemlig/bilkatogo: get_orders(store, limit=3) → nyeste ordre → get_order → log_purchase(store, order_id, lines); ' +
      'rema1000 (kan ikke læse ordrer): log_purchase med varerne fra kurven/listen. Sæt staple+quantity på linjer der er faste varer ' +
      '(fx 3 × Letmælk 1 l → staple "mælk", quantity 3). Kan ordren ikke findes endnu, så log kurvens indhold og sig det. ' +
      'Derefter set_weekly_stage("done") og bekræft kort (nævn evt. nye lærte forbrugstal).',
    '',
    'Opskrifter fra familien: du kan ALDRIG selv gemme en opskrift i en almindelig samtale. Vil de gemme en, så skriv: ' +
      '"Indsæt opskriften (gerne i flere beskeder) og skriv så `gem opskriften`."',
    'Faste varer: siger de fx "vi drikker 4 l mælk på 3 dage", "tilføj bleer, 1 pakke om ugen" eller "stop med kefir", så brug set_staple.',
  ].join('\n');
}

function kickoffPrompt(w: Weekly, week: string): string {
  return [
    `[Automatisk fredagsstart – ingen mennesker har skrevet. Uge der planlægges: mandag ${week} – fredag.]`,
    'Lav næste uges madplan for mandag–fredag:',
    `1. get_weekly_status, get_week(week_offset=1) og recent_meals(weeks=${w.no_repeat_weeks}). Har en dag allerede en ret, så behold den.`,
    '2. Find kandidater KUN med handle: list_recipes(stores=["nemlig"], tags=["Familievenlig"]) og andre relevante tags ' +
      '(fx "Under 30 min", "Fisk", "Vegetarisk", "Budgetvenlig"), og list_recipes(stores=["bilkatogo"]) (ugens Madplan). ' +
      'Brug list_offers til at foretrække retter med varer på tilbud. Tjek med get_recipe tid og ingredienser.',
    `3. Dage markeret "Ingen aftensmad" (source ingen) skal IKKE have en ret – spring dem over og vis dem som "Ingen aftensmad". ` +
      `Vælg forskellige retter til de øvrige hverdage (variation i protein og køkken, overhold reglerne – fisk/vegetar skal stadig med). plan_meal for hver af dem med servings=${w.persons}, ` +
      'title, source, external_id og source_url fra handle.',
    `4. Prissammenlign hele ugen: lav en samlet indkøbsliste ud fra ingrediensmængderne (skaleret til ${w.persons} personer, uden "har hjemme"-varer) ` +
      '+ forslagene fra get_staples(days=7) ' +
      `og kald compare_basket(items, stores=${JSON.stringify(w.stores)}). Notér total inkl. gebyrer per butik og om minimumskøb er nået.` +
      (w.rema_pickup_ok ? ' REMA er Køb & Hent (afhentning er OK).' : ''),
    '5. set_weekly_stage("plan_proposed", week_start, plan_summary=<retterne + priser per butik>).',
    '6. Svar med beskeden til familien: "🍽️ **Ny madplan for uge <nr>** er klar", én linje per dag (dag: ret – kilde, <link>), ' +
      'derefter "Anslået pris: nemlig X kr · BilkaToGo Y kr · REMA Z kr", og til sidst: ' +
      '"Skriv hvad der skal ændres (fx \'byt onsdag til noget med fisk\'), eller **ok** for at godkende retterne."',
  ].join('\n');
}

function cartPrompt(w: Weekly): string {
  return [
    '[Automatisk kurvtrin – indkøbslisten er netop godkendt af et menneske.]',
    `1. get_shopping_list (ikke-afkrydsede varer). compare_basket med alle varerne i stores=${JSON.stringify(w.stores)}.`,
    `2. Vælg ${w.single_store ? 'ÉN butik' : 'butik(ker)'}: laveste total inkl. gebyrer, hvor minimumskøb er nået` +
      (w.rema_pickup_ok ? ` (REMA Køb & Hent${w.pickup_note ? ` i ${w.pickup_note}` : ''} er OK)` : '') + '. Brug kandidaterne fra compare_basket: ' +
      'vælg den der passer til det ønskede (fx brystfilet vs. lår); ved "sure": false så vælg den mest oplagte og nævn det.',
    '3. get_cart(store) først. Kurven tømmes IKKE: læg ugens varer oveni (absolut antal = det der allerede er + det der skal bruges), ' +
      'og nævn hvad der lå i forvejen. set_cart_quantities(store, {produkt-id: antal}). Tjek ok per vare og nævn fejl.',
    '4. get_cart(store) for total og url. list_delivery_slots(stores=[store], days=4) og find de 3 bedste tider til levering/afhentning senest mandag.',
    '5. set_weekly_stage("cart_filled", final_store, final_total, cart_url).',
    '6. Svar: "🛒 **Kurven er klar hos <butik>** – <total> kr" (+ hvad de andre butikker ville koste), link til kurven i <>, ' +
      'varer der ikke kunne findes/fejlede, de 3 tider, og "Vælg tid og betal på butikkens side. Skriv **bestilt** når det er gjort."',
  ].join('\n');
}

// ---------- claude ----------
let session: { id: string; at: number } | null = null;
let queue: Promise<unknown> = Promise.resolve(); // one claude run at a time

async function runClaude(prompt: string, opts: { allowCart: boolean; fresh?: boolean; timeout?: number; who: string; kind: 'human' | 'system'; recipeImport?: RecipeImport; recipeEdit?: boolean }): Promise<string> {
  const cfg = loadConfig();
  writeJson(LAST_TURN, { who: opts.who, kind: opts.kind, at: new Date().toISOString(), ...(opts.recipeImport ? { recipe_import: opts.recipeImport } : {}), ...(opts.recipeEdit && opts.kind === 'human' ? { recipe_edit: true } : {}) });
  const cmd = [CLAUDE, '-p', prompt,
    '--mcp-config', MCP_CONFIG, '--strict-mcp-config',
    '--allowedTools', 'mcp__madplan__*', 'mcp__handle__*',
    '--append-system-prompt', systemPrompt(cfg.weekly), '--output-format', 'json'];
  if (!opts.allowCart) cmd.push('--disallowedTools', ...CART_TOOLS);
  if (!opts.fresh && session && Date.now() - session.at < SESSION_TTL_MS) cmd.push('--resume', session.id);
  mkdirSync(WORKDIR, { recursive: true });
  const proc = Bun.spawn(cmd, {
    cwd: WORKDIR,
    env: { ...process.env, PATH: `${HOME}/.local/bin:${HOME}/.bun/bin:${process.env.PATH}` },
    stdout: 'pipe', stderr: 'pipe',
  });
  const timer = setTimeout(() => proc.kill(), opts.timeout ?? TIMEOUT_MS);
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  clearTimeout(timer);
  writeJson(LAST_TURN, { who: 'system', kind: 'system', at: new Date().toISOString() });
  if (code !== 0) throw new Error(`claude exit ${code}: ${err.slice(-300)}`);
  const data = JSON.parse(out);
  if (data.session_id) session = { id: data.session_id, at: Date.now() };
  return String(data.result ?? '').trim();
}

const statusLine = (f: FlowState) => `[Ugeplan: uge fra ${f.week_start ?? '–'}, status ${f.stage}]`;

// ---------- discord helpers ----------
async function sendLong(channel: SendableChannels, text: string, replyTo?: Message) {
  // split on line boundaries to keep lists readable
  const chunks: string[] = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if ((cur + '\n' + line).length > 1990 && cur) { chunks.push(cur); cur = ''; }
    cur = cur ? `${cur}\n${line}` : line.slice(0, 1990);
  }
  if (cur) chunks.push(cur);
  for (const [i, part] of chunks.entries()) {
    if (i === 0 && replyTo) await replyTo.reply({ content: part, allowedMentions: { repliedUser: false } });
    else await channel.send(part);
  }
}

async function findChannel(): Promise<SendableChannels | null> {
  const cfg = loadConfig();
  if (cfg.channel_id) {
    const ch = await client.channels.fetch(cfg.channel_id).catch(() => null);
    return ch && 'send' in ch ? (ch as SendableChannels) : null;
  }
  for (const g of client.guilds.cache.values()) {
    const ch = g.channels.cache.find((c) => c.name === cfg.channel_name && 'send' in c);
    if (ch) return ch as unknown as SendableChannels;
  }
  return null;
}

// ---------- flow transitions after each run ----------
async function afterRun(before: FlowState, channel: SendableChannels) {
  const now = flow();
  if (now.stage === before.stage && now.week_start === before.week_start) return;
  log(`flow ${before.stage} → ${now.stage} (week ${now.week_start})`);
  if (now.stage === 'list_approved') await cartTurn(channel);
}

async function cartTurn(channel: SendableChannels) {
  const before = flow();
  const status = await channel.send('🛒 Sammenligner priser og fylder kurven…');
  try {
    const answer = await runClaude(`${statusLine(before)}\n${cartPrompt(loadConfig().weekly)}`,
      { allowCart: true, fresh: true, timeout: LONG_TIMEOUT_MS, who: 'system', kind: 'system' });
    await sendLong(channel, answer || 'Kurvtrinnet gav intet svar.');
    log(`cart turn done (${answer.length} chars)`);
  } catch (e) {
    log('cart turn failed:', String(e).slice(0, 200));
    await channel.send('❌ Det lykkedes ikke at fylde kurven. Skriv "prøv kurven igen" for at gentage.');
  }
  await status.delete().catch(() => {});
}

// ---------- human messages ----------
async function handle(msg: Message, who: string) {
  const channel = msg.channel as SendableChannels;
  await msg.react('⏳');
  let outcome = '✅';
  const before = flow();
  try {
    // Retry of a failed cart turn
    if (before.stage === 'list_approved' && /kurv/i.test(msg.content)) {
      await cartTurn(channel);
    } else {
      const answer = await runClaude(`${statusLine(before)}\n[${who} skriver]\n${msg.content.trim()}`, {
        allowCart: !FLOW_ACTIVE.has(before.stage), who, kind: 'human',
        recipeEdit: (loadConfig().recipe_import_users ?? []).includes(msg.author.id),
        timeout: before.stage === 'plan_proposed' ? LONG_TIMEOUT_MS : TIMEOUT_MS,
      });
      if (!answer) throw new Error('empty answer');
      await sendLong(channel, answer, msg);
      await afterRun(before, channel);
    }
  } catch (e) {
    log('question failed:', String(e).slice(0, 200));
    await msg.reply({ content: 'Det gik galt – prøv igen om lidt. (Log: `journalctl --user -u madplan-bot`)', allowedMentions: { repliedUser: false } });
    outcome = '❌';
  }
  await msg.reactions.cache.get('⏳')?.users.remove(client.user!.id).catch(() => {});
  await msg.react(outcome).catch(() => {});
  log(`question handled (${outcome}, ${who}, ${msg.content.length} chars)`);
}

// ---------- "gem opskrift": save a recipe the user posted ----------
// Anywhere in the message: "gem opskrift(en)", "gem den/denne/de/disse opskrift(er)", "opret opskriften", …
const RECIPE_TRIGGER = /(?:^|[^\p{L}])(?:gem|opret|(?:kan|vil|må)\s+du\s+(?:(?:lige|godt)\s+)?(?:gemme|oprette))\s+(?:(?:den|denne|de|disse)\s+(?:her\s+)?)?opskrift(?:en|er|erne)?(?![\p{L}])[:.!]?/iu;
const SOURCE_WINDOW_MS = 30 * 60_000; // earlier posts of yours count if they are this recent…
const SOURCE_MAX_MESSAGES = 6;        // …and at most this many

async function saveUserRecipe(msg: Message, who: string) {
  const channel = msg.channel as SendableChannels;
  const cfg = loadConfig();
  await msg.react('⏳');
  let outcome = '✅';
  try {
    // Recipe text = ONLY text written by the person giving the command:
    //  - the replied-to message (if it is theirs), else their own posts from the last 30 min (max 6, stopping at an
    //    earlier save command), oldest first
    //  - plus the command message itself (minus the trigger phrase).
    // Bot replies and other people's messages are never part of the source.
    const parts: Message[] = [];
    if (msg.reference?.messageId) {
      const ref = await msg.fetchReference().catch(() => null);
      if (!ref || ref.author.id !== msg.author.id) throw new Error('replied-to message is not from the same user');
      parts.push(ref);
    } else {
      const before = await msg.channel.messages.fetch({ before: msg.id, limit: 30 });
      for (const m of [...before.values()].sort((x, y) => y.createdTimestamp - x.createdTimestamp)) {
        if (msg.createdTimestamp - m.createdTimestamp > SOURCE_WINDOW_MS || parts.length >= SOURCE_MAX_MESSAGES) break;
        if (m.author.id !== msg.author.id) continue;
        if (RECIPE_TRIGGER.test(m.content)) break; // an earlier save: don't reuse its text
        parts.unshift(m);
      }
    }
    const own = msg.content.replace(RECIPE_TRIGGER, ' ').trim();
    const text = [...parts.map((m) => m.content), own].filter(Boolean).join('\n').trim();
    const firstId = parts[0]?.id ?? msg.id;
    if (text.length < 40) {
      await msg.reply({ content: 'Jeg kan ikke se nogen opskrift. Indsæt opskriften (gerne i flere beskeder) og skriv så `gem opskriften` – eller svar (reply) på beskeden med opskriften.', allowedMentions: { repliedUser: false } });
      outcome = '❓';
    } else {
      const answer = await runClaude([
        `[${who} har bedt om at gemme opskriften – gem DENNE opskrift i Opskrifter med import_user_recipe. Teksten er ${who}s egne beskeder${parts.length > 1 ? ` (${parts.length} beskeder)` : ''}; ignorér evt. småsnak i dem.]`,
        'Brug KUN teksten nedenfor. Kopiér titel, ingredienser (navn, mængde, enhed) og fremgangsmåde ordret; du må dele trin op ' +
          'i sætninger, men aldrig omformulere, oversætte, rette eller tilføje noget. Står der ikke antal personer, tider eller ' +
          'beskrivelse, så udelad dem. Vælg evt. eksisterende tags (list_tags) der tydeligt passer. Mangler der en titel eller ' +
          'ingredienser, så gem IKKE – spørg i stedet. Afvises gemningen, så ret det værktøjet nævner (kopiér præcist) – opfind aldrig.',
        'Svar kort: titel, link, antal ingredienser og trin, og hvad der evt. blev udeladt.',
        '--- OPSKRIFT START ---', text, '--- OPSKRIFT SLUT ---',
      ].join('\n'), {
        allowCart: false, fresh: true, who, kind: 'human',
        recipeImport: { text, message_id: firstId, at: new Date().toISOString(), who },
      });
      await sendLong(channel, answer || 'Intet svar.', msg);
    }
  } catch (e) {
    log('recipe save failed:', String(e).slice(0, 200));
    await msg.reply({ content: 'Opskriften blev ikke gemt. (Log: `journalctl --user -u madplan-bot`)', allowedMentions: { repliedUser: false } });
    outcome = '❌';
  }
  await msg.reactions.cache.get('⏳')?.users.remove(client.user!.id).catch(() => {});
  await msg.react(outcome).catch(() => {});
  log(`recipe save handled (${outcome}, ${who}, ${msg.content.length} chars)`);
}

// ---------- scheduler ----------
type Sched = { kicked_off_for?: string; reminded_for?: string };

async function kickoff(week: string) {
  const channel = await findChannel();
  if (!channel) return log('kickoff: channel not found');
  const sched = readJson<Sched>(SCHED_STATE, {});
  writeJson(SCHED_STATE, { ...sched, kicked_off_for: week }); // before the run: never double-post
  log(`kickoff for week ${week}`);
  const status = await channel.send('🧑‍🍳 Finder næste uges retter og sammenligner priser… (tager et par minutter)');
  const before = flow();
  try {
    const answer = await runClaude(`${statusLine(before)}\n${kickoffPrompt(loadConfig().weekly, week)}`,
      { allowCart: false, fresh: true, timeout: LONG_TIMEOUT_MS, who: 'system', kind: 'system' });
    await sendLong(channel, answer || 'Madplanen gav intet svar.');
    await afterRun(before, channel);
    if (flow().stage !== 'plan_proposed' || flow().week_start !== week) {
      log('kickoff ended without a valid plan_proposed');
      await channel.send('⚠️ Madplanen blev ikke færdig. Skriv "lav ugens madplan" for at prøve igen.');
    }
  } catch (e) {
    log('kickoff failed:', String(e).slice(0, 200));
    await channel.send('❌ Kunne ikke lave madplanen. Skriv "lav ugens madplan" for at prøve igen.');
  }
  await status.delete().catch(() => {});
}

async function tick() {
  const cfg = loadConfig();
  if (!cfg.weekly?.enabled) return;
  const now = cph();
  if (now.weekday !== cfg.weekly.kickoff.weekday) return;
  const week = nextMonday(now.date);
  const sched = readJson<Sched>(SCHED_STATE, {});
  if (now.hm >= cfg.weekly.kickoff.time && sched.kicked_off_for !== week) {
    queue = queue.then(() => kickoff(week)).catch((e) => log('kickoff error:', String(e).slice(0, 200)));
    return;
  }
  const f = flow();
  if (now.hm >= cfg.weekly.reminder_time && sched.reminded_for !== week && f.week_start === week &&
      (f.stage === 'plan_proposed' || f.stage === 'list_proposed')) {
    writeJson(SCHED_STATE, { ...sched, reminded_for: week });
    const channel = await findChannel();
    const what = f.stage === 'plan_proposed' ? 'retterne' : 'indkøbslisten';
    await channel?.send(`⏰ Påmindelse: ${what} for næste uge venter på jeres ok, så kurven kan nå at blive fyldt.`);
    log(`reminder sent (${f.stage})`);
  }
}

// ---------- wiring ----------
// `bun bot.ts --print-prompts <dir>`: write the prompts for a dry run and exit (no Discord).
if (process.argv[2] === '--print-prompts') {
  const dir = process.argv[3]!;
  const cfg = loadConfig();
  const week = nextMonday(cph().date);
  writeFileSync(join(dir, 'system.txt'), systemPrompt(cfg.weekly));
  writeFileSync(join(dir, 'kickoff.txt'), `${statusLine(flow())}\n${kickoffPrompt(cfg.weekly, week)}`);
  writeFileSync(join(dir, 'cart.txt'), cartPrompt(cfg.weekly));
  process.exit(0);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.once(Events.ClientReady, (c) => {
  log('logged in as', c.user.tag);
  setInterval(() => tick().catch((e) => log('tick error:', String(e).slice(0, 200))), 60_000);
});

client.on(Events.MessageCreate, (msg) => {
  if (msg.author.bot || !msg.content.trim()) return;
  let cfg: Config;
  try { cfg = loadConfig(); } catch (e) { log('config unreadable:', String(e).slice(0, 120)); return; }
  const inChannel = cfg.channel_id
    ? msg.channelId === cfg.channel_id
    : 'name' in msg.channel && msg.channel.name === cfg.channel_name;
  if (!inChannel || !('send' in msg.channel)) return;
  const who = cfg.users[msg.author.id];
  if (!who) {
    log(`ignored message from unlisted user id=${msg.author.id} name=${msg.author.username} channel=${msg.channelId}`);
    return;
  }
  if (!cfg.channel_id) log(`message in #${cfg.channel_name}: channel id=${msg.channelId} (pin it in config)`);
  if (RECIPE_TRIGGER.test(msg.content)) {
    if (!(cfg.recipe_import_users ?? []).includes(msg.author.id)) {
      log(`recipe save refused for user id=${msg.author.id} (not in recipe_import_users)`);
      void msg.reply({ content: 'Kun udvalgte personer kan gemme opskrifter.', allowedMentions: { repliedUser: false } });
      return;
    }
    queue = queue.then(() => saveUserRecipe(msg, who)).catch((e) => log('recipe error:', String(e).slice(0, 200)));
    return;
  }
  // Manual (re)start of the weekly flow
  if (/^lav (ugens|næste uges) madplan/i.test(msg.content.trim())) {
    const week = nextMonday(cph().date);
    queue = queue.then(() => kickoff(week)).catch((e) => log('kickoff error:', String(e).slice(0, 200)));
    return;
  }
  queue = queue.then(() => handle(msg, who)).catch((e) => log('handler error:', String(e).slice(0, 200)));
});

await client.login(TOKEN);
