# IGP Seismic Stream for Tableau/Power BI

This pipeline ingests public seismic events from the official IGP ArcGIS service and exports BI-ready files that can refresh continuously.

## GitHub Description (copy/paste)

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
  - `earthquakes_live.geojson` (map feed)
- Includes timestamp fields for both UTC and US Eastern Time in the CSV:
  - `event_ts_utc`
  - `event_ts_et`
  - `event_date_et`
  - `event_time_et`

If IGP adds a new field, it is captured in raw JSON immediately and appears as a new `src_<fieldname>` column in the CSV on subsequent exports.

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
- `seismic_bi_stream/exports/earthquakes_live.geojson`

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

## Optional: GitHub Actions for online public feed

If this repository is pushed to GitHub, add a scheduled workflow that runs the script every few minutes and commits the updated `exports/` files. Then connect Tableau/Power BI to the raw GitHub URL for automatic cloud refresh.

This project already includes:
- `.github/workflows/igp-seismic-refresh.yml`
- `.github/workflows/igp-seismic-stale-alert.yml`

The workflow commits only `exports/` and `state.json` (not SQLite). The ingestor automatically backfills if DB history is missing, so cloud runs still produce a full snapshot.

### Stale-feed alert

`igp-seismic-stale-alert.yml` checks `seismic_bi_stream/data/state.json` every 10 minutes.

- If `last_run_utc` is older than 15 minutes, it opens a GitHub issue:
  - `[Alert] IGP seismic feed heartbeat stale`
- If the feed recovers, it comments and closes that alert issue automatically.

To change the alert threshold, edit:
- `STALE_MINUTES` in `.github/workflows/igp-seismic-stale-alert.yml`
