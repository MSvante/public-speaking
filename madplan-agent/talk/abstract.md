# Abstract

## English

**Title:** Dear AI, What's for Dinner?

Every family knows the Thursday-evening question: what are we eating next week? Then comes the
rest of the chore: finding recipes, writing the shopping list, checking which store is cheapest
and clicking it all into a cart.

Now an AI agent does the legwork. Every Friday at 10:00 it posts five dinners for next week in our
family chat, built on real store recipes and priced at three online grocery stores. We swap a dish
or add diapers to the list, write "ok", and it fills the cheapest cart. We pick a delivery time and
pay. It never does that part.

In this session we'll look at how it works, and why most of the interesting code isn't AI at all:
- Two MCP servers: one for the grocery stores (the open-source handle-mcp) and one for our own
  recipes, meal plan and shopping list
- A weekly flow with humans in the loop: propose, approve, adjust, approve, fill the cart
- Rules that are enforced in code, not just asked for in a prompt: no invented recipes, only humans
  approve, and the agent can never pay
- Learning what we actually buy, like how much milk a family of four goes through

You'll leave with:
- A concrete pattern for agents that act on your behalf without you losing control
- The principle "prompts ask, code decides", and how to apply it
- Ideas for which of your own weekly chores could run the same way

## Dansk

**Titel:** Kære AI, hvad skal vi have at spise?

Alle familier kender torsdagsspørgsmålet: hvad skal vi have at spise i næste uge? Og så kommer
resten af opgaven: finde opskrifter, skrive indkøbslisten, tjekke hvilken butik der er billigst og
klikke det hele ind i en kurv.

Nu klarer en AI-agent det praktiske. Hver fredag kl. 10 poster den fem aftensmåltider til næste uge
i vores familiechat, bygget på rigtige butiksopskrifter og prissat hos tre netbutikker. Vi bytter
en ret eller tilføjer bleer til listen, skriver "ok", og den fylder den billigste kurv. Vi vælger
leveringstid og betaler. Den del gør den aldrig.

I denne session ser vi på, hvordan det virker – og hvorfor det meste af den interessante kode slet
ikke er AI:
- To MCP-servere: én til butikkerne (open source handle-mcp) og én til vores egne opskrifter,
  madplan og indkøbsliste
- Et ugentligt flow med mennesker i loopet: foreslå, godkend, ret, godkend, fyld kurven
- Regler der håndhæves i kode, ikke bare bedes om i en prompt: ingen opfundne opskrifter, kun
  mennesker godkender, og agenten kan aldrig betale
- At lære hvad vi faktisk køber, fx hvor meget mælk en familie på fire drikker

Du går hjem med:
- Et konkret mønster for agenter, der handler på dine vegne, uden at du mister kontrollen
- Princippet "prompten beder, koden bestemmer", og hvordan du bruger det
- Idéer til, hvilke af dine egne ugentlige opgaver der kunne køre på samme måde
