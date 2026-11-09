# Declarative Pipelines, Imperative Problems

*Dansk: Deklarative pipelines, imperative problemer*

A conference talk by Mathias Eriksen about building a config-driven data platform with **Lakeflow Declarative Pipelines** on Databricks, and about the places where "declarative" stopped being enough.

> Lakeflow Declarative Pipelines promise that you describe what you want and Databricks figures out the rest. So we took that literally: one generic pipeline file, generated entirely from YAML, turning 111 source tables into trusted dimensions and facts. Developers never touch the pipeline code. They write config.

This folder holds the talk material only, not the platform code.

| File | What it is |
|---|---|
| [`talk/abstract.md`](talk/abstract.md) | Session abstract in English and Danish |
| Slides | Added to `talk/` after the session |

## Companion code

The patterns from the talk, applied to generic example tables, are in
**<https://github.com/MSvante/public_databricks_accelerator>**.

All table names in the talk are generic stand-ins. The talk is anonymised and contains no client code.
