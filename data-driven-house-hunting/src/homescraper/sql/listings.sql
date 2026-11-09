-- Raw Boligsiden cases -> one typed row per listing (villa + rækkehus, for sale).
-- Portable between DuckDB and Databricks SQL; $$-placeholders are filled by render.py.
CREATE OR REPLACE TABLE ${silver}.listings AS
SELECT
  caseID                                        AS case_id,
  CASE addressType WHEN 'villa' THEN 'Villa' ELSE 'Rækkehus' END AS boligtype,
  CAST(address.municipality.municipalityCode AS INT) AS kommune_kode,
  address.municipality.name                     AS kommune,
  concat_ws(' ', address.roadName, address.houseNumber) AS adresse,
  CAST(address.zipCode AS INT)                  AS postnr,
  address.cityName                              AS by_navn,
  CAST(coordinates.lat AS DOUBLE)               AS lat,
  CAST(coordinates.lon AS DOUBLE)               AS lon,
  CAST(priceCash AS BIGINT)                     AS pris,
  CAST(housingArea AS DOUBLE)                   AS boligareal,
  CAST(lotArea AS DOUBLE)                       AS grundareal,
  CAST(perAreaPrice AS DOUBLE)                  AS kvm_pris,
  CAST(monthlyExpense AS DOUBLE)                AS ejerudgift,
  CAST(numberOfRooms AS INT)                    AS vaerelser,
  CAST(yearBuilt AS INT)                        AS byggeaar,
  upper(energyLabel)                            AS energimaerke,
  CASE lower(energyLabel)
    WHEN 'a2020' THEN 9 WHEN 'a2015' THEN 8 WHEN 'a2010' THEN 7 WHEN 'a' THEN 7
    WHEN 'b' THEN 6 WHEN 'c' THEN 5 WHEN 'd' THEN 4 WHEN 'e' THEN 3
    WHEN 'f' THEN 2 WHEN 'g' THEN 1
  END                                           AS energi_rang,
  CAST(daysOnMarket AS INT)                     AS dage_til_salg,
  CAST(priceChangePercentage AS DOUBLE)         AS prisaendring_pct,
  descriptionTitle                              AS overskrift,
  caseUrl                                       AS url,
  ${image_url}                                  AS billede_url
FROM ${raw_cases}
WHERE status = 'open'
  AND addressType IN ('villa', 'terraced house')
  AND address.municipality.municipalityCode IN (${kommune_codes});
