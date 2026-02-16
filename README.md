# IGP Seismic Stream for Tableau/Power BI

This pipeline ingests public seismic events from the official IGP ArcGIS service and exports BI-ready files that can refresh continuously.

## GitHub Description

`Live Peru seismic data pipeline from official IGP ArcGIS feed to Power BI/Tableau (CSV + GeoJSON), with incremental updates and automatic schema-change detection.`

Data source:
- `https://ide.igp.gob.pe/arcgis/rest/services/monitoreocensis/SismosReportados/MapServer/0`

## What it does

- Pulls new events incrementally using `objectid`.
- Stores history in SQLite (`raw_events` table).
- Preserves full raw attributes JSON for each event.
- Detects schema changes by checking ArcGIS layer metadata (`schema_fields` and `schema_changes` tables).
- Rebuilds:
  - `earthquakes_live.csv` (flat table for Tableau/Power BI)
  - `earthquakes_live_curated.csv` (recommended clean feed for Tableau/Google Sheets)
  - `earthquakes_live.geojson` (map feed)
- Includes timestamp fields for both UTC and US Eastern Time in the CSV:
  - `event_ts_utc`
  - `event_ts_et`
  - `event_date_et`
  - `event_time_et`

If IGP adds a new field, it is captured in raw JSON immediately and appears as a new `src_<fieldname>` column in the CSV on subsequent exports.

## Steps taken

1. Create a GitHub repository and push the project files.
2. Confirm `origin` points to your GitHub repo and push `main`.
3. Enable GitHub Actions write access:
   - `Settings` -> `Actions` -> `General` -> `Workflow permissions` -> `Read and write permissions`.
4. Run `Refresh IGP Seismic Feed` once manually from the `Actions` tab.
5. Verify published outputs:
   - `seismic_bi_stream/exports/earthquakes_live.csv`
   - `seismic_bi_stream/exports/earthquakes_live.geojson`
6. Connect Power BI/Tableau to the public raw CSV URL in GitHub.
7. Enable scheduled refresh in Power BI Service.
8. Use `IGP Seismic Feed Stale Alert` to monitor heartbeat drift and open/close alert issues automatically.

Operational note:
- With GitHub Actions enabled, your computer does not need to be on for data updates.
- Keep local `--loop` mode only for development or ad hoc testing.

## Data Flow and API Clarification

- Source API: IGP ArcGIS REST service (`SismosReportados` layer).
- This project is a data ingestion and publishing pipeline, not a custom REST API service.
- Output interface: versioned GitHub files (CSV and GeoJSON) consumed by BI tools.
- Correct terminology for portfolio: `data ingestion pipeline`, `automated data feed`, `workflow orchestration`, and `schema-change monitoring`.

## Run once

```bash
python3 seismic_bi_stream/igp_seismic_stream.py
```

If your machine has TLS CA issues, use:

```bash
python3 seismic_bi_stream/igp_seismic_stream.py --insecure-skip-verify
```

## Run continuously (near-real-time)

```bash
python3 seismic_bi_stream/igp_seismic_stream.py --loop --interval-seconds 120
```

## Output files

- `seismic_bi_stream/data/igp_seismic.db`
- `seismic_bi_stream/data/state.json`
- `seismic_bi_stream/exports/earthquakes_live.csv`
- `seismic_bi_stream/exports/earthquakes_live_curated.csv`
- `seismic_bi_stream/exports/earthquakes_live.geojson`

Recommended BI feed (clean columns only):
- `https://raw.githubusercontent.com/IFC-Chalaco/peru-seismic-dashboard/main/seismic_bi_stream/exports/earthquakes_live_curated.csv`

## Connect to Tableau

1. Connect to `Text file` and select `earthquakes_live.csv`.
2. Set geospatial role:
   - `lat` as Latitude
   - `lon` as Longitude
3. Publish workbook to Tableau Public/Server.
4. Refresh strategy:
   - If file is hosted at a public URL, use web-hosted CSV refresh.
   - If local/on-prem, use Tableau Bridge.

## Connect to Power BI

1. `Get Data` -> `Text/CSV` -> select `earthquakes_live.csv`.
2. Set `lat` / `lon` data categories.
3. Publish to Power BI Service.
4. Configure scheduled refresh:
   - Web URL source if hosted publicly.
   - On-premises data gateway if file remains local.

## GitHub Actions for online public feed

The repository is pushed to GitHub, an scheduled workflow has been added which runs the script every few minutes and commits the updated `exports/` files. Then a user can connect Tableau/Power BI to the raw GitHub URL for automatic cloud refresh.

Please note this project already includes:
- `.github/workflows/igp-seismic-refresh.yml`
- `.github/workflows/igp-seismic-stale-alert.yml`

The workflow commits only `exports/` and `state.json` (not SQLite). The ingestor automatically backfills if DB history is missing, so cloud runs still produce a full snapshot.

## Control
### Stale-feed alert

`igp-seismic-stale-alert.yml` checks `seismic_bi_stream/data/state.json` every 10 minutes.

- If `last_run_utc` is older than 30 minutes, it opens a GitHub issue:
  - `[Alert] IGP seismic feed heartbeat stale`
- If the feed recovers, it comments and closes that alert issue automatically.

To change the alert threshold, edit:
- `STALE_MINUTES` in `.github/workflows/igp-seismic-stale-alert.yml`
