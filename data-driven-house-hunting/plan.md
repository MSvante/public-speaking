# homescraper — Midtjylland house scraper, scoring & Streamlit app

## Context
You want to collect houses for sale (villa + rækkehus) in Region Midtjylland, store them, and explore them in a Streamlit app with filters. Each house gets a 0–10 score per category, relative to the other houses in its kommune. The total is the unweighted sum, so it points to the "theoretically best" house. There are two runnable flavours from one codebase: **local** (DuckDB plus local Streamlit) and **Databricks** (free_account: UC Delta tables, an Asset Bundle job and a Databricks App).

**Source change:** boliga.dk sits behind a Cloudflare managed challenge (both `api.boliga.dk` and the HTML pages return 403 "Just a moment..."). We use the **Boligsiden JSON API** instead (`https://api.boligsiden.dk/search/cases`), which I checked works with plain HTTP. It returns priceCash, housingArea, lotArea, perAreaPrice, monthlyExpense, numberOfRooms, yearBuilt, energyLabel, coordinates, municipality (code/name), caseUrl and images. Caveat: `www.boligsiden.dk/robots.txt` disallows `/api/*` on the www host (the api subdomain is a separate host). Please check Boligsiden's terms before running it regularly.

## Decisions (from Q&A)
- Region Midtjylland (regionCode 1082, 19 kommuner: 615, 657, 661, 665, 671, 706, 707, 710, 727, 730, 740, 741, 746, 751, 756, 760, 766, 779, 791). Types: villa, rækkehus. Status: for sale only. No hard limits.
- Latest snapshot only: each scrape replaces the data, and only current listings are kept.
- Scraping always runs **locally** (manual CLI). The Databricks flavour uploads the raw JSON to a UC volume, then triggers the bundle job that builds the tables.
- Moderate politeness: about 4 concurrent requests, retry with backoff, configurable.
- Scoring: 9 categories, **per kommune**, linear min-max 0–10 after clipping to p5–p95. Missing value = 0. Total = sum (max 90). Computed in the pipeline; filtering never rescores. No weights for now.
- Transforms in **pure SQL** that runs on both DuckDB and Databricks SQL, with a small dialect-macro shim.
- uv + pyproject; git init + .gitignore; project CLAUDE.md. No pytest or ruff for now.
- Databricks: profile `free_account`, single `dev` target, new catalog `homescraper`, layering raw → listings → scored, app reads via SQL warehouse.
- App: Danish UI; views are the sortable table, the kommune leaderboard and house detail/compare. Read-only.

## Scoring categories (direction)
| Kolonne | Kilde | Bedst |
|---|---|---|
| score_pris | priceCash | lowest |
| score_boligareal | housingArea | highest |
| score_station | km to nearest station (haversine) | lowest |
| score_kvm_pris | perAreaPrice | lowest |
| score_grund | lotArea | highest |
| score_ejerudgift | monthlyExpense | lowest |
| score_energi | energyLabel mapped A2020=9 … G=1 | highest |
| score_byggeaar | yearBuilt | highest |
| score_vaerelser | numberOfRooms | highest |

Formula per kommune: `v' = clamp(v, p05, p95)`. For higher-is-better, `10*(v'-p05)/(p95-p05)`; for lower-is-better, it's inverted. If `p95 = p05`, the score is 10. If `v` is NULL, the score is 0. Each score is rounded to 1 decimal. `score_total` is the sum.

## Project layout
```
homescraper/
  pyproject.toml            # uv; deps: httpx, duckdb, streamlit, pandas, databricks-sdk, databricks-sql-connector, typer
  .gitignore  CLAUDE.md  README.md
  config.toml               # region kommune codes, property types, concurrency, backend settings
  data/stations_midtjylland.csv   # committed; DSB/regional rail and Aarhus Letbane (name, type, lat, lon)
  src/homescraper/
    cli.py                  # `homescraper scrape [--target local|databricks]`, `build`, `stations`, `app`
    config.py
    source_boligsiden.py    # paginated client with concurrency, retries and a kommune filter; writes raw JSONL
    stations.py             # one-off Overpass query → data/stations_midtjylland.csv
    sql/
      listings.sql          # raw JSON → flattened, typed listings table (one row per caseID)
      scored.sql            # listings × stations → nearest station + 9 scores + total
    render.py               # tiny macro shim: read_raw(path), pct(col,p), etc. per dialect
    backends/
      duckdb_backend.py     # runs rendered SQL into data/homescraper.duckdb
      databricks_backend.py # uploads JSONL + stations CSV to the UC volume (SDK Files API), triggers the job, sql-connector for queries
  app/
    streamlit_app.py        # "Oversigt": filters and a sortable table with a listing link
    pages/1_Kommune_top.py  # top N per kommune by score_total
    pages/2_Sammenlign.py   # pick houses: score breakdown, images, side-by-side
    data.py                 # query layer: DuckDB if HOMESCRAPER_BACKEND=local, else SQL warehouse
    app.yaml  requirements.txt   # Databricks App entrypoint
  databricks.yml            # bundle "homescraper", target dev (free_account), vars: catalog, warehouse_id
  resources/
    setup.yml               # schemas bronze/silver/gold and volume bronze.raw
    build_job.yml           # SQL-file tasks on the warehouse: listings.sql → scored.sql (no schedule; CLI triggers it)
    app.yml                 # Databricks App with SQL warehouse resource binding
```
SQL dialect points the shim handles: raw read (`read_json_auto` vs `read_files(... format=>'json')`), percentiles (`quantile_cont` vs `percentile`), and table naming (`main.x` vs `homescraper.gold.x`). Haversine, `min_by`, `least` and `greatest` are common to both engines.

Databricks tables: `homescraper.bronze.raw` volume (jsonl and stations.csv), `homescraper.silver.listings`, `homescraper.gold.listings_scored`. The catalog is created with `CREATE CATALOG IF NOT EXISTS` as the first job task. If free edition refuses, the fallback is `workspace` catalog with schema-prefixed names.

## Implementation steps
1. Scaffold: `git init`, uv project, .gitignore (data/*.duckdb, raw/, .venv, .databricks), CLAUDE.md, config.toml.
2. Probe the Boligsiden API to find the working filter params for kommune (e.g. `municipalities=`), address types (`villa`, `terraced house`) and paging (`per_page` max, `totalHits`). If no server-side kommune filter works, filter client-side on `address.municipality.municipalityCode`.
3. Build `source_boligsiden.py`: fetch all pages per kommune × type and dump them to `raw/cases_<ts>.jsonl`.
4. Build `stations.py`: Overpass query (railway=station / halt plus Aarhus Letbane stops within Region Midtjylland's boundary) and commit the CSV.
5. Write `listings.sql`, `scored.sql` and `render.py`, plus the DuckDB backend. Wire up `homescraper scrape --target local`, which scrapes and then builds.
6. Streamlit app (Danish). Filters: kommune, pris, boligareal, værelser, grund, byggeår, boligtype, min. total score. Pages: table, Kommune-top, Sammenlign.
7. Databricks: write the bundle (setup, build job, app). Run `databricks bundle validate/deploy -p free_account`. Write the `databricks_backend` upload and job trigger. Grant the app service principal `USE CATALOG`/`SELECT` on `homescraper`.
8. Write README and CLAUDE.md usage notes.

## Verification
- `uv run homescraper scrape --target local`: the row count should be in the thousands. Then spot-check in DuckDB: only kommune codes in the Midtjylland list, scores within 0–10, `score_total` ≤ 90, and per kommune the cheapest house has `score_pris` = 10 (or is clipped).
- Spot-check 2–3 houses: the station distance should match a map, and the caseUrl should open the right listing.
- `HOMESCRAPER_BACKEND=local uv run streamlit run app/streamlit_app.py`: the filters change the row count but not the scores, and the leaderboard and compare pages render.
- `uv run homescraper scrape --target databricks`: files show up in the volume and the job run succeeds. `SELECT count(*), max(score_total) FROM homescraper.gold.listings_scored` should match the local result.
- `databricks bundle run homescraper_app -p free_account`: the deployed app loads data through the warehouse.
- Before any `deploy` or `run` I'll confirm the profile with you (free_account).
