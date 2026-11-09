"""One-off: fetch train stations and Aarhus Letbane stops from OpenStreetMap (Overpass).

Uses a bounding box slightly larger than Region Midtjylland so houses near the border
can match a closer station just outside it. Heritage/museum railways are dropped.
"""

import csv
import time
from pathlib import Path

import httpx

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
# south, west, north, east
BBOX = (55.5, 7.9, 57.1, 11.1)
# amusement-park / toy trains that OSM tags as stations
NAME_BLOCKLIST = {"Lego Tog", "Victoria Street Station"}
QUERY = f"""[out:json][timeout:90];
(nwr["railway"~"^(station|halt)$"]{BBOX};);
out center tags;"""


def _is_heritage(tags: dict) -> bool:
    text = " ".join(f"{k}={v}" for k, v in tags.items()).lower()
    return any(w in text for w in ("usage=tourism", "historic", "preserved", "museum", "heritage"))


def _station_type(tags: dict) -> str:
    if tags.get("station") == "light_rail" or tags.get("light_rail") == "yes":
        return "letbane"
    return "tog"


def fetch_overpass() -> list[dict]:
    for attempt in range(6):
        url = ENDPOINTS[attempt % len(ENDPOINTS)]
        try:
            resp = httpx.post(
                url,
                data={"data": QUERY},
                timeout=120,
                headers={"User-Agent": "homescraper/0.1 (personal project)"},
            )
            if resp.status_code == 200:
                return resp.json()["elements"]
        except (httpx.TransportError, ValueError):
            pass
        time.sleep(5 * 2**attempt)
    raise RuntimeError("All Overpass endpoints failed")


def write_stations(out_path: Path) -> int:
    rows = {}
    for el in fetch_overpass():
        tags = el.get("tags", {})
        name = tags.get("name")
        if not name or name in NAME_BLOCKLIST or _is_heritage(tags) or tags.get("station") in ("tram", "subway"):
            continue
        lat = el.get("lat") or el.get("center", {}).get("lat")
        lon = el.get("lon") or el.get("center", {}).get("lon")
        stype = _station_type(tags)
        # OSM often has both a node and an area for the same station; keep one per name+type
        rows.setdefault((name, stype), {"name": name, "type": stype, "lat": lat, "lon": lon})
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=["name", "type", "lat", "lon"])
        writer.writeheader()
        writer.writerows(sorted(rows.values(), key=lambda r: r["name"]))
    return len(rows)
