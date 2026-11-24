# madplan-agent

An AI agent that plans the family's dinners: every Friday it proposes next week's meals in
Discord from real store recipes, prices them at three Danish online grocery stores, builds the
shopping list and fills the cheapest cart after two human "ok"s. The human always picks the
delivery time and pays. Built on the open-source handle-mcp server, a small custom MCP server for
the family's own recipe site, and Claude Code in headless mode.

Companion repo for the session **"Dear AI, What's for Dinner?"** /
**"Kære AI, hvad skal vi have at spise?"**.

| Path | What |
|---|---|
| `BLUEPRINT.md` | How it all works, the guardrails, and how to rebuild it |
| `code/bot/` | Discord bot + Friday scheduler (Bun + discord.js): runs `claude -p` with only the two MCP servers |
| `code/bot/config.example.json` | Who may talk to it, which channel, and the family's meal rules |
| `code/bot/mcp.example.json` | The two MCP servers the agent is allowed to load |
| `code/madplan-mcp/` | MCP server for the meal plan, own recipes, shopping list and staples (Supabase) |
| `code/madplan-mcp/verify.ts` | Checks that a recipe saved from chat is word-for-word what the human posted |
| `code/systemd/madplan-bot.service` | systemd user unit for the bot |
| `.env.example` | All secrets (copy to `~/.config/madplan-agent/env`, `chmod 600`) |
| `talk/abstract.md` | Session abstract, English and Danish |
| `slides/dear-ai-whats-for-dinner.pptx` | The slide deck (PowerPoint, 21 slides); `.pdf` alongside for viewing without PowerPoint |

handle-mcp is not included. Install it from its own repo (see `BLUEPRINT.md` §4.1). The recipe
site's own code and database migrations are not included either; `BLUEPRINT.md` §3 lists the
tables the MCP server expects.

```sh
cd code/madplan-mcp && bun install && bun test   # the recipe verifier's tests
```
