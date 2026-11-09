import streamlit as st

from data import column_config, load_listings, sidebar_filters

st.set_page_config(page_title="Kommune-top", page_icon="🏆", layout="wide")
st.title("Bedste boliger pr. kommune")

df = load_listings()
filtered = sidebar_filters(df)
top_n = st.slider("Antal pr. kommune", 1, 20, 5)

top = (
    filtered.sort_values("score_total", ascending=False)
    .groupby("kommune", group_keys=False)
    .head(top_n)
    .assign(placering=lambda d: d.groupby("kommune").cumcount() + 1)
)

cols = ["placering", "score_total", "adresse", "by_navn", "boligtype", "pris", "boligareal",
        "grundareal", "station_navn", "station_km", "url"]
config = {**column_config(), "placering": st.column_config.NumberColumn("#", width="small")}

for kommune, group in top.groupby("kommune", sort=True):
    best = group["score_total"].iloc[0]
    with st.expander(f"{kommune} — bedste score {best:.1f}", expanded=False):
        st.dataframe(group[cols], column_config=config, hide_index=True, width="stretch")
