"""Fetch for-sale listings from the Boligsiden search API and write them as raw JSONL.

Quirks of the API (found by probing):
- `municipalities` is an exploded param (repeat it), `addressTypes` is comma-separated.
- `addressTypes` filters on the address, so a few condos/farms slip through; the SQL
  layer filters again on the case's own `addressType`.
"""

import gzip
import json
import math
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx

RETRY_STATUS = {429, 500, 502, 503, 504}


class BoligsidenClient:
    def __init__(self, cfg: dict):
        src = cfg["source"]
        self.base_url = src["base_url"]
        self.address_types = ",".join(src["address_types"])
        self.per_page = src["per_page"]
        self.concurrency = src["concurrency"]
        self.max_retries = src["max_retries"]
        self.http = httpx.Client(
            timeout=src["timeout_seconds"], headers={"User-Agent": src["user_agent"]}
        )

    def _get_page(self, municipality: str, page: int) -> dict:
        params = {
            "municipalities": municipality,
            "addressTypes": self.address_types,
            "per_page": self.per_page,
            "page": page,
        }
        for attempt in range(self.max_retries):
            try:
                resp = self.http.get(self.base_url, params=params)
                if resp.status_code not in RETRY_STATUS:
                    resp.raise_for_status()
                    return resp.json()
            except httpx.TransportError:
                pass
            time.sleep(2**attempt)
        raise RuntimeError(f"Giving up on {municipality} page {page}")

    def fetch_municipality(self, municipality: str) -> list[dict]:
        first = self._get_page(municipality, 1)
        cases = list(first.get("cases") or [])
        pages = math.ceil(first.get("totalHits", 0) / self.per_page)
        for page in range(2, pages + 1):
            cases.extend(self._get_page(municipality, page).get("cases") or [])
        return cases

    def fetch_all(self, municipalities: list[str]) -> list[dict]:
        with ThreadPoolExecutor(max_workers=self.concurrency) as pool:
            results = pool.map(self.fetch_municipality, municipalities)
            by_id = {}
            for slug, cases in zip(municipalities, results):
                print(f"  {slug}: {len(cases)} cases")
                for case in cases:
                    by_id[case["caseID"]] = case
        return list(by_id.values())


def scrape(cfg: dict, out_path: Path) -> int:
    client = BoligsidenClient(cfg)
    cases = client.fetch_all(list(cfg["kommuner"]))
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(out_path, "wt", encoding="utf-8") as f:
        for case in cases:
            f.write(json.dumps(case, ensure_ascii=False) + "\n")
    return len(cases)
