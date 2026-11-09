# Data-Driven House Hunting

Code and talk material for the session **"Data-Driven House Hunting (What Could Go Wrong?)"**.

The project, called `homescraper` in the code, collects houses for sale (villa and rækkehus) in Region Midtjylland, scores them per kommune, and serves a Danish Streamlit app. It runs locally on DuckDB, and on **Databricks Free Edition** with a Unity Catalog volume, a serverless job and a Databricks App, all deployed with Databricks Asset Bundles.

- `talk/abstract.md` is the session abstract, in English and Danish.
- Slides will be added to `talk/` after the session.

## Data source: read this first

Listings come from the Boligsiden search API (`api.boligsiden.dk`). boliga.dk blocks automated access, and that's respected here. Station locations come from OpenStreetMap (© OpenStreetMap contributors, ODbL).

**Check Boligsiden's terms of use before running the scraper.** This was a personal project, run manually a handful of times, with low concurrency, backoff and an honest user agent. Please keep it that way and don't run it on a schedule.

## How scoring works

Each house gets 0–10 points in 9 categories: pris, boligareal, afstand til station, kvm-pris, grund, ejerudgift, energimærke, byggeår and værelser.

- Points are relative to the other houses in the same kommune.
- Values are clipped to the 5th–95th percentile before scaling.
- A missing value scores 0.
- The total is the unweighted sum, with a maximum of 90.

Scores are computed once in the pipeline, and filters in the app never rescore.

## Local (DuckDB)

```bash
uv sync
uv run homescraper scrape      # ~25 s; scrape + build data/homescraper.duckdb
uv run homescraper ui          # http://localhost:8501
```

## Databricks Free Edition

The bundle and config use a CLI profile called `free_account`. Either create a profile with that name, or change `profile` in `databricks.yml` and `config.toml` to your own.

```bash
databricks auth login --profile free_account
uv run homescraper setup-databricks             # once: catalog, schemas, raw volume
databricks bundle deploy -p free_account        # serverless job + app
uv run homescraper scrape --target databricks   # scrape locally, upload to the volume, run the job
databricks bundle run homescraper -p free_account   # start the app
uv run homescraper grant-app                    # once: let the app's service principal read the catalog
```

Scraping always runs on your own machine, because cloud IPs get blocked much more readily. Databricks only does the processing.

See `CLAUDE.md` for the architecture, the portable-SQL rules and the Databricks gotchas.
