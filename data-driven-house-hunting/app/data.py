"""Load the scored listings from DuckDB (local) or a Databricks SQL warehouse.

The scored table is small (a few thousand rows), so it is loaded once and filtered
in pandas. Scores are fixed by the pipeline; filtering never rescores.
"""

import os

import pandas as pd
import streamlit as st

BACKEND = os.getenv("HOMESCRAPER_BACKEND", "databricks")
DUCKDB_PATH = os.getenv("HOMESCRAPER_DUCKDB", "data/homescraper.duckdb")
DATABRICKS_TABLE = os.getenv("HOMESCRAPER_TABLE", "homescraper.gold.listings_scored")

SCORE_COLS = {
    "score_pris": "Pris",
    "score_boligareal": "Boligareal",
    "score_station": "Afstand til station",
    "score_kvm_pris": "Kvm-pris",
    "score_grund": "Grund",
    "score_ejerudgift": "Ejerudgift",
    "score_energi": "Energimærke",
    "score_byggeaar": "Byggeår",
    "score_vaerelser": "Værelser",
}


def _load_duckdb() -> pd.DataFrame:
    import duckdb

    with duckdb.connect(DUCKDB_PATH, read_only=True) as con:
        return con.sql("SELECT * FROM gold.listings_scored").df()


def _load_databricks() -> pd.DataFrame:
    from databricks import sql
    from databricks.sdk.core import Config

    # In a Databricks App, host + service principal creds come from the environment;
    # locally, DATABRICKS_CONFIG_PROFILE picks the profile.
    cfg = Config()
    warehouse_id = os.getenv("DATABRICKS_WAREHOUSE_ID")
    if not warehouse_id:
        from databricks.sdk import WorkspaceClient

        warehouse_id = next(iter(WorkspaceClient(config=cfg).warehouses.list())).id
    with sql.connect(
        server_hostname=cfg.host,
        http_path=f"/sql/1.0/warehouses/{warehouse_id}",
        credentials_provider=lambda: cfg.authenticate,
    ) as conn, conn.cursor() as cur:
        cur.execute(f"SELECT * FROM {DATABRICKS_TABLE}")
        return cur.fetchall_arrow().to_pandas()


@st.cache_data(ttl=3600, show_spinner="Henter boliger...")
def load_listings() -> pd.DataFrame:
    df = _load_duckdb() if BACKEND == "local" else _load_databricks()
    return df.sort_values("score_total", ascending=False).reset_index(drop=True)


def _range_mask(df: pd.DataFrame, col: str, label: str, step) -> pd.Series:
    """Range slider; listings with a missing value only drop out once the range is narrowed."""
    values = df[col].dropna()
    lo, hi = type(step)(values.min()), type(step)(values.max())
    key = f"f_{col}"
    st.session_state.setdefault(key, (lo, hi))
    chosen = st.sidebar.slider(label, lo, hi, step=step, key=key)
    if tuple(chosen) == (lo, hi):
        return pd.Series(True, index=df.index)
    return df[col].between(*chosen)


def _keep_widget_state() -> None:
    # Streamlit drops widget state when switching pages; re-assigning keeps filters
    for key in list(st.session_state):
        if key.startswith("f_"):
            st.session_state[key] = st.session_state[key]


def sidebar_filters(df: pd.DataFrame) -> pd.DataFrame:
    """Render the shared filter sidebar and return the filtered frame."""
    _keep_widget_state()
    st.sidebar.header("Filtre")
    kommuner = st.sidebar.multiselect("Kommune", sorted(df["kommune"].unique()), key="f_kommune")
    typer = st.sidebar.multiselect("Boligtype", sorted(df["boligtype"].unique()), key="f_boligtype")
    mask = (
        _range_mask(df, "pris", "Pris (kr)", 25_000)
        & _range_mask(df, "boligareal", "Boligareal (m²)", 5.0)
        & _range_mask(df, "vaerelser", "Værelser", 1)
        & _range_mask(df, "grundareal", "Grundareal (m²)", 50.0)
        & _range_mask(df, "byggeaar", "Byggeår", 1)
    )
    st.session_state.setdefault("f_min_score", 0.0)
    min_score = st.sidebar.slider("Min. total score", 0.0, 90.0, step=1.0, key="f_min_score")
    mask &= df["score_total"] >= min_score
    if kommuner:
        mask &= df["kommune"].isin(kommuner)
    if typer:
        mask &= df["boligtype"].isin(typer)
    return df[mask]


def column_config() -> dict:
    cfg = {
        "url": st.column_config.LinkColumn("Link", display_text="Se bolig"),
        "billede_url": st.column_config.ImageColumn("Billede"),
        "kommune": "Kommune",
        "adresse": "Adresse",
        "by_navn": "By",
        "boligtype": "Type",
        "pris": st.column_config.NumberColumn("Pris (kr)", format="localized"),
        "boligareal": st.column_config.NumberColumn("Boligareal (m²)", format="%d"),
        "grundareal": st.column_config.NumberColumn("Grund (m²)", format="%d"),
        "kvm_pris": st.column_config.NumberColumn("Kvm-pris (kr)", format="localized"),
        "ejerudgift": st.column_config.NumberColumn("Ejerudgift/md (kr)", format="localized"),
        "vaerelser": "Værelser",
        "byggeaar": st.column_config.NumberColumn("Byggeår", format="%d"),
        "energimaerke": "Energi",
        "station_navn": "Nærmeste station",
        "station_km": st.column_config.NumberColumn("Station (km)", format="%.1f"),
        "score_total": st.column_config.ProgressColumn(
            "Total score", min_value=0, max_value=90, format="%.1f"
        ),
    }
    for col, label in SCORE_COLS.items():
        cfg[col] = st.column_config.NumberColumn(label, format="%.1f")
    return cfg


TABLE_COLS = [
    "billede_url", "score_total", "kommune", "adresse", "by_navn", "boligtype", "pris",
    "boligareal", "grundareal", "kvm_pris", "ejerudgift", "vaerelser", "byggeaar",
    "energimaerke", "station_navn", "station_km", *SCORE_COLS, "url",
]
