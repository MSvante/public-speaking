# Abstract

## English

**Title:** Declarative Pipelines, Imperative Problems

Lakeflow Declarative Pipelines promise that you describe what you want and Databricks figures out the rest.

So we took that literally: one generic pipeline file, generated entirely from YAML, turning 111 source tables into 54 trusted dimensions and facts.

Developers never touch the pipeline code. They write config.

In this session we'll walk through how that works in practice:
- A raw layer built on Auto Loader and AUTO CDC
- A driver/satellite pattern on top of Change Data Feed for incremental trusted tables
- PII protection baked into the architecture

And then we'll get to the imperative problems: what happens when a source quietly changes a column type, why stream-static joins don't always do what you think, and why we ended up removing DLT expectations altogether.

You'll leave with:
- A pattern for config-driven Lakeflow Declarative Pipelines that scales from 10 to 100+ tables without touching pipeline code
- Practical recipes for CDC, schema drift and PII that you can lift straight into your own platform
- Honest lessons on where "declarative" ends and engineering begins

## Dansk

**Titel:** Deklarative pipelines, imperative problemer

Lakeflow Declarative Pipelines lover, at du beskriver, hvad du vil have, og så klarer Databricks resten.

Så vi tog det bogstaveligt: én generisk pipeline-fil, genereret udelukkende fra YAML, der forvandler 111 kildetabeller til 54 trusted dimensioner og fakta.

Udviklerne rører aldrig pipeline-koden. De skriver config.

I denne session gennemgår vi, hvordan det fungerer i praksis:
- Et raw-lag bygget på Auto Loader og AUTO CDC
- Et driver/satellit-mønster oven på Change Data Feed til inkrementelle trusted-tabeller
- PII-beskyttelse bygget ind i arkitekturen

Og så kommer vi til de imperative problemer: hvad sker der, når en kilde i al stilhed ændrer en kolonnes datatype, hvorfor stream-static joins ikke altid gør, hvad man tror, og hvorfor vi endte med helt at fjerne DLT expectations.

Du går hjem med:
- Et mønster for config-drevne Lakeflow Declarative Pipelines, der skalerer fra 10 til 100+ tabeller uden at røre pipeline-koden
- Praktiske opskrifter på CDC, schema drift og PII, som du kan løfte direkte over i din egen platform
- Ærlige erfaringer med, hvor "deklarativt" slutter, og hvor engineering begynder
