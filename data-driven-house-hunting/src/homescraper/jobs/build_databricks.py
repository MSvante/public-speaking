"""Databricks job entrypoint: run the shared SQL build against the uploaded raw files.

argv[1] is the bundle's synced files root (`${workspace.file_path}`); serverless runs the
script via exec(), so `__file__` is not available here.
"""

import sys

sys.path.insert(0, f"{sys.argv[1]}/src")

from pyspark.sql import SparkSession  # noqa: E402

from homescraper.config import load_config  # noqa: E402
from homescraper.render import BUILD_STEPS, databricks_vars, render  # noqa: E402


def main() -> None:
    spark = SparkSession.builder.getOrCreate()
    cfg = load_config()
    variables = databricks_vars(cfg)
    for step in BUILD_STEPS:
        print(f"Running {step}")
        spark.sql(render(step, variables))
    gold = variables["gold"]
    print(spark.sql(f"SELECT count(*) AS n, max(score_total) AS best FROM {gold}.listings_scored").collect())


if __name__ == "__main__":
    main()
