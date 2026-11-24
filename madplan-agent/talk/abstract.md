# Abstract

## English

**Title:** MCP in Practice: A Meal-Plan Agent, Under the Hood

A technical show-and-tell from a side project: an agent that plans our family's dinners every
Friday, prices the week at three Danish online grocery stores, and fills the cheapest cart after
two human "ok"s. A human always picks the delivery time and pays. The meal planner is only the
running example; the session is about how it's built:

- **MCP in five minutes:** hosts, clients and servers, tools/resources/prompts, stdio vs.
  Streamable HTTP, and what `tools/list` and `tools/call` look like on the wire
- **Writing an MCP server:** a tool in 15 lines with the TypeScript SDK and zod, why tool design is
  prompt design, and giving the server its own identity so Row Level Security applies
- **Claude Code as a headless agent runtime:** `claude -p` flag by flag (`--strict-mcp-config`,
  allowed/disallowed tools, session resume), and keeping state outside the model
- **Guardrails, "prompts ask, code decides":** five layers of control, validating state instead of
  requests, trust signals the model can't forge, checking model output against its source, and
  why hard rules need an honest exit

You'll leave with a pattern you can reuse in client work: wrap a system once as an MCP server,
design its tools like an API, and enforce the rules that matter in code rather than in the prompt.

## Dansk

**Titel:** MCP i praksis: en madplan-agent, under motorhjelmen

Et teknisk show-and-tell fra et sideprojekt: en agent, der hver fredag planlægger familiens
aftensmad, prissætter ugen hos tre danske netbutikker og fylder den billigste kurv efter to
menneskelige "ok". Et menneske vælger altid leveringstid og betaler. Madplanen er bare det
gennemgående eksempel; sessionen handler om, hvordan det er bygget:

- **MCP på fem minutter:** hosts, clients og servere, tools/resources/prompts, stdio vs.
  Streamable HTTP, og hvordan `tools/list` og `tools/call` ser ud på wire-niveau
- **At skrive en MCP-server:** et tool på 15 linjer med TypeScript-SDK'et og zod, hvorfor tool
  design er prompt design, og hvorfor serveren skal have sin egen identitet, så Row Level Security
  gælder
- **Claude Code som headless agent-runtime:** `claude -p` flag for flag (`--strict-mcp-config`,
  tilladte/forbudte tools, genoptagelse af sessioner), og tilstand der ligger uden for modellen
- **Guardrails, "prompten beder, koden bestemmer":** fem lag af kontrol, validering af tilstand i
  stedet for kald, tillidssignaler modellen ikke kan forfalske, kontrol af modellens output mod
  kilden, og hvorfor hårde regler skal have en ærlig udvej

Du går hjem med et mønster, du kan genbruge i kundeprojekter: pak et system ind som en MCP-server
én gang, design dets tools som et API, og håndhæv de regler, der betyder noget, i kode frem for i
prompten.
