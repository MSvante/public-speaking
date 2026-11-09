# CLAUDE.md — homescraper

Scrapes houses for sale (villa + rækkehus) in Region Midtjylland from the **Boligsiden** search API, scores them 0–10 per category relative to their kommune, and serves a Danish Streamlit app. One codebase, two flavours: **local** (DuckDB) and **Databricks** (free_account: UC Delta tables, bundle job and Databricks App). The original plan lives in `plan.md`.

## Why Boligsiden, not Boliga
boliga.dk (API and HTML) is behind a Cloudflare managed challenge, so plain HTTP returns 403. `api.boligsiden.dk/search/cases` answers plain HTTP. API quirks:
- `municipalities` must be **repeated** (`?municipalities=aarhus&municipalities=viborg`); comma-joined returns 0 hits.
- `addressTypes` must be **comma-separated** (`villa,terraced house`); repeating it gives a 400.
- `addressTypes` filters on the address, so some condos and farms leak through. `listings.sql` filters again on the case's `addressType`.
- `per_page=500` works.

## Data flow
```
Boligsiden API ──(local, always)──> data/raw/cases.jsonl.gz ─┐
OSM Overpass ──(homescraper stations)──> data/stations_midtjylland.csv (committed)
                                                           │
 local:      DuckDB data/homescraper.duckdb  silver.listings -> gold.listings_scored
 databricks: upload to /Volumes/homescraper/bronze/raw, run job homescraper_build
             -> homescraper.silver.listings -> homescraper.gold.listings_scored
```
Scraping never runs on Databricks; cloud IPs get blocked much more readily. Each scrape replaces the previous snapshot, so no history is kept.

## Key files
- `config.toml`: kommune slug→code map, address types, concurrency, paths, Databricks profile/catalog.
- `src/homescraper/sql/*.sql`: **the single definition of the transforms**, shared by both engines. `${...}` placeholders are filled by `render.py` (table locations, raw readers, image URL expression, kommune codes). Keep the SQL portable: `percentile_cont ... WITHIN GROUP`, `min_by`, `least/greatest` and plain `CROSS JOIN` all work in both engines. Avoid `LATERAL`, 0/1-based array indexing, and literal `${` in comments (`string.Template` will choke on it).
- `src/homescraper/jobs/build_databricks.py`: serverless job entrypoint; runs the same rendered SQL via `spark.sql`.
- `app/`: self-contained Streamlit app (deployed as the Databricks App source; it doesn't import `src/`). `data.py` picks the backend from `HOMESCRAPER_BACKEND` (`local` or `databricks`).

## Scoring (scored.sql)
There are 9 categories: pris↓, boligareal↑, station_km↓, kvm_pris↓, grundareal↑, ejerudgift↓, energi_rang↑ (A2020=9 … G=1), byggeaar↑, vaerelser↑. For each kommune, values are clipped to p05..p95 and then scaled linearly to 0–10, with the best end getting 10. A missing value scores 0, and if p05 = p95 everyone scores 10. `score_total` is the unweighted sum (max 90). Scores are fixed in the pipeline; app filters never rescore.

## Commands
```bash
uv sync
uv run homescraper scrape                       # scrape + build local DuckDB
uv run homescraper build                        # rebuild from last raw file
uv run homescraper ui                           # Streamlit on http://localhost:8501 (local DuckDB)
uv run homescraper stations                     # refresh station CSV from OSM (rarely needed)

# Databricks (profile free_account)
uv run homescraper setup-databricks             # once: catalog, schemas, raw volume
databricks bundle deploy -p free_account        # job + app
uv run homescraper scrape --target databricks   # scrape locally, upload, run build job
databricks bundle run homescraper -p free_account   # start/deploy the app
uv run homescraper grant-app                    # once: app SP may read the catalog
uv run homescraper ui --target databricks       # local Streamlit against the warehouse
```
Always confirm the profile is `free_account` before deploy or run commands.

## Databricks gotchas
- The bundle uses `engine: direct`, because CLI v0.293's Terraform download fails with "openpgp: key expired".
- Development mode prefixes the job name (`[dev <user>] homescraper_build`), so `run_build_job` matches it by suffix. The app keeps the plain name `homescraper`.
- Serverless `spark_python_task` scripts have no `__file__`, so the job passes `${workspace.file_path}` as argv[1].
- The raw scrape is about 270 MB uncompressed (images, realtor info), so it's stored and uploaded as `.jsonl.gz` (~35 MB). Both engines read the gzip directly.
