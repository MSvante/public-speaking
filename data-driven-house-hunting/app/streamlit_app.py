import streamlit as st

from data import TABLE_COLS, column_config, load_listings, sidebar_filters

st.set_page_config(page_title="Boligjagt Midtjylland", page_icon="🏡", layout="wide")

st.title("Boliger til salg i Midtjylland")
st.caption(
    "Villaer og rækkehuse fra Boligsiden. Hver kategori giver 0–10 point i forhold til de andre "
    "boliger i samme kommune (bedste = 10). Total = summen af de 9 kategorier (maks 90)."
)

df = load_listings()
filtered = sidebar_filters(df)

c1, c2, c3 = st.columns(3)
c1.metric("Boliger", f"{len(filtered):,}".replace(",", "."))
c2.metric("Median pris", f"{filtered['pris'].median():,.0f} kr".replace(",", ".") if len(filtered) else "–")
c3.metric("Højeste total score", f"{filtered['score_total'].max():.1f}" if len(filtered) else "–")

st.dataframe(
    filtered[TABLE_COLS],
    column_config=column_config(),
    hide_index=True,
    width="stretch",
    height=700,
)
