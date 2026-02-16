# 🌎 IGP Seismic Data Stream
## Automated Public Seismic Data Pipeline for BI Dashboards
## Flujo Automatizado de Datos Sísmicos Públicos para BI

---

# 🇺🇸 English

## Overview

This project implements a cloud-automated data ingestion pipeline that continuously pulls public seismic data from the official IGP (Instituto Geofísico del Perú) ArcGIS REST service and publishes BI-ready datasets for visualization tools such as Tableau and Power BI.

The objective is to maintain a reliable, incremental, schema-aware public data feed suitable for real-time dashboards and analytics.

**Official public data source:**

https://ide.igp.gob.pe/arcgis/rest/services/monitoreocensis/SismosReportados/MapServer/0

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
- Stores full history in SQLite (`raw_events` table)
- Preserves full raw attributes JSON for auditability
- Detects ArcGIS schema changes via metadata inspection
- Regenerates export files on every run:
  - `earthquakes_live.csv` (full flat feed)
  - `earthquakes_live_curated.csv` (recommended BI feed)
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

Recommended BI feed (clean dataset):

`earthquakes_live_curated.csv`

---

## Connecting to Tableau

1. Connect → Text File
2. Select `earthquakes_live_curated.csv`
3. Assign geospatial roles:
   - `lat` → Latitude
   - `lon` → Longitude
4. Use `event_ts_et` for time axis

If using public URL hosting, use Web Data Connector refresh.

---

## Connecting to Power BI

1. Get Data → Text/CSV
2. Select curated CSV
3. Set `lat` / `lon` data categories
4. Publish to Power BI Service
5. Enable scheduled refresh (web source if hosted publicly)

---

## Recommended Portfolio Terminology

Use the following professional terms:

- Data ingestion pipeline
- Cloud-automated data feed
- Incremental ETL system
- Schema-change detection
- Workflow orchestration
- Public data transformation layer

---

# 🇪🇸 Español

## Descripción General

Este proyecto implementa un pipeline automatizado en la nube que consume datos sísmicos públicos desde el servicio oficial ArcGIS REST del IGP (Instituto Geofísico del Perú) y publica datasets estructurados listos para herramientas de Business Intelligence como Tableau y Power BI.

El objetivo es mantener un flujo de datos incremental, confiable y resistente a cambios de esquema, apto para dashboards en tiempo real.

Fuente oficial pública:

https://ide.igp.gob.pe/arcgis/rest/services/monitoreocensis/SismosReportados/MapServer/0

Este repositorio:

- No contiene datos privados
- No expone credenciales
- No almacena información personal
- Solo transforma y republica datos públicos

---

## Qué Hace el Pipeline

- Descarga eventos sísmicos incrementalmente usando `objectid`
- Guarda historial en SQLite (`raw_events`)
- Preserva atributos originales en JSON
- Detecta cambios en el esquema del ArcGIS
- Regenera en cada ejecución:
  - `earthquakes_live.csv`
  - `earthquakes_live_curated.csv`
  - `earthquakes_live.geojson`
- Incluye timestamps estandarizados:
  - `event_ts_utc`
  - `event_ts_et`
  - `event_date_et`
  - `event_time_et`
- Si la fuente agrega un nuevo campo, se refleja automáticamente como `src_<campo>`

---

## Automatización y Monitoreo

Incluye:

- `igp-seismic-refresh.yml`
- `igp-seismic-stale-alert.yml`

El sistema:

- Ejecuta el pipeline automáticamente
- Actualiza exportaciones
- Monitorea el estado del feed
- Abre y cierra alertas automáticamente si detecta interrupciones

No se requiere que una computadora local esté encendida.

---

## Terminología Profesional Recomendada

- Pipeline de ingestión de datos
- Flujo automatizado en la nube
- Sistema ETL incremental
- Monitoreo de cambios de esquema
- Orquestación de workflows
- Transformación de datos públicos
