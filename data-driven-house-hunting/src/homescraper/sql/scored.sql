-- Listings + nearest station + 0-10 score per category, relative to the listing's kommune.
-- Score = linear min-max on the value clipped to the kommune's p05..p95; missing value = 0;
-- if p05 = p95 everyone gets 10. score_total = unweighted sum (max 90).
CREATE OR REPLACE TABLE ${gold}.listings_scored AS
WITH stations AS (
  SELECT name, type, CAST(lat AS DOUBLE) AS lat, CAST(lon AS DOUBLE) AS lon
  FROM ${raw_stations}
),
distances AS (
  -- haversine, km
  SELECT
    l.case_id, s.name, s.type,
    2 * 6371 * asin(sqrt(
      power(sin(radians(s.lat - l.lat) / 2), 2)
      + cos(radians(l.lat)) * cos(radians(s.lat)) * power(sin(radians(s.lon - l.lon) / 2), 2)
    )) AS km
  FROM ${silver}.listings l
  CROSS JOIN stations s
  WHERE l.lat IS NOT NULL
),
nearest AS (
  SELECT
    case_id,
    min(km)             AS station_km,
    min_by(name, km)    AS station_navn,
    min_by(type, km)    AS station_type
  FROM distances
  GROUP BY case_id
),
base AS (
  SELECT l.*, round(n.station_km, 2) AS station_km, n.station_navn, n.station_type
  FROM ${silver}.listings l
  LEFT JOIN nearest n ON n.case_id = l.case_id
),
bounds AS (
  SELECT
    kommune_kode,
    percentile_cont(0.05) WITHIN GROUP (ORDER BY pris)        AS pris_lo,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY pris)        AS pris_hi,
    percentile_cont(0.05) WITHIN GROUP (ORDER BY boligareal)  AS boligareal_lo,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY boligareal)  AS boligareal_hi,
    percentile_cont(0.05) WITHIN GROUP (ORDER BY station_km)  AS station_lo,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY station_km)  AS station_hi,
    percentile_cont(0.05) WITHIN GROUP (ORDER BY kvm_pris)    AS kvm_pris_lo,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY kvm_pris)    AS kvm_pris_hi,
    percentile_cont(0.05) WITHIN GROUP (ORDER BY grundareal)  AS grund_lo,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY grundareal)  AS grund_hi,
    percentile_cont(0.05) WITHIN GROUP (ORDER BY ejerudgift)  AS ejerudgift_lo,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY ejerudgift)  AS ejerudgift_hi,
    percentile_cont(0.05) WITHIN GROUP (ORDER BY energi_rang) AS energi_lo,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY energi_rang) AS energi_hi,
    percentile_cont(0.05) WITHIN GROUP (ORDER BY byggeaar)    AS byggeaar_lo,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY byggeaar)    AS byggeaar_hi,
    percentile_cont(0.05) WITHIN GROUP (ORDER BY vaerelser)   AS vaerelser_lo,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY vaerelser)   AS vaerelser_hi
  FROM base
  GROUP BY kommune_kode
),
scored AS (
  SELECT
    b.*,
    -- lower is better
    CASE WHEN b.pris IS NULL THEN 0 WHEN k.pris_hi <= k.pris_lo THEN 10
      ELSE round(10 * (k.pris_hi - least(greatest(b.pris, k.pris_lo), k.pris_hi)) / (k.pris_hi - k.pris_lo), 1)
    END AS score_pris,
    -- higher is better
    CASE WHEN b.boligareal IS NULL THEN 0 WHEN k.boligareal_hi <= k.boligareal_lo THEN 10
      ELSE round(10 * (least(greatest(b.boligareal, k.boligareal_lo), k.boligareal_hi) - k.boligareal_lo) / (k.boligareal_hi - k.boligareal_lo), 1)
    END AS score_boligareal,
    -- lower is better
    CASE WHEN b.station_km IS NULL THEN 0 WHEN k.station_hi <= k.station_lo THEN 10
      ELSE round(10 * (k.station_hi - least(greatest(b.station_km, k.station_lo), k.station_hi)) / (k.station_hi - k.station_lo), 1)
    END AS score_station,
    -- lower is better
    CASE WHEN b.kvm_pris IS NULL THEN 0 WHEN k.kvm_pris_hi <= k.kvm_pris_lo THEN 10
      ELSE round(10 * (k.kvm_pris_hi - least(greatest(b.kvm_pris, k.kvm_pris_lo), k.kvm_pris_hi)) / (k.kvm_pris_hi - k.kvm_pris_lo), 1)
    END AS score_kvm_pris,
    -- higher is better
    CASE WHEN b.grundareal IS NULL THEN 0 WHEN k.grund_hi <= k.grund_lo THEN 10
      ELSE round(10 * (least(greatest(b.grundareal, k.grund_lo), k.grund_hi) - k.grund_lo) / (k.grund_hi - k.grund_lo), 1)
    END AS score_grund,
    -- lower is better
    CASE WHEN b.ejerudgift IS NULL THEN 0 WHEN k.ejerudgift_hi <= k.ejerudgift_lo THEN 10
      ELSE round(10 * (k.ejerudgift_hi - least(greatest(b.ejerudgift, k.ejerudgift_lo), k.ejerudgift_hi)) / (k.ejerudgift_hi - k.ejerudgift_lo), 1)
    END AS score_ejerudgift,
    -- higher is better
    CASE WHEN b.energi_rang IS NULL THEN 0 WHEN k.energi_hi <= k.energi_lo THEN 10
      ELSE round(10 * (least(greatest(b.energi_rang, k.energi_lo), k.energi_hi) - k.energi_lo) / (k.energi_hi - k.energi_lo), 1)
    END AS score_energi,
    -- higher is better
    CASE WHEN b.byggeaar IS NULL THEN 0 WHEN k.byggeaar_hi <= k.byggeaar_lo THEN 10
      ELSE round(10 * (least(greatest(b.byggeaar, k.byggeaar_lo), k.byggeaar_hi) - k.byggeaar_lo) / (k.byggeaar_hi - k.byggeaar_lo), 1)
    END AS score_byggeaar,
    -- higher is better
    CASE WHEN b.vaerelser IS NULL THEN 0 WHEN k.vaerelser_hi <= k.vaerelser_lo THEN 10
      ELSE round(10 * (least(greatest(b.vaerelser, k.vaerelser_lo), k.vaerelser_hi) - k.vaerelser_lo) / (k.vaerelser_hi - k.vaerelser_lo), 1)
    END AS score_vaerelser
  FROM base b
  JOIN bounds k ON k.kommune_kode = b.kommune_kode
)
SELECT
  *,
  round(score_pris + score_boligareal + score_station + score_kvm_pris + score_grund
    + score_ejerudgift + score_energi + score_byggeaar + score_vaerelser, 1) AS score_total
FROM scored;
