"""Fill the ${...} placeholders in sql/*.sql for a given engine.

Only table locations and raw-file readers differ between DuckDB and Databricks SQL;
the transform logic itself is shared.
"""

from pathlib import Path
from string import Template

SQL_DIR = Path(__file__).parent / "sql"
BUILD_STEPS = ["listings.sql", "scored.sql"]


def duckdb_vars(cfg: dict, raw_cases: Path, stations_csv: Path) -> dict:
    return {
        "silver": "silver",
        "gold": "gold",
        "raw_cases": f"read_json_auto('{raw_cases.as_posix()}', format='newline_delimited', sample_size=-1)",
        "raw_stations": f"read_csv_auto('{stations_csv.as_posix()}', header=true)",
        # DuckDB lists are 1-based but support negative indexes; take the largest image
        "image_url": "defaultImage.imageSources[-1].url",
        "kommune_codes": ", ".join(str(c) for c in cfg["kommuner"].values()),
    }


def databricks_vars(cfg: dict) -> dict:
    catalog = cfg["databricks"]["catalog"]
    volume = cfg["databricks"]["volume_path"]
    return {
        "silver": f"{catalog}.silver",
        "gold": f"{catalog}.gold",
        "raw_cases": f"read_files('{volume}/cases.jsonl.gz', format => 'json')",
        "raw_stations": f"read_files('{volume}/stations.csv', format => 'csv', header => true)",
        "image_url": "element_at(defaultImage.imageSources, -1).url",
        "kommune_codes": ", ".join(str(c) for c in cfg["kommuner"].values()),
    }


def render(step: str, variables: dict) -> str:
    return Template((SQL_DIR / step).read_text(encoding="utf-8")).substitute(variables)
