"""Databricks flavour: UC objects, upload of the locally scraped files, job trigger.

Scraping itself always happens locally (Databricks serverless egress gets blocked by
bot protection far more often), so this only moves files and kicks off the SQL build.
"""

from pathlib import Path

from databricks.sdk import WorkspaceClient
from databricks.sdk.service.sql import StatementState


def client(cfg: dict) -> WorkspaceClient:
    return WorkspaceClient(profile=cfg["databricks"]["profile"])


def _warehouse_id(w: WorkspaceClient, cfg: dict) -> str:
    configured = cfg["databricks"].get("warehouse_id")
    if configured:
        return configured
    return next(iter(w.warehouses.list())).id


def run_sql(w: WorkspaceClient, cfg: dict, statement: str) -> None:
    resp = w.statement_execution.execute_statement(
        warehouse_id=_warehouse_id(w, cfg), statement=statement, wait_timeout="50s"
    )
    if resp.status.state != StatementState.SUCCEEDED:
        raise RuntimeError(f"{statement!r} -> {resp.status.state}: {resp.status.error}")


def setup(cfg: dict) -> None:
    """Create catalog, schemas and the raw volume. Must exist before the first upload."""
    w = client(cfg)
    catalog = cfg["databricks"]["catalog"]
    for stmt in [
        f"CREATE CATALOG IF NOT EXISTS {catalog}",
        f"CREATE SCHEMA IF NOT EXISTS {catalog}.bronze",
        f"CREATE SCHEMA IF NOT EXISTS {catalog}.silver",
        f"CREATE SCHEMA IF NOT EXISTS {catalog}.gold",
        f"CREATE VOLUME IF NOT EXISTS {catalog}.bronze.raw",
    ]:
        print(f"  {stmt}")
        run_sql(w, cfg, stmt)


def upload(cfg: dict, raw_cases: Path, stations_csv: Path) -> None:
    w = client(cfg)
    volume = cfg["databricks"]["volume_path"]
    for local, name in [(raw_cases, "cases.jsonl.gz"), (stations_csv, "stations.csv")]:
        with open(local, "rb") as fh:
            w.files.upload(f"{volume}/{name}", fh, overwrite=True)
        print(f"  uploaded {local.name} -> {volume}/{name}")


def run_build_job(cfg: dict) -> None:
    w = client(cfg)
    name = cfg["databricks"]["build_job_name"]
    # development mode prefixes job names with "[dev <user>] "
    jobs = [j for j in w.jobs.list() if j.settings.name.endswith(name)]
    if not jobs:
        raise RuntimeError(f"Job {name!r} not found - run `databricks bundle deploy -p {cfg['databricks']['profile']}` first")
    run = w.jobs.run_now(jobs[0].job_id)
    print(f"  started run {run.response.run_id}, waiting...")
    result = run.result()
    print(f"  {result.state.result_state}: {result.run_page_url}")


def grant_app(cfg: dict, app_name: str) -> None:
    """Let the Databricks App's service principal read the scored data."""
    w = client(cfg)
    sp = w.apps.get(app_name).service_principal_client_id
    catalog = cfg["databricks"]["catalog"]
    run_sql(w, cfg, f"GRANT USE CATALOG, USE SCHEMA, SELECT ON CATALOG {catalog} TO `{sp}`")
    print(f"  granted read on {catalog} to {sp}")
