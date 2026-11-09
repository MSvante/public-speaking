import os
import subprocess
from enum import Enum

import typer

from homescraper.config import ROOT, load_config, local_path

app = typer.Typer(help="Midtjylland house scraper + per-kommune scoring", no_args_is_help=True)


class Target(str, Enum):
    local = "local"
    databricks = "databricks"


@app.command()
def scrape(
    target: Target = typer.Option(Target.local, help="Where to build the tables"),
    skip_scrape: bool = typer.Option(False, help="Reuse the last raw file"),
):
    """Scrape Boligsiden, then build the listings + scored tables."""
    from homescraper.backends.duckdb_backend import raw_cases_path
    from homescraper.source_boligsiden import scrape as run_scrape

    cfg = load_config()
    if not skip_scrape:
        typer.echo("Scraping Boligsiden...")
        n = run_scrape(cfg, raw_cases_path(cfg))
        typer.echo(f"Wrote {n} cases to {raw_cases_path(cfg)}")
    build(target)


@app.command()
def build(target: Target = typer.Option(Target.local)):
    """Build tables from the last raw scrape."""
    cfg = load_config()
    if target == Target.local:
        from homescraper.backends import duckdb_backend

        n = duckdb_backend.build(cfg)
        typer.echo(f"Built gold.listings_scored with {n} rows in {cfg['local']['duckdb_path']}")
    else:
        from homescraper.backends import databricks_backend
        from homescraper.backends.duckdb_backend import raw_cases_path

        databricks_backend.upload(cfg, raw_cases_path(cfg), local_path(cfg["local"]["stations_csv"]))
        databricks_backend.run_build_job(cfg)


@app.command()
def stations():
    """Refresh the station CSV from OpenStreetMap."""
    from homescraper.stations import write_stations

    cfg = load_config()
    n = write_stations(local_path(cfg["local"]["stations_csv"]))
    typer.echo(f"Wrote {n} stations to {cfg['local']['stations_csv']}")


@app.command()
def setup_databricks():
    """Create the homescraper catalog, schemas and raw volume."""
    from homescraper.backends import databricks_backend

    databricks_backend.setup(load_config())


@app.command()
def grant_app(app_name: str = "homescraper"):
    """Grant the Databricks App's service principal read access to the catalog."""
    from homescraper.backends import databricks_backend

    databricks_backend.grant_app(load_config(), app_name)


@app.command()
def ui(target: Target = typer.Option(Target.local, help="Read from local DuckDB or Databricks")):
    """Start the Streamlit app locally."""
    cfg = load_config()
    env = {**os.environ, "HOMESCRAPER_BACKEND": target.value}
    if target == Target.local:
        env["HOMESCRAPER_DUCKDB"] = str(local_path(cfg["local"]["duckdb_path"]))
    else:
        env.setdefault("DATABRICKS_CONFIG_PROFILE", cfg["databricks"]["profile"])
    subprocess.run(
        ["streamlit", "run", str(ROOT / "app" / "streamlit_app.py"), "--server.headless=true"],
        env=env,
        check=True,
    )
