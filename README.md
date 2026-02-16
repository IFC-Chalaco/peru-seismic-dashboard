# 🌎 IGP Seismic Data Stream
## Automated Public Seismic Data Pipeline for BI Dashboards
## Flujo Automatizado de Datos Sísmicos Públicos para BI

---

# 🇺🇸 English

## Overview

This project implements a cloud-automated data ingestion pipeline that continuously pulls public seismic data from the official IGP (Instituto Geofisico del Peru) ArcGIS REST service and publishes BI-ready datasets for visualization tools such as Tableau and Power BI.

The objective is to maintain a reliable, incremental, schema-aware public data feed suitable for real-time dashboards and analytics.

**Official public data source:**

https://ide.igp.gob.pe/arcgis/rest/services/monitoreocensis/SismosReportados/MapServer/0

Important data scope note:

- The live ArcGIS layer is near-real-time and may expose only recent/year-to-date events.
- For multi-year history, configure an additional historical CSV/XLSX source. The pipeline can merge historical + live rows automatically.

This repository does NOT host private data.
It consumes publicly available government data and republishes structured derivatives for analytics purposes.

---

## Architecture Summary

This project is a:

- Data ingestion pipeline
- Cloud-automated data feed
- Workflow-orchestrated export system
- Schema-change monitoring system

It is NOT:

- A custom REST API
- A web scraping system
- A proprietary data service

The pipeline consumes an official ArcGIS REST endpoint and republishes structured CSV and GeoJSON files.

---

## What the Pipeline Does

- Incrementally pulls new seismic events using `objectid`
- Optionally imports historical CSV/XLSX data and merges it with the live feed
- Stores full history in SQLite (`raw_events` table)
- Preserves full raw attributes JSON for auditability
- Detects ArcGIS schema changes via metadata inspection
- Regenerates export files on every run:
  - `earthquakes_live.csv` (full flat feed)
  - `earthquakes_live_curated.csv` (recommended BI feed, de-duplicated by event code)
  - `earthquakes_live.geojson` (map feed)
- Includes standardized timestamps:
  - `event_ts_utc`
  - `event_ts_et`
  - `event_date_et`
  - `event_time_et`
- Automatically surfaces new source fields as `src_<fieldname>` columns

If the source schema changes, the pipeline captures new fields immediately without breaking exports.

---

## Data Privacy & Public Safety

This repository:

- Does not store credentials
- Does not store personal data
- Does not expose system secrets
- Does not publish local file paths
- Commits only derived public datasets

Only the following are committed by automation:

- CSV exports
- GeoJSON exports
- `state.json` (heartbeat metadata)

The SQLite database file is NOT published.

---

## Running the Pipeline Locally

Run once:

```bash
python3 seismic_bi_stream/igp_seismic_stream.py
```

If TLS CA issues occur:

```bash
python3 seismic_bi_stream/igp_seismic_stream.py --insecure-skip-verify
```

Run once with historical source:

```bash
python3 seismic_bi_stream/igp_seismic_stream.py \
  --historical-source "https://example.com/igp_historical.xlsx"
```

Run continuously (development mode only):

```bash
python3 seismic_bi_stream/igp_seismic_stream.py --loop --interval-seconds 120
```

Continuous mode is recommended only for local testing.
Production automation is handled by GitHub Actions.

---

## GitHub Actions (Cloud Automation)

The repository includes:

- `.github/workflows/igp-seismic-refresh.yml`
- `.github/workflows/igp-seismic-stale-alert.yml`

### Refresh Workflow

- Runs on a schedule
- Pulls new seismic events
- Rebuilds export files
- Commits updated CSV/GeoJSON
- Updates `state.json`

No local machine is required for updates.

### Enable full history in GitHub Actions

In GitHub:

1. `Settings` -> `Secrets and variables` -> `Actions` -> `Variables`
2. Add `IGP_HISTORICAL_SOURCE_URL` = `<public historical CSV/XLSX URL>`
3. Optional: add `IGP_HISTORICAL_REFRESH_HOURS` = `24`
4. Run `Refresh IGP Seismic Feed` once manually
5. Verify `earthquakes_live_curated.csv` includes older years

If `IGP_HISTORICAL_SOURCE_URL` is empty, the workflow runs live-only mode.

Example official historical source:

`https://www.datosabiertos.gob.pe/sites/default/files/Catalogo1960_2023.xlsx`

---

## Monitoring & Control

### Stale Feed Alert

The workflow `igp-seismic-stale-alert.yml`:

- Checks `state.json` every 10 minutes
- If `last_run_utc` is older than 30 minutes:
  - Opens a GitHub issue:
    `[Alert] IGP seismic feed heartbeat stale`
- Automatically closes the alert issue if the feed recovers

To change alert sensitivity, modify:

`STALE_MINUTES`

inside:

`.github/workflows/igp-seismic-stale-alert.yml`

---

## Output Files

Generated files:

- `seismic_bi_stream/data/state.json`
- `seismic_bi_stream/exports/earthquakes_live.csv`
- `seismic_bi_stream/exports/earthquakes_live_curated.csv`
- `seismic_bi_stream/exports/earthquakes_live.geojson`

Recommended BI feed (clean and de-duplicated):

https://raw.githubusercontent.com/IFC-Chalaco/peru-seismic-dashboard/main/seismic_bi_stream/exports/earthquakes_live_curated.csv

---

## Connecting to Tableau

1. Connect -> Text File
2. Select `earthquakes_live_curated.csv`
3. Assign geospatial roles:
   - `lat` -> Latitude
   - `lon` -> Longitude
4. Use `event_ts_et` for time axis

If using public URL hosting, use text/web-hosted CSV refresh options available in your Tableau environment.

---

## Connecting to Power BI

1. Get Data -> Text/CSV (or Web for raw GitHub URL)
2. Select curated CSV
3. Set `lat` / `lon` data categories
4. Publish to Power BI Service
5. Enable scheduled refresh

---

# 🇪🇸 Español

## Descripcion General

Este proyecto implementa un pipeline automatizado en la nube que consume datos sismicos publicos desde el servicio oficial ArcGIS REST del IGP y publica datasets estructurados listos para Tableau y Power BI.

Fuente oficial publica:

https://ide.igp.gob.pe/arcgis/rest/services/monitoreocensis/SismosReportados/MapServer/0

Nota de alcance:

- La capa ArcGIS en vivo puede incluir solo eventos recientes/del ano en curso.
- Para historial completo, configure una fuente CSV historica y el pipeline hara merge con el feed en vivo.

---

## Que Hace el Pipeline

- Descarga eventos sismicos incrementalmente usando `objectid`
- Puede importar un CSV historico y combinarlo con el feed en vivo
- Guarda historial en SQLite (`raw_events`)
- Preserva atributos originales en JSON
- Detecta cambios en el esquema del ArcGIS
- Regenera:
  - `earthquakes_live.csv`
  - `earthquakes_live_curated.csv`
  - `earthquakes_live.geojson`

No se requiere que una computadora local este encendida cuando GitHub Actions esta activo.
