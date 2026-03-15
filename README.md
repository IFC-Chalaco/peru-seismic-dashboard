# 🌎 IGP Seismic Data Pipeline
### Historical + Live Unified Seismic Feed
### Pipeline Automatizado de Datos Sísmicos Históricos + En Vivo

![Build](https://img.shields.io/badge/build-GitHub%20Actions-success)
![Data Coverage](https://img.shields.io/badge/coverage-1960--2026-blue)
![Data Source](https://img.shields.io/badge/source-IGP%20Official-green)
![License](https://img.shields.io/badge/license-MIT-lightgrey)

---

# 🇺🇸 English

## 📌 Overview

This project implements a cloud-automated seismic data pipeline that continuously ingests public earthquake data from official IGP (Instituto Geofisico del Peru) sources and publishes analysis-ready outputs for BI, GIS, and web delivery.

The pipeline combines:

- 📚 Official historical catalog (`1960-2020` slice from the government XLSX source)
- 🗂 Annual report feed from `ultimosismo.igp.gob.pe` (`2020-current year`)
- ⚡ Live ArcGIS REST seismic feed for the latest events

into one curated dataset spanning historical and current seismic activity.

All ingestion, transformation, export, monitoring, and website refresh steps run in GitHub Actions. No local machine is required for production refreshes.

---

## 📊 Interactive Dashboard

### Live GitHub Pages Dashboard

🔗 [https://ifc-chalaco.github.io/peru-seismic-dashboard/](https://ifc-chalaco.github.io/peru-seismic-dashboard/)

This repository now uses a native HTML dashboard as the primary public-facing experience.

### Why move away from Tableau Public?

Tableau Public was useful for prototyping and visual design, but it was not a good fit for near-live publishing in this project.

Main reasons:

- Tableau Public relies on extract refresh behavior rather than a true live web feed.
- When Google Sheets was used as an intermediary, refresh timing added another delay layer.
- The GitHub Actions pipeline refreshes the seismic feed much more frequently than Tableau Public can reliably reflect.
- A native HTML dashboard on GitHub Pages can read the published CSV and metadata files directly, so the website updates with the same automated pipeline that produces the datasets.

In short: the HTML dashboard removes unnecessary refresh bottlenecks and keeps the public site closer to the live feed.

### Legacy Tableau Public Reference

Tableau Public remains as an earlier presentation artifact:

🔗 [https://public.tableau.com/views/ReportesSismicosPeru/Dashboard1](https://public.tableau.com/views/ReportesSismicosPeru/Dashboard1)

It is no longer the primary delivery layer for the live public dashboard.

---

## 🧱 HTML Dashboard Structure

The GitHub Pages site is published from the `/docs` folder.

### Core files

- `docs/index.html`
  - Page structure and dashboard layout
- `docs/app.js`
  - Client-side data loading, filtering, calculations, chart rendering, map rendering, and hover interactions
- `docs/styles.css`
  - Liquid-glass visual styling, layout system, responsiveness, and chart presentation
- `docs/data/earthquakes_live_curated.csv`
  - Curated dataset consumed by the website
- `docs/data/dashboard_meta.json`
  - Lightweight metadata used for coverage dates, row counts, and site sync display

### Purpose of the dashboard sections

- Hero and status annotations
  - Explain the project, display sync status, and show current published coverage
- Summary cards
  - Surface current-year and current-day KPI metrics in Eastern Time
- Filter panel
  - Controls date range and department, including quick ranges (`Last 7D`, `Last 30D`, `Last 90D`, `YTD`, `All history`)
- Magnitude bands
  - Groups earthquakes into human-readable severity buckets
- Daily time series
  - Shows event count by ET date
- 7-day rolling average
  - Smooths short-term volatility to highlight the recent trend
- Monthly and yearly time series
  - Show longer historical cadence and changes over time
- Magnitude vs depth scatterplot
  - Shows how stronger events distribute across depth
- Depth-band pattern heatmap
  - Shows the percentage mix of magnitude bands within each depth band to highlight structural clustering
- Most affected departamentos bubble chart
  - Shows the current concentration of events by region in a visually scan-friendly layout and respects the active filter window
- Epicenter map
  - Displays filtered event locations spatially
- Recent events table
  - Shows the latest filtered records in a quick operational view

### Interaction model

The dashboard is fully client-side:

- loads the curated CSV and metadata JSON directly from GitHub Pages
- applies filters in-browser
- redraws charts without server-side rendering
- keeps the bubble chart, map, and recent-events table aligned with the active filter state
- supports hover detail for time series, scatterplots, heatmap cells, bubbles, and map markers

---

## 🏗 Architecture

### High-Level Flow

```text
  Historical XLSX (1960-2023) ─────┐
                                   │
  IGP Reportes Feed (2020-current) ├──> Python ingestion + normalization
                                   │
  Live ArcGIS REST feed ───────────┘
                                   │
                                   ▼
                         SQLite working store
                                   │
                                   ▼
                  Curated / full / GeoJSON export layer
                                   │
                  ┌────────────────┼─────────────────┐
                  ▼                ▼                 ▼
         Raw GitHub exports   GitHub Pages data   BI / GIS consumers
                               (`/docs/data`)     (Power BI, Tableau,
                                                   custom apps)
```

### Web delivery flow

```text
GitHub Actions
   -> run ingestion pipeline
   -> regenerate exports
   -> mirror curated website data into /docs/data
   -> push to main
   -> GitHub Pages serves static HTML/CSS/JS + refreshed data files
```

---

## 🔄 What the Pipeline Does

- Incrementally pulls new seismic events from the live feed (`objectid` based)
- Backfills historical records from official catalog files
- Ingests annual report data from the IGP report site
- Merges overlapping historical, annual, and live sources
- Normalizes timestamps into:
  - `event_ts_utc`
  - `event_ts_et`
  - `event_date_et`
  - `event_time_et`
- Filters invalid timestamps and incomplete rows from the curated feed
- Canonicalizes event codes for de-duplication across sources
- Detects schema changes and preserves raw source payloads
- Regenerates curated, full, GeoJSON, and website-facing outputs
- Runs automatically in the cloud on a schedule

---

## 📂 Data Sources

### Live REST Feed

[https://ide.igp.gob.pe/arcgis/rest/services/monitoreocensis/SismosReportados/MapServer/0](https://ide.igp.gob.pe/arcgis/rest/services/monitoreocensis/SismosReportados/MapServer/0)

### Annual Report Feed

[https://ultimosismo.igp.gob.pe/api/ultimo-sismo/ajaxb](https://ultimosismo.igp.gob.pe/api/ultimo-sismo/ajaxb)

### Historical Catalog (Official Government Data)

[https://www.datosabiertos.gob.pe/sites/default/files/Catalogo1960_2023.xlsx](https://www.datosabiertos.gob.pe/sites/default/files/Catalogo1960_2023.xlsx)

---

## 📦 Outputs

### ✅ Curated CSV (Recommended)

Analytics-ready dataset for BI tools and custom apps:

[https://raw.githubusercontent.com/IFC-Chalaco/peru-seismic-dashboard/main/seismic_bi_stream/exports/earthquakes_live_curated.csv](https://raw.githubusercontent.com/IFC-Chalaco/peru-seismic-dashboard/main/seismic_bi_stream/exports/earthquakes_live_curated.csv)

### 📄 Full CSV

Includes additional raw source columns:

[https://raw.githubusercontent.com/IFC-Chalaco/peru-seismic-dashboard/main/seismic_bi_stream/exports/earthquakes_live.csv](https://raw.githubusercontent.com/IFC-Chalaco/peru-seismic-dashboard/main/seismic_bi_stream/exports/earthquakes_live.csv)

### 🗺 GeoJSON

Geospatial-ready feed:

[https://raw.githubusercontent.com/IFC-Chalaco/peru-seismic-dashboard/main/seismic_bi_stream/exports/earthquakes_live.geojson](https://raw.githubusercontent.com/IFC-Chalaco/peru-seismic-dashboard/main/seismic_bi_stream/exports/earthquakes_live.geojson)

The GeoJSON properties include filter-friendly date fields such as:

- `event_date_utc`, `event_time_utc`
- `event_date_local`, `event_time_local`
- `event_date_et`, `event_time_et`
- `event_utc_date_key`, `event_local_date_key`, `event_et_date_key`

### 🌐 Website Data

These are the files consumed directly by the HTML dashboard:

- `docs/data/earthquakes_live_curated.csv`
- `docs/data/dashboard_meta.json`

---

## 🧠 Data Model (Curated Feed)

| Column | Description |
|--------|-------------|
| objectid | Event identifier from source or normalized synthetic identifier |
| code | Canonical event code used for de-duplication |
| lat | Latitude |
| lon | Longitude |
| magnitud | Earthquake magnitude |
| prof | Depth in kilometers |
| profundidad | Depth classification label |
| intensidad | Reported intensity description |
| departamento | Department / region label |
| referencia | Textual geographic reference |
| event_ts_utc | UTC timestamp |
| event_ts_et | Eastern Time timestamp |
| event_date_et | ET date for filtering and charting |
| event_time_et | ET time for operational display |
| ingested_at_utc | Pipeline ingestion timestamp |

The curated feed excludes:

- null timestamps
- invalid datetime records
- duplicate cross-source events where canonical code matching is possible

---

## 🤖 Automation & Monitoring

### GitHub Actions Workflows

- `.github/workflows/igp-seismic-refresh.yml`
- `.github/workflows/igp-seismic-stale-alert.yml`

### Automated capabilities

- scheduled ingestion and export regeneration
- website data refresh under `/docs/data`
- heartbeat monitoring for stale feed detection
- automatic GitHub issue creation for stale pipeline alerts
- idempotent historical ingestion behavior
- serialized refresh runs to avoid overlapping workflow push conflicts
- compatibility with ephemeral CI runners

---

## 🔐 Security & Data Integrity

- no credentials stored in the repository
- no personal data ingested or published
- SQLite working database is not published
- only derived public datasets are committed
- schema-aware ingestion and export validation
- raw source payloads preserved for traceability where needed
- `SECURITY.md` documents the repository's security posture and vulnerability reporting guidance
- `.github/dependabot.yml` tracks GitHub Actions dependency updates automatically

---

## ▶️ Run Locally (Optional)

```bash
python3 seismic_bi_stream/igp_seismic_stream.py
```

Continuous loop mode:

```bash
python3 seismic_bi_stream/igp_seismic_stream.py --loop --interval-seconds 120
```

Production refreshes are handled by GitHub Actions.

---

# 🇪🇸 Español

## 📌 Descripción General

Este proyecto implementa un pipeline automatizado en la nube para consumir datos sísmicos públicos del IGP y publicar salidas listas para analisis, visualizacion web, BI y GIS.

Integra:

- 📚 Catalogo historico oficial (`1960-2020` desde el archivo XLSX gubernamental)
- 🗂 Feed anual de reportes de `ultimosismo.igp.gob.pe` (`2020-anio actual`)
- ⚡ Feed en vivo ArcGIS REST para los eventos mas recientes

Todo el proceso de ingesta, transformacion, exportacion, monitoreo y actualizacion del sitio corre automaticamente en GitHub Actions.

---

## 📊 Dashboard interactivo

### Dashboard principal en GitHub Pages

🔗 [https://ifc-chalaco.github.io/peru-seismic-dashboard/](https://ifc-chalaco.github.io/peru-seismic-dashboard/)

### Por que dejar Tableau Public como dashboard principal?

Tableau Public fue util para prototipar visualizaciones, pero no era la mejor opcion para un dashboard publico con expectativa de refresco cercano al tiempo real.

Razones principales:

- Tableau Public trabaja con extracciones y no con una fuente web verdaderamente en vivo.
- Google Sheets como capa intermedia agregaba mas retraso al refresco.
- El pipeline en GitHub Actions actualiza los datos con mas frecuencia que Tableau Public puede reflejar de forma consistente.
- El dashboard HTML en GitHub Pages consume directamente los archivos publicados por el pipeline, eliminando cuellos de botella innecesarios.

Por eso, el dashboard HTML es ahora la capa principal de publicacion.

### Referencia historica en Tableau Public

🔗 [https://public.tableau.com/views/ReportesSismicosPeru/Dashboard1](https://public.tableau.com/views/ReportesSismicosPeru/Dashboard1)

---

## 🧱 Estructura del dashboard HTML

Archivos principales:

- `docs/index.html`: estructura de la pagina y layout del dashboard
- `docs/app.js`: carga de datos, filtros, calculos, graficos, mapa e interacciones
- `docs/styles.css`: estilo visual tipo liquid-glass, layout responsivo y presentacion
- `docs/data/earthquakes_live_curated.csv`: dataset curado consumido por el sitio
- `docs/data/dashboard_meta.json`: metadata ligera para conteos, cobertura y sincronizacion

Secciones principales del sitio:

- Hero y anotaciones de estado
- KPIs del anio actual y del dia actual
- Panel de filtros con rangos rapidos (`Last 7D`, `Last 30D`, `Last 90D`, `YTD`, `All history`) y selector de departamento
- Bandas de magnitud
- Serie diaria de ocurrencias
- Promedio movil de 7 dias
- Series mensuales y anuales
- Scatterplot magnitud vs profundidad
- Heatmap de patron por banda de profundidad
- Bubble chart de departamentos mas afectados
- Mapa de epicentros
- Tabla de eventos recientes

Modelo de interaccion:

- el dashboard carga CSV y metadata directamente desde GitHub Pages
- aplica filtros en el navegador
- redibuja los graficos sin renderizado en servidor
- mantiene alineados bubble chart, mapa y tabla con el filtro activo
- incluye hover details en series de tiempo, scatterplots, celdas del heatmap, bubbles y mapa

---

## 🏗 Arquitectura

El sistema:

- integra datos historicos, anuales y en vivo
- normaliza timestamps
- deduplica eventos entre fuentes cuando es posible
- publica CSV, GeoJSON y archivos para la web
- se ejecuta automaticamente en la nube

---

## 📦 Archivos generados

- CSV curado
- CSV completo
- GeoJSON
- Archivos web en `docs/data/`
- Metadata de estado y cobertura

---

## 🔐 Seguridad

- no contiene credenciales
- no almacena datos personales
- solo publica datos derivados de fuentes oficiales publicas
- compatible con ejecucion CI/CD en entornos efimeros
- `SECURITY.md` documenta la postura de seguridad y el canal recomendado para reportar vulnerabilidades
- `.github/dependabot.yml` monitorea automaticamente actualizaciones de dependencias de GitHub Actions
