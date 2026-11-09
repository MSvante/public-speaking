# Abstract

## English

**Title:** Data-Driven House Hunting (What Could Go Wrong?)

When my family started looking for a house, I did what any data engineer would do: I built a data product to find it.
It ingested every listing in the region, scored each house against its neighbours, and served the shortlist in an app my partner could actually use, all on Databricks.

In this session we'll build that journey end to end: from raw files in a Unity Catalog volume, through a serverless job deployed with Databricks Asset Bundles, to scored gold tables and a Databricks App on top.
Along the way we'll look at the decisions that shape any scoring model: what "best" means, how to compare fairly, and what to do with missing data.

And then we'll look at what happened when the data met the real world, and why we ended up buying a house that the app never showed us.

You'll leave with:
- Practical patterns for scoring and ranking that hold up: relative scores, outlier clipping and handling missing data
- Everything you need to build your own version on Databricks Free Edition
- A fun story about what happens when you get too focused on data and code, and forget people.

## Dansk

**Titel:** Datadrevet boligjagt (hvad kan gå galt?)

Da min familie begyndte at lede efter et hus, gjorde jeg det, enhver data engineer ville gøre: Jeg byggede et dataprodukt til at finde det.
Det indsamlede alle boliger til salg i regionen, scorede hvert hus i forhold til naboerne og præsenterede shortlisten i en app, som min partner faktisk kunne bruge – alt sammen på Databricks.

I denne session bygger vi hele rejsen fra start til slut: fra rå filer i et Unity Catalog volume, gennem et serverless job deployet med Databricks Asset Bundles, til scorede gold-tabeller og en Databricks App ovenpå.
Undervejs ser vi på de beslutninger, der former enhver scoringsmodel: hvad betyder "bedst", hvordan sammenligner man fair, og hvad gør man med manglende data?

Og så ser vi på, hvad der skete, da data mødte virkeligheden – og hvorfor vi endte med at købe et hus, som appen aldrig viste os.

Du går hjem med:
- Praktiske mønstre til scoring og ranking, der holder: relative scores, outlier-klipning og håndtering af manglende data
- Alt, hvad du skal bruge for at bygge din egen version på Databricks Free Edition
- En sjov historie om, hvad der sker, når man bliver for fokuseret på data og kode og glemmer menneskene
