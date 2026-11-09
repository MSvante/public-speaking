/**
 * Discord listener: answers Aula questions from the owner in one private channel by running
 * `claude -p` with the read-only aula MCP tools. Ignores everyone else and every other channel
 * (the answers contain children's data). Logs status/lengths only, never content.
 *
 * Config via environment (see ../../.env.example):
 *   DISCORD_BOT_TOKEN, DISCORD_OWNER_ID, DISCORD_CHANNEL_ID, CLAUDE_BIN (optional)
 */
import { Client, GatewayIntentBits, Events, type Message } from 'discord.js';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const need = (k: string) => {
  const v = process.env[k]?.trim();
  if (!v) throw new Error(`missing env ${k}`);
  return v;
};

const OWNER_ID = need('DISCORD_OWNER_ID');     // the only Discord user the bot listens to
const CHANNEL_ID = need('DISCORD_CHANNEL_ID'); // the only channel the bot listens in
const TOKEN = need('DISCORD_BOT_TOKEN');
const CLAUDE = process.env.CLAUDE_BIN ?? join(homedir(), '.local', 'bin', 'claude');
const WORKDIR = '/var/tmp/aula-bot-work'; // neutral cwd so no project CLAUDE.md gets loaded
const TIMEOUT_MS = 300_000;
const SESSION_TTL_MS = 30 * 60_000; // follow-ups within 30 min continue the same Claude session

const SYSTEM =
  'Du svarer på spørgsmål om Aula (skole/børnehave) via Aula-værktøjerne, som kun kan læse. ' +
  'Svar på dansk, kort og konkret, med Discord-markdown, under 1800 tegn. ' +
  'Er noget ikke tilgængeligt, så sig det i stedet for at gætte.';

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

let session: { id: string; at: number } | null = null;
let queue: Promise<unknown> = Promise.resolve(); // one question at a time

async function ask(question: string): Promise<string> {
  const cmd = [CLAUDE, '-p', question, '--allowedTools', 'mcp__aula__*',
    '--append-system-prompt', SYSTEM, '--output-format', 'json'];
  if (session && Date.now() - session.at < SESSION_TTL_MS) cmd.push('--resume', session.id);
  mkdirSync(WORKDIR, { recursive: true });
  const proc = Bun.spawn(cmd, {
    cwd: WORKDIR,
    env: { ...process.env, PATH: `${homedir()}/.local/bin:${homedir()}/.bun/bin:${process.env.PATH}` },
    stdout: 'pipe', stderr: 'pipe',
  });
  const timer = setTimeout(() => proc.kill(), TIMEOUT_MS);
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  clearTimeout(timer);
  if (code !== 0) throw new Error(`claude exit ${code}: ${err.slice(-300)}`);
  const data = JSON.parse(out);
  if (data.session_id) session = { id: data.session_id, at: Date.now() };
  return String(data.result ?? '').trim();
}

async function handle(msg: Message) {
  const channel = msg.channel;
  if (!('send' in channel)) return;
  await msg.react('⏳');
  let outcome = '✅';
  try {
    const answer = await ask(msg.content.trim());
    if (!answer) throw new Error('empty answer');
    // first part quotes the question (reply), the rest follow as plain messages
    for (let i = 0; i < answer.length; i += 1990) {
      const part = answer.slice(i, i + 1990);
      if (i === 0) await msg.reply({ content: part, allowedMentions: { repliedUser: false } });
      else await channel.send(part);
    }
  } catch (e) {
    log('question failed:', String(e).slice(0, 200));
    await msg.reply({
      content: 'Det lykkedes ikke at hente svaret. Tjek login: `pnpm aula status` på serveren.',
      allowedMentions: { repliedUser: false },
    });
    outcome = '❌';
  }
  await msg.reactions.cache.get('⏳')?.users.remove(client.user!.id);
  await msg.react(outcome);
  log(`question handled (${outcome}, ${msg.content.length} chars)`); // length only, never content
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.once(Events.ClientReady, (c) => log('logged in as', c.user.tag));
client.on(Events.MessageCreate, (msg) => {
  if (msg.author.bot || msg.author.id !== OWNER_ID || msg.channelId !== CHANNEL_ID) return;
  if (!msg.content.trim()) return;
  queue = queue.then(() => handle(msg)).catch((e) => log('handler error:', String(e).slice(0, 200)));
});

await client.login(TOKEN);
