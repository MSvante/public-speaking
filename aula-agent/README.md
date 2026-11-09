# aula-agent

An AI agent that reads Aula so I don't have to: a Sunday "what needs doing this week" digest in
Discord, plus a private chat bot for follow-up questions. Built on the open-source
aula-mcp server and Claude Code in headless mode.

Companion repo for the session **"Dear AI, What Do My Kids Need This Week?"** /
**"Kære AI, hvad skal børnene bruge i denne uge?"**.

| Path | What |
|---|---|
| `BLUEPRINT.md` | How it all works and how to rebuild it from scratch |
| `code/weekly/aula-weekly.sh` | Scheduled agent: weekly summary → Discord + Home Assistant push |
| `code/bot/` | Discord bot for follow-up questions (Bun + discord.js) |
| `code/systemd/aula-bot.service` | systemd user unit for the bot |
| `.env.example` | All configuration and secrets (copy to `~/.config/aula-agent/env`, `chmod 600`) |
| `talk/abstract.md` | Session abstract, English and Danish |

aula-mcp is not included. Clone it from its own repo (see `BLUEPRINT.md` §4.1).
