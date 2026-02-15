#!/usr/bin/env python3
"""Incremental IGP seismic ingest for Tableau/Power BI."""

from __future__ import annotations

import argparse
import csv
import json
import ssl
import sqlite3
import sys
import time
import traceback
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo

ARC_LAYER_URL = (
    "https://ide.igp.gob.pe/arcgis/rest/services/monitoreocensis/SismosReportados/MapServer/0"
)
QUERY_URL = f"{ARC_LAYER_URL}/query"
METADATA_URL = f"{ARC_LAYER_URL}?f=pjson"
LOCAL_TZ = ZoneInfo("America/Lima")


@dataclass
class RunSummary:
    new_rows: int
    latest_objectid: int
    total_rows: int
    new_fields: list[str]
    csv_path: Path
    geojson_path: Path


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def to_iso_utc_from_ms(epoch_ms: int | float | None) -> str | None:
    if epoch_ms is None:
        return None
    try:
        dt = datetime.fromtimestamp(float(epoch_ms) / 1000.0, tz=timezone.utc)
    except (TypeError, ValueError, OSError):
        return None
    return dt.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def http_get_json(
    url: str,
    params: dict[str, Any] | None,
    timeout_seconds: int,
    insecure_skip_verify: bool,
) -> dict[str, Any]:
    full_url = f"{url}?{urlencode(params)}" if params else url
    req = Request(full_url, headers={"User-Agent": "igp-seismic-stream/1.0"})
    ssl_context = ssl.create_default_context()
    if insecure_skip_verify:
        ssl_context.check_hostname = False
        ssl_context.verify_mode = ssl.CERT_NONE

    with urlopen(req, timeout=timeout_seconds, context=ssl_context) as response:
        charset = response.headers.get_content_charset() or "utf-8"
        content = response.read().decode(charset)
    payload = json.loads(content)
    if isinstance(payload, dict) and "error" in payload:
        raise RuntimeError(f"ArcGIS API error: {payload['error']}")
    if not isinstance(payload, dict):
        raise RuntimeError("Unexpected API response format.")
    return payload


def load_state(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"last_objectid": 0, "known_fields": {}}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"last_objectid": 0, "known_fields": {}}


def save_state(path: Path, state: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS raw_events (
            objectid INTEGER PRIMARY KEY,
            code TEXT,
            event_ts_utc TEXT,
            event_ts_local TEXT,
            event_date_local TEXT,
            event_time_local TEXT,
            fecha_ms INTEGER,
            fechaevento_ms INTEGER,
            hora TEXT,
            lat REAL,
            lon REAL,
            magnitud REAL,
            prof INTEGER,
            profundidad TEXT,
            intensidad TEXT,
            departamento TEXT,
            referencia TEXT,
            ultimo TEXT,
            reporte INTEGER,
            mag TEXT,
            raw_attributes_json TEXT NOT NULL,
            raw_geometry_json TEXT,
            ingested_at_utc TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_raw_events_code ON raw_events(code);
        CREATE INDEX IF NOT EXISTS idx_raw_events_event_ts ON raw_events(event_ts_utc);

        CREATE TABLE IF NOT EXISTS schema_fields (
            field_name TEXT PRIMARY KEY,
            field_type TEXT NOT NULL,
            alias TEXT,
            first_seen_utc TEXT NOT NULL,
            last_seen_utc TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS schema_changes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            detected_at_utc TEXT NOT NULL,
            change_type TEXT NOT NULL,
            field_name TEXT NOT NULL,
            field_type TEXT NOT NULL,
            details TEXT
        );
        """
    )
    conn.commit()


def parse_event_times(
    fechaevento_ms: int | float | None,
    fecha_ms: int | float | None,
    hora: str | None,
) -> tuple[str | None, str | None, str | None, str | None]:
    event_dt_utc: datetime | None = None

    if fechaevento_ms is not None:
        try:
            event_dt_utc = datetime.fromtimestamp(float(fechaevento_ms) / 1000.0, tz=timezone.utc)
        except (TypeError, ValueError, OSError):
            event_dt_utc = None

    if event_dt_utc is None and fecha_ms is not None and hora:
        try:
            local_date = datetime.fromtimestamp(float(fecha_ms) / 1000.0, tz=timezone.utc).astimezone(
                LOCAL_TZ
            )
            parts = hora.split(":")
            hh, mm, ss = int(parts[0]), int(parts[1]), int(parts[2])
            local_dt = datetime(
                local_date.year,
                local_date.month,
                local_date.day,
                hh,
                mm,
                ss,
                tzinfo=LOCAL_TZ,
            )
            event_dt_utc = local_dt.astimezone(timezone.utc)
        except (ValueError, TypeError, IndexError, OSError):
            event_dt_utc = None

    if event_dt_utc is None and fecha_ms is not None:
        try:
            event_dt_utc = datetime.fromtimestamp(float(fecha_ms) / 1000.0, tz=timezone.utc)
        except (TypeError, ValueError, OSError):
            event_dt_utc = None

    if event_dt_utc is None:
        return None, None, None, None

    event_dt_local = event_dt_utc.astimezone(LOCAL_TZ)
    return (
        event_dt_utc.replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        event_dt_local.replace(microsecond=0).isoformat(),
        event_dt_local.date().isoformat(),
        event_dt_local.strftime("%H:%M:%S"),
    )


def fetch_layer_metadata(timeout_seconds: int, insecure_skip_verify: bool) -> dict[str, Any]:
    return http_get_json(
        METADATA_URL,
        None,
        timeout_seconds=timeout_seconds,
        insecure_skip_verify=insecure_skip_verify,
    )


def sync_schema_metadata(
    conn: sqlite3.Connection,
    metadata: dict[str, Any],
    known_fields: dict[str, str],
) -> list[str]:
    now_iso = utc_now_iso()
    fields = metadata.get("fields") or []
    current_fields: dict[str, str] = {}

    for field in fields:
        if not isinstance(field, dict):
            continue
        name = str(field.get("name", "")).strip()
        ftype = str(field.get("type", "unknown")).strip() or "unknown"
        alias = str(field.get("alias", "")).strip() or None
        if not name:
            continue
        current_fields[name] = ftype
        conn.execute(
            """
            INSERT INTO schema_fields (field_name, field_type, alias, first_seen_utc, last_seen_utc)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(field_name) DO UPDATE SET
                field_type=excluded.field_type,
                alias=excluded.alias,
                last_seen_utc=excluded.last_seen_utc
            """,
            (name, ftype, alias, now_iso, now_iso),
        )

    new_fields = sorted(name for name in current_fields if name not in known_fields)
    for name in new_fields:
        conn.execute(
            """
            INSERT INTO schema_changes (detected_at_utc, change_type, field_name, field_type, details)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                now_iso,
                "new_field",
                name,
                current_fields[name],
                "Detected in ArcGIS layer metadata.",
            ),
        )

    conn.commit()
    known_fields.clear()
    known_fields.update(current_fields)
    return new_fields


def fetch_new_features(
    last_objectid: int,
    batch_size: int,
    timeout_seconds: int,
    insecure_skip_verify: bool,
) -> list[dict[str, Any]]:
    features: list[dict[str, Any]] = []
    cursor = last_objectid

    while True:
        payload = http_get_json(
            QUERY_URL,
            {
                "where": f"objectid > {cursor}",
                "outFields": "*",
                "orderByFields": "objectid ASC",
                "resultRecordCount": str(batch_size),
                "returnGeometry": "true",
                "f": "json",
            },
            timeout_seconds=timeout_seconds,
            insecure_skip_verify=insecure_skip_verify,
        )
        batch = payload.get("features") or []
        if not isinstance(batch, list) or not batch:
            break

        features.extend(batch)
        max_objectid = cursor
        for feature in batch:
            attrs = feature.get("attributes") if isinstance(feature, dict) else None
            if isinstance(attrs, dict):
                oid = attrs.get("objectid")
                if isinstance(oid, int) and oid > max_objectid:
                    max_objectid = oid

        if max_objectid <= cursor:
            break
        cursor = max_objectid
        if len(batch) < batch_size:
            break

    return features


def upsert_features(conn: sqlite3.Connection, features: list[dict[str, Any]]) -> tuple[int, int]:
    inserted_rows = 0
    latest_objectid = 0
    now_iso = utc_now_iso()

    for feature in features:
        if not isinstance(feature, dict):
            continue
        attrs = feature.get("attributes")
        if not isinstance(attrs, dict):
            continue

        objectid = attrs.get("objectid")
        if not isinstance(objectid, int):
            continue

        geom = feature.get("geometry")
        if not isinstance(geom, dict):
            geom = {}

        fecha_ms = attrs.get("fecha")
        fechaevento_ms = attrs.get("fechaevento")
        hora = attrs.get("hora")
        event_ts_utc, event_ts_local, event_date_local, event_time_local = parse_event_times(
            fechaevento_ms=fechaevento_ms if isinstance(fechaevento_ms, (int, float)) else None,
            fecha_ms=fecha_ms if isinstance(fecha_ms, (int, float)) else None,
            hora=hora if isinstance(hora, str) else None,
        )

        lat = attrs.get("lat")
        lon = attrs.get("lon")
        if not isinstance(lat, (int, float)):
            y = geom.get("y")
            lat = float(y) if isinstance(y, (int, float)) else None
        if not isinstance(lon, (int, float)):
            x = geom.get("x")
            lon = float(x) if isinstance(x, (int, float)) else None

        before = conn.total_changes
        conn.execute(
            """
            INSERT INTO raw_events (
                objectid, code, event_ts_utc, event_ts_local, event_date_local, event_time_local,
                fecha_ms, fechaevento_ms, hora, lat, lon, magnitud, prof, profundidad, intensidad,
                departamento, referencia, ultimo, reporte, mag, raw_attributes_json, raw_geometry_json,
                ingested_at_utc
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(objectid) DO UPDATE SET
                code=excluded.code,
                event_ts_utc=excluded.event_ts_utc,
                event_ts_local=excluded.event_ts_local,
                event_date_local=excluded.event_date_local,
                event_time_local=excluded.event_time_local,
                fecha_ms=excluded.fecha_ms,
                fechaevento_ms=excluded.fechaevento_ms,
                hora=excluded.hora,
                lat=excluded.lat,
                lon=excluded.lon,
                magnitud=excluded.magnitud,
                prof=excluded.prof,
                profundidad=excluded.profundidad,
                intensidad=excluded.intensidad,
                departamento=excluded.departamento,
                referencia=excluded.referencia,
                ultimo=excluded.ultimo,
                reporte=excluded.reporte,
                mag=excluded.mag,
                raw_attributes_json=excluded.raw_attributes_json,
                raw_geometry_json=excluded.raw_geometry_json,
                ingested_at_utc=excluded.ingested_at_utc
            """,
            (
                objectid,
                attrs.get("code"),
                event_ts_utc,
                event_ts_local,
                event_date_local,
                event_time_local,
                int(fecha_ms) if isinstance(fecha_ms, (int, float)) else None,
                int(fechaevento_ms) if isinstance(fechaevento_ms, (int, float)) else None,
                attrs.get("hora"),
                float(lat) if isinstance(lat, (int, float)) else None,
                float(lon) if isinstance(lon, (int, float)) else None,
                float(attrs["magnitud"]) if isinstance(attrs.get("magnitud"), (int, float)) else None,
                int(attrs["prof"]) if isinstance(attrs.get("prof"), int) else None,
                attrs.get("profundidad"),
                attrs.get("int_"),
                attrs.get("departamento"),
                attrs.get("ref"),
                attrs.get("ultimo"),
                int(attrs["reporte"]) if isinstance(attrs.get("reporte"), int) else None,
                attrs.get("mag"),
                json.dumps(attrs, ensure_ascii=True, sort_keys=True),
                json.dumps(geom, ensure_ascii=True, sort_keys=True),
                now_iso,
            ),
        )
        after = conn.total_changes
        if after > before:
            inserted_rows += 1
        if objectid > latest_objectid:
            latest_objectid = objectid

    conn.commit()
    return inserted_rows, latest_objectid


def export_csv(conn: sqlite3.Connection, csv_path: Path) -> int:
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        """
        SELECT
            objectid, code, event_ts_utc, event_ts_local, event_date_local, event_time_local,
            fecha_ms, fechaevento_ms, hora, lat, lon, magnitud, prof, profundidad, intensidad,
            departamento, referencia, ultimo, reporte, mag, raw_attributes_json, ingested_at_utc
        FROM raw_events
        ORDER BY objectid DESC
        """
    ).fetchall()

    payload_keys: set[str] = set()
    for row in rows:
        try:
            payload = json.loads(row["raw_attributes_json"] or "{}")
        except json.JSONDecodeError:
            payload = {}
        if isinstance(payload, dict):
            payload_keys.update(str(k) for k in payload.keys())

    static_cols = [
        "objectid",
        "code",
        "event_ts_utc",
        "event_ts_local",
        "event_date_local",
        "event_time_local",
        "lat",
        "lon",
        "magnitud",
        "prof",
        "profundidad",
        "intensidad",
        "departamento",
        "referencia",
        "ultimo",
        "reporte",
        "hora",
        "fecha_ms",
        "fechaevento_ms",
        "mag",
        "ingested_at_utc",
    ]
    dynamic_cols = [f"src_{k}" for k in sorted(payload_keys)]
    fieldnames = static_cols + dynamic_cols

    csv_path.parent.mkdir(parents=True, exist_ok=True)
    with csv_path.open("w", newline="", encoding="utf-8") as csv_file:
        writer = csv.DictWriter(csv_file, fieldnames=fieldnames)
        writer.writeheader()
        for row in rows:
            out: dict[str, Any] = {col: row[col] for col in static_cols}
            try:
                payload = json.loads(row["raw_attributes_json"] or "{}")
            except json.JSONDecodeError:
                payload = {}
            if isinstance(payload, dict):
                for key in payload_keys:
                    out[f"src_{key}"] = payload.get(key)
            writer.writerow(out)

    return len(rows)


def export_geojson(conn: sqlite3.Connection, geojson_path: Path) -> None:
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        """
        SELECT objectid, lat, lon, raw_attributes_json, event_ts_utc, event_ts_local
        FROM raw_events
        ORDER BY objectid DESC
        """
    ).fetchall()

    features: list[dict[str, Any]] = []
    for row in rows:
        try:
            properties = json.loads(row["raw_attributes_json"] or "{}")
        except json.JSONDecodeError:
            properties = {}
        if not isinstance(properties, dict):
            properties = {}
        properties["event_ts_utc"] = row["event_ts_utc"]
        properties["event_ts_local"] = row["event_ts_local"]

        lat = row["lat"]
        lon = row["lon"]
        geometry: dict[str, Any] | None = None
        if isinstance(lat, (int, float)) and isinstance(lon, (int, float)):
            geometry = {"type": "Point", "coordinates": [lon, lat]}

        features.append(
            {
                "type": "Feature",
                "id": row["objectid"],
                "geometry": geometry,
                "properties": properties,
            }
        )

    payload = {"type": "FeatureCollection", "features": features}
    geojson_path.parent.mkdir(parents=True, exist_ok=True)
    geojson_path.write_text(
        json.dumps(payload, ensure_ascii=True, separators=(",", ":")),
        encoding="utf-8",
    )


def count_rows(conn: sqlite3.Connection) -> int:
    result = conn.execute("SELECT COUNT(*) FROM raw_events").fetchone()
    return int(result[0]) if result else 0


def run_once(
    db_path: Path,
    state_path: Path,
    output_dir: Path,
    batch_size: int,
    timeout_seconds: int,
    insecure_skip_verify: bool,
) -> RunSummary:
    state = load_state(state_path)
    last_objectid = int(state.get("last_objectid", 0))
    known_fields = state.get("known_fields")
    if not isinstance(known_fields, dict):
        known_fields = {}

    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    try:
        init_db(conn)

        # In ephemeral runners (e.g., GitHub Actions), state may persist without DB history.
        # If DB is empty, force a backfill to rebuild exports.
        if count_rows(conn) == 0 and last_objectid > 0:
            last_objectid = 0

        metadata = fetch_layer_metadata(
            timeout_seconds=timeout_seconds,
            insecure_skip_verify=insecure_skip_verify,
        )
        new_fields = sync_schema_metadata(conn, metadata, known_fields)

        features = fetch_new_features(
            last_objectid=last_objectid,
            batch_size=batch_size,
            timeout_seconds=timeout_seconds,
            insecure_skip_verify=insecure_skip_verify,
        )
        upsert_count, latest_seen = upsert_features(conn, features)

        if latest_seen > last_objectid:
            state["last_objectid"] = latest_seen
        state["known_fields"] = known_fields
        state["last_run_utc"] = utc_now_iso()
        save_state(state_path, state)

        csv_path = output_dir / "earthquakes_live.csv"
        geojson_path = output_dir / "earthquakes_live.geojson"
        export_csv(conn, csv_path)
        export_geojson(conn, geojson_path)

        return RunSummary(
            new_rows=upsert_count,
            latest_objectid=int(state["last_objectid"]),
            total_rows=count_rows(conn),
            new_fields=new_fields,
            csv_path=csv_path,
            geojson_path=geojson_path,
        )
    finally:
        conn.close()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Stream IGP seismic data into SQLite + BI-friendly CSV/GeoJSON."
    )
    parser.add_argument(
        "--db-path",
        type=Path,
        default=Path("seismic_bi_stream/data/igp_seismic.db"),
        help="SQLite database path.",
    )
    parser.add_argument(
        "--state-path",
        type=Path,
        default=Path("seismic_bi_stream/data/state.json"),
        help="State file path (last processed objectid + known schema).",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path("seismic_bi_stream/exports"),
        help="Output directory for CSV/GeoJSON files.",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=500,
        help="Max events fetched per API call (layer max is 2000).",
    )
    parser.add_argument(
        "--timeout-seconds",
        type=int,
        default=30,
        help="HTTP timeout for ArcGIS requests.",
    )
    parser.add_argument(
        "--loop",
        action="store_true",
        help="Run continuously. Without this flag, script runs once and exits.",
    )
    parser.add_argument(
        "--interval-seconds",
        type=int,
        default=120,
        help="Polling interval while in --loop mode.",
    )
    parser.add_argument(
        "--insecure-skip-verify",
        action="store_true",
        help="Disable TLS certificate verification (use only if your environment lacks root CAs).",
    )
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()

    if args.batch_size < 1 or args.batch_size > 2000:
        parser.error("--batch-size must be between 1 and 2000.")
    if args.interval_seconds < 5:
        parser.error("--interval-seconds must be at least 5.")

    while True:
        try:
            summary = run_once(
                db_path=args.db_path,
                state_path=args.state_path,
                output_dir=args.output_dir,
                batch_size=args.batch_size,
                timeout_seconds=args.timeout_seconds,
                insecure_skip_verify=args.insecure_skip_verify,
            )
            print(
                json.dumps(
                    {
                        "status": "ok",
                        "new_rows": summary.new_rows,
                        "latest_objectid": summary.latest_objectid,
                        "total_rows": summary.total_rows,
                        "new_fields": summary.new_fields,
                        "csv": str(summary.csv_path),
                        "geojson": str(summary.geojson_path),
                        "run_at_utc": utc_now_iso(),
                    }
                )
            )
        except Exception as exc:
            print(
                json.dumps(
                    {
                        "status": "error",
                        "error": str(exc),
                        "run_at_utc": utc_now_iso(),
                    }
                ),
                file=sys.stderr,
            )
            if not args.loop:
                traceback.print_exc()
                return 1

        if not args.loop:
            return 0
        time.sleep(args.interval_seconds)


if __name__ == "__main__":
    raise SystemExit(main())
