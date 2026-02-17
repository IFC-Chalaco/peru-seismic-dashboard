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

This project implements a cloud-automated data ingestion pipeline that continuously pulls public seismic data from official IGP (Instituto Geofísico del Perú) sources and publishes BI-ready datasets for Tableau and Power BI.

The system merges:

- 📚 Official historical catalog (1960–2023)
- ⚡ Live ArcGIS REST seismic feed

into a unified dataset spanning multiple decades.

All updates run automatically in GitHub Actions — no local machine required.

---

## 📊 Interactive Dashboard

🔗 **View the Live Dashboard on Tableau Public**

https://public.tableau.com/views/ReportesSismicosPeru/Dashboard1

### Preview

[![Seismic Dashboard](https://public.tableau.com/static/images/Re/ReportesSismicosPeru/Dashboard1/1.png)](https://public.tableau.com/views/ReportesSismicosPeru/Dashboard1)

---

## 🏗 Architecture

### High-Level Flow

```
           ┌───────────────────────────────┐
           │  IGP Historical Catalog XLSX │
           └──────────────┬────────────────┘
                          │
                          ▼
           ┌───────────────────────────────┐
           │  Historical Ingestion Layer   │
           └──────────────┬────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────┐
│              SQLite Data Store                 │
│  - raw_events                                  │
│  - schema metadata                             │
│  - ingestion state                             │
└────────────────────────────────────────────────┘
                          ▲
                          │
           ┌──────────────┴────────────────┐
           │   Live ArcGIS REST Endpoint    │
           └────────────────────────────────┘
                          │
                          ▼
           ┌───────────────────────────────┐
           │   Transformation & Validation │
           └──────────────┬────────────────┘
                          │
                          ▼
           ┌───────────────────────────────┐
           │     Export Layer (CSV/JSON)   │
           └──────────────┬────────────────┘
                          │
                          ▼
           ┌───────────────────────────────┐
           │   Tableau / Power BI / GIS    │
           └───────────────────────────────┘
```

---

## 🔄 What the Pipeline Does

- Incrementally pulls new seismic events (`objectid`)
- Backfills official historical catalog
- Merges historical + live records
- Detects schema changes
- Normalizes timestamps:
  - `event_ts_utc`
  - `event_ts_et`
  - `event_date_et`
  - `event_time_et`
- Filters invalid timestamps
- Regenerates curated + full exports
- Runs automatically in the cloud

---

## 📂 Data Sources

### Live REST Feed

https://ide.igp.gob.pe/arcgis/rest/services/monitoreocensis/SismosReportados/MapServer/0

### Historical Catalog (Official Government Data)

https://www.datosabiertos.gob.pe/sites/default/files/Catalogo1960_2023.xlsx

---

## 📦 Outputs

### ✅ Curated CSV (Recommended for BI)

Analytics-ready dataset:

https://raw.githubusercontent.com/IFC-Chalaco/peru-seismic-dashboard/main/seismic_bi_stream/exports/earthquakes_live_curated.csv

### 📄 Full CSV

Includes raw source columns:

https://raw.githubusercontent.com/IFC-Chalaco/peru-seismic-dashboard/main/seismic_bi_stream/exports/earthquakes_live.csv

### 🗺 GeoJSON

Geospatial-ready feed:

https://raw.githubusercontent.com/IFC-Chalaco/peru-seismic-dashboard/main/seismic_bi_stream/exports/earthquakes_live.geojson

---

## 🧠 Data Model (Curated Feed)

| Column | Description |
|--------|-------------|
| objectid | Unique event identifier |
| lat | Latitude |
| lon | Longitude |
| magnitud | Earthquake magnitude |
| prof | Depth (km) |
| event_ts_utc | UTC timestamp |
| event_ts_et | Eastern Time timestamp |
| event_date_et | ET date (BI-friendly) |
| event_time_et | ET time (BI-friendly) |

The curated feed excludes:
- Null timestamps
- Invalid datetime records

---

## 🤖 Automation & Monitoring

### GitHub Actions Workflows

- `igp-seismic-refresh.yml`
- `igp-seismic-stale-alert.yml`

### Automated Capabilities

- Scheduled ingestion
- Export regeneration
- Heartbeat monitoring
- Automatic GitHub alert issue creation
- Idempotent historical ingestion
- Ephemeral runner compatibility

---

## 🔐 Security & Data Integrity

- No credentials stored
- No personal data
- SQLite database not published
- Only derived public datasets committed
- Schema-aware ingestion process
- Validation during export phase

---

## ▶️ Run Locally (Optional)

```bash
python3 seismic_bi_stream/igp_seismic_stream.py
```

Continuous development mode:

```bash
python3 seismic_bi_stream/igp_seismic_stream.py --loop --interval-seconds 120
```

Production automation handled by GitHub Actions.

---

# 🇪🇸 Español

## 📌 Descripción General

Este proyecto implementa un pipeline automatizado en la nube que consume datos sísmicos oficiales del IGP y publica datasets listos para análisis en Tableau y Power BI.

Integra:

- 📚 Catálogo histórico oficial (1960–2023)
- ⚡ Feed en vivo vía ArcGIS REST

en un dataset continuo de múltiples décadas.

---

## 🏗 Arquitectura

El sistema:

- Integra datos históricos + en vivo
- Normaliza timestamps
- Detecta cambios de esquema
- Publica CSV y GeoJSON
- Se ejecuta automáticamente en la nube

---

## 📊 Dashboard

🔗 https://public.tableau.com/views/ReportesSismicosPeru/Dashboard1

---

## 📦 Archivos Generados

- CSV Curado
- CSV Completo
- GeoJSON
- Metadata de estado (`state.json`)

---

## 🔐 Seguridad

- No contiene credenciales
- No almacena datos personales
- Solo publica datos derivados de fuentes oficiales públicas
- Compatible con ejecución CI/CD en entornos efímeros
