# Abstract

## English

**Title:** MCP in Practice: A Meal-Plan Agent, Under the Hood

A technical show-and-tell from a side project: an agent that plans our family's dinners every
Friday, prices the week at three Danish online grocery stores, and fills the cheapest cart after
two human "ok"s. A human always picks the delivery time and pays. The meal planner is only the
running example; the session is about how it's built:

- **What an MCP server is**, in plain words: how an AI gets access to a system like a database or
  a webshop, and what the AI actually sees (a list of tools, each with a name, a description and
  its inputs)
- **Building one:** a tool in four fields, what makes a good tool, and why the server should log in
  as its own user so Row Level Security applies
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

- **Hvad en MCP-server er**, forklaret enkelt: hvordan en AI får adgang til et system som en
  database eller en webshop, og hvad AI'en faktisk ser (en liste af tools med navn, beskrivelse og
  input)
- **At bygge en:** et tool i fire felter, hvad der gør et tool godt, og hvorfor serveren skal logge
  ind som sin egen bruger, så Row Level Security gælder
- **Claude Code som headless agent-runtime:** `claude -p` flag for flag (`--strict-mcp-config`,
  tilladte/forbudte tools, genoptagelse af sessioner), og tilstand der ligger uden for modellen
- **Guardrails, "prompten beder, koden bestemmer":** fem lag af kontrol, validering af tilstand i
  stedet for kald, tillidssignaler modellen ikke kan forfalske, kontrol af modellens output mod
  kilden, og hvorfor hårde regler skal have en ærlig udvej

Du går hjem med et mønster, du kan genbruge i kundeprojekter: pak et system ind som en MCP-server
én gang, design dets tools som et API, og håndhæv de regler, der betyder noget, i kode frem for i
prompten.
