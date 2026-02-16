#!/usr/bin/env python3
"""Incremental IGP seismic ingest for Tableau/Power BI."""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import os
import posixpath
import re
import ssl
import sqlite3
import sys
import time
import traceback
import zipfile
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlparse, urlencode
from urllib.request import Request, urlopen
from xml.etree import ElementTree as ET
from zoneinfo import ZoneInfo

ARC_LAYER_URL = (
    "https://ide.igp.gob.pe/arcgis/rest/services/monitoreocensis/SismosReportados/MapServer/0"
)
QUERY_URL = f"{ARC_LAYER_URL}/query"
METADATA_URL = f"{ARC_LAYER_URL}?f=pjson"
LOCAL_TZ = ZoneInfo("America/Lima")
ET_TZ = ZoneInfo("America/New_York")


@dataclass
class RunSummary:
    new_rows: int
    historical_rows: int
    historical_error: str | None
    latest_objectid: int
    total_rows: int
    new_fields: list[str]
    csv_path: Path
    curated_csv_path: Path
    geojson_path: Path


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def to_int(value: Any) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value) if value.is_integer() else None
    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return None
        lowered = raw.lower()
        if lowered in {"true", "t", "yes", "y", "si", "s"}:
            return 1
        if lowered in {"false", "f", "no", "n"}:
            return 0
        try:
            if "." in raw:
                parsed = float(raw)
                return int(parsed) if parsed.is_integer() else None
            return int(raw)
        except ValueError:
            return None
    return None


def to_float(value: Any) -> float | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return float(int(value))
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        raw = value.strip()
        if not raw:
            return None
        try:
            return float(raw.replace(",", "."))
        except ValueError:
            return None
    return None


def to_epoch_ms(value: Any) -> int | None:
    parsed = to_int(value)
    if parsed is None:
        return None
    return parsed if abs(parsed) >= 100000000000 else None


def normalize_key(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "", str(value).lower())


def build_row_key_map(row: dict[str, Any]) -> dict[str, str]:
    key_map: dict[str, str] = {}
    for key in row.keys():
        normalized = normalize_key(key)
        if normalized and normalized not in key_map:
            key_map[normalized] = key
    return key_map


def pick_row_value(row: dict[str, Any], key_map: dict[str, str], aliases: list[str]) -> Any:
    for alias in aliases:
        source_key = key_map.get(normalize_key(alias))
        if source_key is None:
            continue
        value = row.get(source_key)
        if isinstance(value, str):
            stripped = value.strip()
            if stripped == "":
                continue
            return stripped
        if value is not None:
            return value
    return None


def pick_row_value_contains(
    row: dict[str, Any],
    key_map: dict[str, str],
    includes: list[str],
    excludes: list[str] | None = None,
) -> Any:
    excludes = excludes or []
    include_norm = [normalize_key(token) for token in includes if token]
    exclude_norm = [normalize_key(token) for token in excludes if token]
    for norm_key, source_key in key_map.items():
        if include_norm and not all(token in norm_key for token in include_norm):
            continue
        if exclude_norm and any(token in norm_key for token in exclude_norm):
            continue
        value = row.get(source_key)
        if isinstance(value, str):
            stripped = value.strip()
            if stripped == "":
                continue
            return stripped
        if value is not None:
            return value
    return None


def epoch_to_utc_iso(value: int | float | None) -> str | None:
    if value is None:
        return None
    try:
        ts = float(value)
    except (TypeError, ValueError):
        return None
    if abs(ts) >= 1e11:
        ts /= 1000.0
    try:
        dt = datetime.fromtimestamp(ts, tz=timezone.utc)
    except (OSError, OverflowError, ValueError):
        return None
    return dt.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_datetime_to_utc_iso(value: Any, assume_tz: ZoneInfo | timezone | None = None) -> str | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return epoch_to_utc_iso(value)

    raw = str(value).strip()
    if not raw:
        return None

    as_int = to_int(raw)
    if as_int is not None and re.fullmatch(r"-?\d+", raw):
        return epoch_to_utc_iso(as_int)

    as_float = to_float(raw)
    if as_float is not None and re.fullmatch(r"-?\d+(\.\d+)?", raw):
        return epoch_to_utc_iso(as_float)

    iso_candidate = raw.replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(iso_candidate)
    except ValueError:
        dt = None

    if dt is None:
        for fmt in ("%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M:%S", "%d/%m/%Y %H:%M:%S"):
            try:
                dt = datetime.strptime(raw, fmt)
                break
            except ValueError:
                continue
        if dt is None:
            return None

    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=assume_tz or timezone.utc)

    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_excel_serial_to_utc_iso(
    value: Any,
    assume_tz: ZoneInfo | timezone | None = None,
) -> str | None:
    serial = to_float(value)
    if serial is None:
        return None
    if serial < 20000 or serial > 90000:
        return None

    tz = assume_tz or timezone.utc
    local_dt = datetime(1899, 12, 30, tzinfo=tz) + timedelta(days=serial)
    return local_dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def build_datetime_from_parts(
    year_value: Any,
    month_value: Any,
    day_value: Any,
    hour_value: Any,
    minute_value: Any,
    second_value: Any,
    assume_tz: ZoneInfo | timezone | None = None,
) -> str | None:
    year = to_int(year_value)
    month = to_int(month_value)
    day = to_int(day_value)
    if year is None or month is None or day is None:
        return None
    if year < 1800 or year > 2100:
        return None
    if month < 1 or month > 12:
        return None
    if day < 1 or day > 31:
        return None

    hour = to_int(hour_value)
    minute = to_int(minute_value)
    second = to_int(second_value)
    if hour is None:
        hour = 0
    if minute is None:
        minute = 0
    if second is None:
        second = 0

    if hour < 0 or hour > 23:
        return None
    if minute < 0 or minute > 59:
        return None
    if second < 0 or second > 59:
        return None

    tz = assume_tz or timezone.utc
    try:
        dt = datetime(year, month, day, hour, minute, second, tzinfo=tz)
    except ValueError:
        return None
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def decode_text(raw: bytes) -> str:
    for encoding in ("utf-8-sig", "utf-8", "latin-1"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def read_source_bytes(source: str, timeout_seconds: int, insecure_skip_verify: bool) -> bytes:
    if source.startswith("http://") or source.startswith("https://"):
        req = Request(source, headers={"User-Agent": "igp-seismic-stream/1.0"})
        ssl_context = ssl.create_default_context()
        if insecure_skip_verify:
            ssl_context.check_hostname = False
            ssl_context.verify_mode = ssl.CERT_NONE
        with urlopen(req, timeout=timeout_seconds, context=ssl_context) as response:
            return response.read()

    path = Path(source).expanduser()
    return path.read_bytes()


def read_text_source(source: str, timeout_seconds: int, insecure_skip_verify: bool) -> str:
    return decode_text(
        read_source_bytes(
            source=source,
            timeout_seconds=timeout_seconds,
            insecure_skip_verify=insecure_skip_verify,
        )
    )


def detect_historical_format(source: str, raw: bytes) -> str:
    parsed = urlparse(source)
    source_path = parsed.path if parsed.scheme else source
    suffix = Path(source_path).suffix.lower()
    if suffix in {".xlsx", ".xlsm"}:
        return "xlsx"
    if suffix in {".csv", ".txt"}:
        return "csv"
    if raw.startswith(b"PK"):
        try:
            with zipfile.ZipFile(io.BytesIO(raw)) as zf:
                if "xl/workbook.xml" in set(zf.namelist()):
                    return "xlsx"
        except zipfile.BadZipFile:
            pass
    return "csv"


def normalize_header_name(value: Any, idx: int, used: set[str]) -> str:
    base = str(value).strip() if value is not None else ""
    if not base:
        base = f"column_{idx + 1}"
    name = base
    counter = 2
    while name in used:
        name = f"{base}_{counter}"
        counter += 1
    used.add(name)
    return name


def parse_csv_rows(text: str) -> list[dict[str, Any]]:
    try:
        dialect = csv.Sniffer().sniff(text[:8192], delimiters=",;\t|")
    except csv.Error:
        dialect = csv.excel
    reader = csv.DictReader(io.StringIO(text), dialect=dialect)
    if not reader.fieldnames:
        raise RuntimeError("Historical table has no header row.")
    return [
        {str(k).strip(): v for k, v in row.items() if k is not None}
        for row in reader
        if isinstance(row, dict)
    ]


def xlsx_col_to_index(cell_ref: str) -> int | None:
    letters = "".join(ch for ch in cell_ref if ch.isalpha()).upper()
    if not letters:
        return None
    index = 0
    for ch in letters:
        if ch < "A" or ch > "Z":
            return None
        index = index * 26 + (ord(ch) - ord("A") + 1)
    return index - 1


def xlsx_cell_value(cell: ET.Element, shared_strings: list[str], ns_main: str) -> str | None:
    cell_type = cell.attrib.get("t")
    if cell_type == "inlineStr":
        inline = cell.find(f"{{{ns_main}}}is")
        if inline is None:
            return None
        return "".join(inline.itertext()) or None

    value_elem = cell.find(f"{{{ns_main}}}v")
    if value_elem is None or value_elem.text is None:
        return None
    raw_value = value_elem.text

    if cell_type == "s":
        idx = to_int(raw_value)
        if idx is None or idx < 0 or idx >= len(shared_strings):
            return None
        return shared_strings[idx]
    if cell_type == "b":
        return "1" if raw_value.strip() == "1" else "0"
    return raw_value


def parse_xlsx_rows(raw: bytes) -> list[dict[str, Any]]:
    ns_main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    ns_doc_rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    ns_pkg_rel = "http://schemas.openxmlformats.org/package/2006/relationships"

    try:
        zf_obj = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile as exc:
        raise RuntimeError(
            "Historical source is not a valid XLSX file. "
            "Check IGP_HISTORICAL_SOURCE_URL points to a direct downloadable file."
        ) from exc

    with zf_obj as zf:
        workbook_xml = ET.fromstring(zf.read("xl/workbook.xml"))
        first_sheet = workbook_xml.find(f".//{{{ns_main}}}sheets/{{{ns_main}}}sheet")
        if first_sheet is None:
            raise RuntimeError("Historical XLSX has no sheets.")
        sheet_rel_id = first_sheet.attrib.get(f"{{{ns_doc_rel}}}id")
        if not sheet_rel_id:
            raise RuntimeError("Historical XLSX sheet relationship id not found.")

        rels_xml = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
        sheet_target: str | None = None
        for rel in rels_xml.findall(f"{{{ns_pkg_rel}}}Relationship"):
            if rel.attrib.get("Id") == sheet_rel_id:
                sheet_target = rel.attrib.get("Target")
                break
        if not sheet_target:
            raise RuntimeError("Historical XLSX worksheet target not found.")

        if sheet_target.startswith("/"):
            sheet_path = sheet_target.lstrip("/")
        else:
            sheet_path = posixpath.normpath(posixpath.join("xl", sheet_target))

        shared_strings: list[str] = []
        if "xl/sharedStrings.xml" in set(zf.namelist()):
            shared_xml = ET.fromstring(zf.read("xl/sharedStrings.xml"))
            for si in shared_xml.findall(f"{{{ns_main}}}si"):
                shared_strings.append("".join(si.itertext()))

        sheet_xml = ET.fromstring(zf.read(sheet_path))
        sheet_data = sheet_xml.find(f"{{{ns_main}}}sheetData")
        if sheet_data is None:
            raise RuntimeError("Historical XLSX sheetData not found.")

        matrix_rows: list[list[Any]] = []
        for row_elem in sheet_data.findall(f"{{{ns_main}}}row"):
            row_cells: dict[int, Any] = {}
            cursor = 0
            for cell in row_elem.findall(f"{{{ns_main}}}c"):
                ref = cell.attrib.get("r", "")
                col_idx = xlsx_col_to_index(ref) if ref else cursor
                if col_idx is None:
                    col_idx = cursor
                cursor = col_idx + 1
                row_cells[col_idx] = xlsx_cell_value(cell, shared_strings, ns_main)
            if not row_cells:
                matrix_rows.append([])
                continue
            max_col = max(row_cells)
            matrix_rows.append([row_cells.get(i) for i in range(max_col + 1)])

    headers: list[str] | None = None
    header_used: set[str] = set()
    parsed_rows: list[dict[str, Any]] = []

    for values in matrix_rows:
        if all(v is None or str(v).strip() == "" for v in values):
            continue

        if headers is None:
            headers = [normalize_header_name(v, i, header_used) for i, v in enumerate(values)]
            continue

        if len(values) > len(headers):
            for i in range(len(headers), len(values)):
                headers.append(normalize_header_name(None, i, header_used))

        row_dict: dict[str, Any] = {}
        has_any = False
        for idx, name in enumerate(headers):
            value = values[idx] if idx < len(values) else None
            if isinstance(value, str):
                stripped = value.strip()
                value = stripped if stripped else None
            if value is not None:
                has_any = True
            row_dict[name] = value
        if has_any:
            parsed_rows.append(row_dict)

    if headers is None:
        raise RuntimeError("Historical XLSX has no header row.")
    return parsed_rows


def load_historical_rows(
    source: str,
    timeout_seconds: int,
    insecure_skip_verify: bool,
) -> tuple[list[dict[str, Any]], str]:
    raw = read_source_bytes(
        source=source,
        timeout_seconds=timeout_seconds,
        insecure_skip_verify=insecure_skip_verify,
    )
    data_format = detect_historical_format(source, raw)
    if data_format == "xlsx":
        return parse_xlsx_rows(raw), data_format
    return parse_csv_rows(decode_text(raw)), data_format


def stable_synthetic_objectid(seed: str) -> int:
    digest = hashlib.sha1(seed.encode("utf-8")).hexdigest()
    numeric = int(digest[:15], 16)
    return -(numeric + 1)


def iso_utc_to_zone_fields(
    iso_utc: str | None, tz: ZoneInfo
) -> tuple[str | None, str | None, str | None]:
    if not iso_utc:
        return None, None, None
    try:
        utc_dt = datetime.fromisoformat(iso_utc.replace("Z", "+00:00")).astimezone(timezone.utc)
    except (TypeError, ValueError):
        return None, None, None
    local_dt = utc_dt.astimezone(tz).replace(microsecond=0)
    return local_dt.isoformat(), local_dt.date().isoformat(), local_dt.strftime("%H:%M:%S")


def iso_to_utc_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except (TypeError, ValueError):
        return None


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
            ultimo INTEGER,
            reporte INTEGER,
            mag REAL,
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
    migrate_raw_events_column_types(conn)
    conn.commit()


def migrate_raw_events_column_types(conn: sqlite3.Connection) -> None:
    current_types = {
        str(row[1]): str(row[2]).upper()
        for row in conn.execute("PRAGMA table_info(raw_events)")
    }
    if not current_types:
        return

    if current_types.get("ultimo") == "INTEGER" and current_types.get("mag") == "REAL":
        return

    original_row_factory = conn.row_factory
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        """
        SELECT
            objectid, code, event_ts_utc, event_ts_local, event_date_local, event_time_local,
            fecha_ms, fechaevento_ms, hora, lat, lon, magnitud, prof, profundidad, intensidad,
            departamento, referencia, ultimo, reporte, mag, raw_attributes_json, raw_geometry_json,
            ingested_at_utc
        FROM raw_events
        """
    ).fetchall()
    conn.row_factory = original_row_factory

    conn.executescript(
        """
        DROP TABLE IF EXISTS raw_events_v2;
        CREATE TABLE raw_events_v2 (
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
            ultimo INTEGER,
            reporte INTEGER,
            mag REAL,
            raw_attributes_json TEXT NOT NULL,
            raw_geometry_json TEXT,
            ingested_at_utc TEXT NOT NULL
        );
        """
    )

    insert_sql = """
        INSERT INTO raw_events_v2 (
            objectid, code, event_ts_utc, event_ts_local, event_date_local, event_time_local,
            fecha_ms, fechaevento_ms, hora, lat, lon, magnitud, prof, profundidad, intensidad,
            departamento, referencia, ultimo, reporte, mag, raw_attributes_json, raw_geometry_json,
            ingested_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """
    for row in rows:
        conn.execute(
            insert_sql,
            (
                row["objectid"],
                row["code"],
                row["event_ts_utc"],
                row["event_ts_local"],
                row["event_date_local"],
                row["event_time_local"],
                to_int(row["fecha_ms"]),
                to_int(row["fechaevento_ms"]),
                row["hora"],
                to_float(row["lat"]),
                to_float(row["lon"]),
                to_float(row["magnitud"]),
                to_int(row["prof"]),
                row["profundidad"],
                row["intensidad"],
                row["departamento"],
                row["referencia"],
                to_int(row["ultimo"]),
                to_int(row["reporte"]),
                to_float(row["mag"]),
                row["raw_attributes_json"],
                row["raw_geometry_json"],
                row["ingested_at_utc"],
            ),
        )

    conn.executescript(
        """
        DROP TABLE raw_events;
        ALTER TABLE raw_events_v2 RENAME TO raw_events;
        CREATE INDEX IF NOT EXISTS idx_raw_events_code ON raw_events(code);
        CREATE INDEX IF NOT EXISTS idx_raw_events_event_ts ON raw_events(event_ts_utc);
        """
    )


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


def upsert_raw_event(
    conn: sqlite3.Connection,
    *,
    objectid: int,
    code: Any,
    event_ts_utc: str | None,
    event_ts_local: str | None,
    event_date_local: str | None,
    event_time_local: str | None,
    fecha_ms: int | None,
    fechaevento_ms: int | None,
    hora: str | None,
    lat: float | None,
    lon: float | None,
    magnitud: float | None,
    prof: int | None,
    profundidad: Any,
    intensidad: Any,
    departamento: Any,
    referencia: Any,
    ultimo: int | None,
    reporte: int | None,
    mag: float | None,
    raw_attributes: dict[str, Any],
    raw_geometry: dict[str, Any],
    ingested_at_utc: str,
) -> bool:
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
            code,
            event_ts_utc,
            event_ts_local,
            event_date_local,
            event_time_local,
            fecha_ms,
            fechaevento_ms,
            hora,
            lat,
            lon,
            magnitud,
            prof,
            profundidad,
            intensidad,
            departamento,
            referencia,
            ultimo,
            reporte,
            mag,
            json.dumps(raw_attributes, ensure_ascii=True, sort_keys=True),
            json.dumps(raw_geometry, ensure_ascii=True, sort_keys=True),
            ingested_at_utc,
        ),
    )
    return conn.total_changes > before


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

        objectid = to_int(attrs.get("objectid"))
        if objectid is None:
            continue

        geom = feature.get("geometry")
        if not isinstance(geom, dict):
            geom = {}

        fecha_ms_int = to_int(attrs.get("fecha"))
        fechaevento_ms_int = to_int(attrs.get("fechaevento"))
        hora_text = str(attrs.get("hora")) if attrs.get("hora") is not None else None
        event_ts_utc, event_ts_local, event_date_local, event_time_local = parse_event_times(
            fechaevento_ms=fechaevento_ms_int,
            fecha_ms=fecha_ms_int,
            hora=hora_text,
        )

        lat = to_float(attrs.get("lat"))
        lon = to_float(attrs.get("lon"))
        if lat is None:
            lat = to_float(geom.get("y"))
        if lon is None:
            lon = to_float(geom.get("x"))

        changed = upsert_raw_event(
            conn,
            objectid=objectid,
            code=attrs.get("code"),
            event_ts_utc=event_ts_utc,
            event_ts_local=event_ts_local,
            event_date_local=event_date_local,
            event_time_local=event_time_local,
            fecha_ms=fecha_ms_int,
            fechaevento_ms=fechaevento_ms_int,
            hora=hora_text,
            lat=lat,
            lon=lon,
            magnitud=to_float(attrs.get("magnitud")),
            prof=to_int(attrs.get("prof")),
            profundidad=attrs.get("profundidad"),
            intensidad=attrs.get("int_"),
            departamento=attrs.get("departamento"),
            referencia=attrs.get("ref"),
            ultimo=to_int(attrs.get("ultimo")),
            reporte=to_int(attrs.get("reporte")),
            mag=to_float(attrs.get("mag")),
            raw_attributes=attrs,
            raw_geometry=geom,
            ingested_at_utc=now_iso,
        )
        if changed:
            inserted_rows += 1
        if objectid > latest_objectid:
            latest_objectid = objectid

    conn.commit()
    return inserted_rows, latest_objectid


def should_refresh_historical(
    state: dict[str, Any],
    source: str,
    refresh_hours: int,
    force_refresh: bool,
) -> bool:
    if force_refresh:
        return True

    if str(state.get("historical_source", "")) != source:
        return True

    last_refresh = iso_to_utc_datetime(str(state.get("historical_last_refresh_utc", "")))
    if last_refresh is None:
        return True

    age_seconds = (datetime.now(timezone.utc) - last_refresh).total_seconds()
    return age_seconds >= max(refresh_hours, 1) * 3600


def import_historical_source(
    conn: sqlite3.Connection,
    state: dict[str, Any],
    source: str | None,
    timeout_seconds: int,
    insecure_skip_verify: bool,
    refresh_hours: int,
    force_refresh: bool,
) -> tuple[int, bool]:
    if source is None:
        return 0, False

    source = source.strip()
    if not source:
        return 0, False

    if not should_refresh_historical(
        state=state,
        source=source,
        refresh_hours=refresh_hours,
        force_refresh=force_refresh,
    ):
        return 0, False

    historical_rows, source_format = load_historical_rows(
        source=source,
        timeout_seconds=timeout_seconds,
        insecure_skip_verify=insecure_skip_verify,
    )

    inserted_rows = 0
    now_iso = utc_now_iso()

    for raw_row in historical_rows:
        row = {str(k).strip(): v for k, v in raw_row.items() if k is not None}
        key_map = build_row_key_map(row)

        code = pick_row_value(
            row,
            key_map,
            ["code", "codigo", "cod", "codigoevento", "event_code", "src_code"],
        )
        source_objectid = to_int(
            pick_row_value(row, key_map, ["objectid", "id", "oid", "id_evento", "src_objectid"])
        )

        fecha_raw = pick_row_value(
            row,
            key_map,
            [
                "fecha",
                "fecha_ms",
                "src_fecha",
                "fecha_utc",
                "date",
                "fecha_hora",
                "fecha_hora_utc",
            ],
        )
        if fecha_raw is None:
            fecha_raw = pick_row_value_contains(
                row,
                key_map,
                includes=["fecha"],
                excludes=["evento", "ms", "stamp"],
            )
        fechaevento_raw = pick_row_value(
            row,
            key_map,
            [
                "fechaevento",
                "fechaevento_ms",
                "src_fechaevento",
                "fecha_hora",
                "datetime",
                "datetime_utc",
                "timestamp",
            ],
        )
        if fechaevento_raw is None:
            fechaevento_raw = pick_row_value_contains(
                row,
                key_map,
                includes=["fecha", "evento"],
            )
        fecha_ms_int = to_epoch_ms(fecha_raw)
        fechaevento_ms_int = to_epoch_ms(fechaevento_raw)
        hora_value = pick_row_value(
            row,
            key_map,
            ["hora", "hora_utc", "horautc", "time", "event_time_local", "src_hora"],
        )
        if hora_value is None:
            hora_value = pick_row_value_contains(
                row,
                key_map,
                includes=["hora"],
                excludes=["fech", "ms"],
            )
        hora_text = str(hora_value) if hora_value is not None else None

        event_ts_utc_raw = pick_row_value(
            row, key_map, ["event_ts_utc", "timestamp_utc", "utc_datetime", "datetime_utc"]
        )
        event_ts_utc = parse_excel_serial_to_utc_iso(
            event_ts_utc_raw,
            assume_tz=timezone.utc,
        )
        if event_ts_utc is None:
            event_ts_utc = parse_datetime_to_utc_iso(event_ts_utc_raw, assume_tz=timezone.utc)
        if event_ts_utc is None:
            local_ts_raw = pick_row_value(
                row,
                key_map,
                ["event_ts_local", "event_ts_et", "timestamp_local", "fecha_hora", "datetime"],
            )
            event_ts_utc = parse_excel_serial_to_utc_iso(local_ts_raw, assume_tz=LOCAL_TZ)
        if event_ts_utc is None:
            event_ts_utc = parse_datetime_to_utc_iso(
                local_ts_raw,
                assume_tz=LOCAL_TZ,
            )
        if event_ts_utc is None:
            event_ts_utc = parse_excel_serial_to_utc_iso(fechaevento_raw, assume_tz=LOCAL_TZ)
        if event_ts_utc is None:
            event_ts_utc = parse_datetime_to_utc_iso(fechaevento_raw, assume_tz=LOCAL_TZ)
        if event_ts_utc is None and hora_text and fecha_raw is not None:
            event_ts_utc = parse_datetime_to_utc_iso(f"{fecha_raw} {hora_text}", assume_tz=LOCAL_TZ)
        if event_ts_utc is None:
            year_part = pick_row_value(
                row,
                key_map,
                ["year", "anio", "ano", "yyyy", "año", "src_year"],
            )
            if year_part is None:
                year_part = pick_row_value_contains(
                    row,
                    key_map,
                    includes=["anio"],
                )
            month_part = pick_row_value(
                row,
                key_map,
                ["month", "mes", "mm", "src_month"],
            )
            if month_part is None:
                month_part = pick_row_value_contains(
                    row,
                    key_map,
                    includes=["mes"],
                )
            day_part = pick_row_value(
                row,
                key_map,
                ["day", "dia", "dd", "src_day"],
            )
            if day_part is None:
                day_part = pick_row_value_contains(
                    row,
                    key_map,
                    includes=["dia"],
                )
            hour_part = pick_row_value(
                row,
                key_map,
                ["hour", "hh", "hora", "src_hour"],
            )
            minute_part = pick_row_value(
                row,
                key_map,
                ["minute", "min", "minuto", "src_minute"],
            )
            second_part = pick_row_value(
                row,
                key_map,
                ["second", "sec", "segundo", "src_second"],
            )
            event_ts_utc = build_datetime_from_parts(
                year_value=year_part,
                month_value=month_part,
                day_value=day_part,
                hour_value=hour_part,
                minute_value=minute_part,
                second_value=second_part,
                assume_tz=LOCAL_TZ,
            )
        if event_ts_utc is None:
            event_ts_utc, _, _, _ = parse_event_times(
                fechaevento_ms=fechaevento_ms_int,
                fecha_ms=fecha_ms_int,
                hora=hora_text,
            )

        event_ts_local, event_date_local, event_time_local = iso_utc_to_zone_fields(
            event_ts_utc, LOCAL_TZ
        )

        lat = to_float(pick_row_value(row, key_map, ["lat", "latitude", "latitud", "src_lat", "y"]))
        lon = to_float(
            pick_row_value(row, key_map, ["lon", "lng", "longitude", "longitud", "src_lon", "x"])
        )
        magnitud = to_float(
            pick_row_value(
                row,
                key_map,
                ["magnitud", "magnitude", "mag", "ml", "mw", "src_magnitud", "src_mag"],
            )
        )
        prof = to_int(pick_row_value(row, key_map, ["prof", "depth", "depth_km", "src_prof"]))
        profundidad = pick_row_value(row, key_map, ["profundidad", "depth_type", "src_profundidad"])
        intensidad = pick_row_value(row, key_map, ["intensidad", "int_", "src_int_"])
        departamento = pick_row_value(row, key_map, ["departamento", "region", "src_departamento"])
        referencia = pick_row_value(row, key_map, ["referencia", "ref", "ubicacion", "src_ref"])
        ultimo = to_int(pick_row_value(row, key_map, ["ultimo", "src_ultimo"]))
        reporte = to_int(pick_row_value(row, key_map, ["reporte", "src_reporte"]))
        mag = to_float(pick_row_value(row, key_map, ["mag", "src_mag"]))
        if mag is None:
            mag = magnitud

        seed = "|".join(
            [
                str(source),
                str(source_objectid if source_objectid is not None else ""),
                str(code or ""),
                str(event_ts_utc or ""),
                str(lat if lat is not None else ""),
                str(lon if lon is not None else ""),
                str(magnitud if magnitud is not None else ""),
                str(prof if prof is not None else ""),
            ]
        )
        # Keep historical rows in a separate objectid namespace to avoid collisions with live ArcGIS objectid.
        objectid = stable_synthetic_objectid(seed)

        geom_payload: dict[str, Any] = {}
        if lat is not None and lon is not None:
            geom_payload = {"x": lon, "y": lat}

        attrs_payload = {k: v for k, v in row.items()}
        attrs_payload["source_type"] = f"historical_{source_format}"
        attrs_payload["source_ref"] = source

        changed = upsert_raw_event(
            conn,
            objectid=objectid,
            code=code,
            event_ts_utc=event_ts_utc,
            event_ts_local=event_ts_local,
            event_date_local=event_date_local,
            event_time_local=event_time_local,
            fecha_ms=fecha_ms_int,
            fechaevento_ms=fechaevento_ms_int,
            hora=hora_text,
            lat=lat,
            lon=lon,
            magnitud=magnitud,
            prof=prof,
            profundidad=profundidad,
            intensidad=intensidad,
            departamento=departamento,
            referencia=referencia,
            ultimo=ultimo,
            reporte=reporte,
            mag=mag,
            raw_attributes=attrs_payload,
            raw_geometry=geom_payload,
            ingested_at_utc=now_iso,
        )
        if changed:
            inserted_rows += 1

    conn.commit()
    state["historical_source"] = source
    state["historical_last_refresh_utc"] = utc_now_iso()
    return inserted_rows, True


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

    db_cols = [
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
    static_cols = [
        "objectid",
        "code",
        "event_ts_utc",
        "event_ts_et",
        "event_date_et",
        "event_time_et",
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
            out: dict[str, Any] = {col: row[col] for col in db_cols}
            event_ts_et, event_date_et, event_time_et = iso_utc_to_zone_fields(
                row["event_ts_utc"], ET_TZ
            )
            out["event_ts_et"] = event_ts_et
            out["event_date_et"] = event_date_et
            out["event_time_et"] = event_time_et
            try:
                payload = json.loads(row["raw_attributes_json"] or "{}")
            except json.JSONDecodeError:
                payload = {}
            if isinstance(payload, dict):
                for key in payload_keys:
                    out[f"src_{key}"] = payload.get(key)
            writer.writerow(out)

    return len(rows)


def export_curated_csv(conn: sqlite3.Connection, csv_path: Path) -> int:
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        """
        SELECT
            objectid,
            code,
            event_ts_utc,
            lat,
            lon,
            magnitud,
            prof,
            profundidad,
            intensidad,
            departamento,
            referencia,
            ultimo,
            reporte,
            ingested_at_utc
        FROM raw_events
        ORDER BY event_ts_utc DESC, objectid DESC
        """
    ).fetchall()

    fieldnames = [
        "objectid",
        "code",
        "event_ts_et",
        "event_date_et",
        "event_time_et",
        "event_ts_utc",
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
        "ingested_at_utc",
    ]

    csv_path.parent.mkdir(parents=True, exist_ok=True)
    with csv_path.open("w", newline="", encoding="utf-8") as csv_file:
        writer = csv.DictWriter(csv_file, fieldnames=fieldnames)
        writer.writeheader()
        seen_keys: set[tuple[Any, ...]] = set()
        exported_rows = 0
        for row in rows:
            code_value = str(row["code"]).strip() if row["code"] is not None else ""
            if code_value:
                dedupe_key: tuple[Any, ...] = ("code", code_value.upper())
            else:
                dedupe_key = (
                    "fallback",
                    row["event_ts_utc"],
                    row["lat"],
                    row["lon"],
                    row["magnitud"],
                    row["prof"],
                )
            if dedupe_key in seen_keys:
                continue
            seen_keys.add(dedupe_key)

            event_ts_et, event_date_et, event_time_et = iso_utc_to_zone_fields(
                row["event_ts_utc"], ET_TZ
            )
            writer.writerow(
                {
                    "objectid": row["objectid"],
                    "code": row["code"],
                    "event_ts_et": event_ts_et,
                    "event_date_et": event_date_et,
                    "event_time_et": event_time_et,
                    "event_ts_utc": row["event_ts_utc"],
                    "lat": row["lat"],
                    "lon": row["lon"],
                    "magnitud": row["magnitud"],
                    "prof": row["prof"],
                    "profundidad": row["profundidad"],
                    "intensidad": row["intensidad"],
                    "departamento": row["departamento"],
                    "referencia": row["referencia"],
                    "ultimo": row["ultimo"],
                    "reporte": row["reporte"],
                    "ingested_at_utc": row["ingested_at_utc"],
                }
            )
            exported_rows += 1
    return exported_rows


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
        event_ts_et, event_date_et, event_time_et = iso_utc_to_zone_fields(
            row["event_ts_utc"], ET_TZ
        )
        properties["event_ts_et"] = event_ts_et
        properties["event_date_et"] = event_date_et
        properties["event_time_et"] = event_time_et

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
    historical_source: str | None,
    historical_refresh_hours: int,
    force_historical_refresh: bool,
    skip_live_fetch: bool,
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

        if skip_live_fetch:
            new_fields = []
        else:
            metadata = fetch_layer_metadata(
                timeout_seconds=timeout_seconds,
                insecure_skip_verify=insecure_skip_verify,
            )
            new_fields = sync_schema_metadata(conn, metadata, known_fields)

        historical_rows = 0
        historical_refreshed = False
        historical_error: str | None = None
        try:
            historical_rows, historical_refreshed = import_historical_source(
                conn=conn,
                state=state,
                source=historical_source,
                timeout_seconds=timeout_seconds,
                insecure_skip_verify=insecure_skip_verify,
                refresh_hours=historical_refresh_hours,
                force_refresh=force_historical_refresh,
            )
            state.pop("historical_last_error", None)
            state.pop("historical_last_error_utc", None)
        except Exception as exc:
            historical_error = str(exc)
            state["historical_last_error"] = historical_error
            state["historical_last_error_utc"] = utc_now_iso()

        if skip_live_fetch:
            upsert_count, latest_seen = 0, last_objectid
        else:
            features = fetch_new_features(
                last_objectid=last_objectid,
                batch_size=batch_size,
                timeout_seconds=timeout_seconds,
                insecure_skip_verify=insecure_skip_verify,
            )
            upsert_count, latest_seen = upsert_features(conn, features)

        if latest_seen > last_objectid:
            state["last_objectid"] = latest_seen
        if historical_refreshed:
            last_hist_et, _, _ = iso_utc_to_zone_fields(state["historical_last_refresh_utc"], ET_TZ)
            state["historical_last_refresh_et"] = last_hist_et
        state["known_fields"] = known_fields
        state["last_run_utc"] = utc_now_iso()
        last_run_et, _, _ = iso_utc_to_zone_fields(state["last_run_utc"], ET_TZ)
        state["last_run_et"] = last_run_et
        save_state(state_path, state)

        csv_path = output_dir / "earthquakes_live.csv"
        curated_csv_path = output_dir / "earthquakes_live_curated.csv"
        geojson_path = output_dir / "earthquakes_live.geojson"
        export_csv(conn, csv_path)
        export_curated_csv(conn, curated_csv_path)
        export_geojson(conn, geojson_path)

        return RunSummary(
            new_rows=upsert_count,
            historical_rows=historical_rows,
            historical_error=historical_error,
            latest_objectid=int(state["last_objectid"]),
            total_rows=count_rows(conn),
            new_fields=new_fields,
            csv_path=csv_path,
            curated_csv_path=curated_csv_path,
            geojson_path=geojson_path,
        )
    finally:
        conn.close()


def build_parser() -> argparse.ArgumentParser:
    historical_refresh_default = 24
    env_refresh = os.getenv("IGP_HISTORICAL_REFRESH_HOURS", "").strip()
    if env_refresh:
        parsed_refresh = to_int(env_refresh)
        if parsed_refresh is not None and parsed_refresh > 0:
            historical_refresh_default = parsed_refresh

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
        "--historical-source",
        type=str,
        default=os.getenv("IGP_HISTORICAL_SOURCE_URL"),
        help=(
            "Optional URL or local CSV/XLSX path for historical backfill. "
            "If omitted, only live API rows are ingested."
        ),
    )
    parser.add_argument(
        "--historical-refresh-hours",
        type=int,
        default=historical_refresh_default,
        help=(
            "How often to refresh historical source (hours). "
            "Used only when --historical-source is set."
        ),
    )
    parser.add_argument(
        "--force-historical-refresh",
        action="store_true",
        help="Refresh historical source now, ignoring last historical refresh timestamp.",
    )
    parser.add_argument(
        "--skip-live-fetch",
        action="store_true",
        help="Skip live ArcGIS fetch (useful for testing historical ingestion only).",
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
    if args.historical_refresh_hours < 1:
        parser.error("--historical-refresh-hours must be at least 1.")

    while True:
        try:
            summary = run_once(
                db_path=args.db_path,
                state_path=args.state_path,
                output_dir=args.output_dir,
                batch_size=args.batch_size,
                timeout_seconds=args.timeout_seconds,
                insecure_skip_verify=args.insecure_skip_verify,
                historical_source=args.historical_source,
                historical_refresh_hours=args.historical_refresh_hours,
                force_historical_refresh=args.force_historical_refresh,
                skip_live_fetch=args.skip_live_fetch,
            )
            now_utc = utc_now_iso()
            now_et, _, _ = iso_utc_to_zone_fields(now_utc, ET_TZ)
            print(
                json.dumps(
                    {
                        "status": "ok",
                        "new_rows": summary.new_rows,
                        "historical_rows": summary.historical_rows,
                        "historical_error": summary.historical_error,
                        "latest_objectid": summary.latest_objectid,
                        "total_rows": summary.total_rows,
                        "new_fields": summary.new_fields,
                        "csv": str(summary.csv_path),
                        "curated_csv": str(summary.curated_csv_path),
                        "geojson": str(summary.geojson_path),
                        "run_at_utc": now_utc,
                        "run_at_et": now_et,
                        "historical_source": args.historical_source,
                    }
                )
            )
        except Exception as exc:
            now_utc = utc_now_iso()
            now_et, _, _ = iso_utc_to_zone_fields(now_utc, ET_TZ)
            print(
                json.dumps(
                    {
                        "status": "error",
                        "error": str(exc),
                        "run_at_utc": now_utc,
                        "run_at_et": now_et,
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
