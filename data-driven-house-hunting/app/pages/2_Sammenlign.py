import pandas as pd
import streamlit as st

from data import SCORE_COLS, load_listings, sidebar_filters

st.set_page_config(page_title="Sammenlign", page_icon="⚖️", layout="wide")
st.title("Sammenlign boliger")

df = load_listings()
filtered = sidebar_filters(df)
if filtered.empty:
    st.info("Ingen boliger matcher filtrene.")
    st.stop()

labels = {
    r.case_id: f"{r.adresse}, {r.by_navn} — {r.pris:,.0f} kr (score {r.score_total:.1f})".replace(",", ".")
    for r in filtered.itertuples()
}
chosen = st.multiselect(
    "Vælg boliger (op til 4)",
    options=list(labels),
    default=list(labels)[:3],
    format_func=labels.get,
    max_selections=4,
)
if not chosen:
    st.stop()

houses = filtered.set_index("case_id").loc[chosen]

for col, (_, h) in zip(st.columns(len(chosen)), houses.iterrows()):
    with col:
        if isinstance(h["billede_url"], str):
            st.image(h["billede_url"], width="stretch")
        st.subheader(h["adresse"])
        st.caption(f"{h['by_navn']} · {h['kommune']} · {h['boligtype']}")
        st.metric("Total score", f"{h['score_total']:.1f} / 90")
        st.link_button("Se bolig", h["url"])

FACTS = {
    "pris": ("Pris (kr)", "{:,.0f}"),
    "boligareal": ("Boligareal (m²)", "{:.0f}"),
    "grundareal": ("Grund (m²)", "{:.0f}"),
    "kvm_pris": ("Kvm-pris (kr)", "{:,.0f}"),
    "ejerudgift": ("Ejerudgift/md (kr)", "{:,.0f}"),
    "vaerelser": ("Værelser", "{:.0f}"),
    "byggeaar": ("Byggeår", "{:.0f}"),
    "energimaerke": ("Energimærke", "{}"),
    "station_km": ("Afstand til station (km)", "{:.1f}"),
    "station_navn": ("Nærmeste station", "{}"),
}


def fmt(value, pattern):
    if pd.isna(value):
        return "–"
    return pattern.format(value).replace(",", ".")


st.subheader("Fakta")
facts = pd.DataFrame(
    {h["adresse"]: [fmt(h[c], p) for c, (_, p) in FACTS.items()] for _, h in houses.iterrows()},
    index=[label for label, _ in FACTS.values()],
)
st.dataframe(facts, width="stretch")

st.subheader("Point pr. kategori (0–10, i forhold til kommunen)")
scores = pd.DataFrame(
    {h["adresse"]: [h[c] for c in SCORE_COLS] for _, h in houses.iterrows()},
    index=list(SCORE_COLS.values()),
)
st.dataframe(
    scores,
    width="stretch",
    column_config={
        name: st.column_config.ProgressColumn(name, min_value=0, max_value=10, format="%.1f")
        for name in scores.columns
    },
)
