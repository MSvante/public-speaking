import duckdb

from homescraper.config import local_path
from homescraper.render import BUILD_STEPS, duckdb_vars, render


def raw_cases_path(cfg: dict):
    return local_path(cfg["local"]["raw_dir"]) / "cases.jsonl.gz"


def build(cfg: dict) -> int:
    variables = duckdb_vars(cfg, raw_cases_path(cfg), local_path(cfg["local"]["stations_csv"]))
    with duckdb.connect(str(local_path(cfg["local"]["duckdb_path"]))) as con:
        con.execute("CREATE SCHEMA IF NOT EXISTS silver; CREATE SCHEMA IF NOT EXISTS gold;")
        for step in BUILD_STEPS:
            con.execute(render(step, variables))
        return con.execute("SELECT count(*) FROM gold.listings_scored").fetchone()[0]
