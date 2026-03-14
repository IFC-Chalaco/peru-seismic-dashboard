const DATA_URL = "./data/earthquakes_live_curated.csv";
const META_URL = "./data/dashboard_meta.json";
const PERU_VIEW = {
  center: [-9.19, -75.02],
  zoom: 5,
};
const MAP_LIMIT = 2500;
const TABLE_LIMIT = 12;
const MAG_BUCKETS = [
  { label: "< 3.0", min: -Infinity, max: 2.999 },
  { label: "3.0 - 3.9", min: 3.0, max: 3.999 },
  { label: "4.0 - 4.9", min: 4.0, max: 4.999 },
  { label: "5.0 - 5.9", min: 5.0, max: 5.999 },
  { label: "6.0+", min: 6.0, max: Infinity },
];

const state = {
  allRows: [],
  filteredRows: [],
  meta: null,
  map: null,
  markerLayer: null,
  activeRange: "7",
  renderer: null,
};

const elements = {};

document.addEventListener("DOMContentLoaded", () => {
  cacheElements();
  initMap();
  bindEvents();
  loadDashboard().catch((error) => {
    console.error(error);
    showError("The dashboard could not load the published data feed.");
  });
});

function cacheElements() {
  const ids = [
    "generated-at",
    "coverage-text",
    "row-count",
    "source-text",
    "filter-summary",
    "start-date",
    "end-date",
    "department-select",
    "min-magnitude",
    "min-mag-value",
    "apply-filters",
    "reset-filters",
    "download-filtered",
    "kpi-filtered",
    "kpi-filtered-note",
    "kpi-strongest",
    "kpi-strongest-note",
    "kpi-depth",
    "kpi-depth-note",
    "kpi-latest",
    "kpi-latest-note",
    "map-note",
    "trend-grain",
    "trend-chart",
    "magnitude-chart",
    "department-list",
    "table-count",
    "recent-events-body",
    "error-banner",
  ];
  ids.forEach((id) => {
    elements[id] = document.getElementById(id);
  });
  elements.quickRangeButtons = Array.from(document.querySelectorAll("[data-range]"));
}

function initMap() {
  if (typeof L === "undefined") {
    showError("Leaflet could not be loaded, so the map is unavailable.");
    return;
  }

  state.renderer = L.canvas({ padding: 0.35 });
  state.map = L.map("map", {
    zoomControl: false,
    preferCanvas: true,
    renderer: state.renderer,
    scrollWheelZoom: true,
  }).setView(PERU_VIEW.center, PERU_VIEW.zoom);

  L.control.zoom({ position: "topright" }).addTo(state.map);

  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    subdomains: "abcd",
    maxZoom: 18,
  }).addTo(state.map);

  state.markerLayer = L.layerGroup().addTo(state.map);
}

function bindEvents() {
  elements.quickRangeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.activeRange = button.dataset.range || "7";
      syncQuickRangeButtons();
      applyQuickRange();
      applyFilters();
    });
  });

  elements["apply-filters"].addEventListener("click", () => {
    state.activeRange = "";
    syncQuickRangeButtons();
    applyFilters();
  });

  elements["reset-filters"].addEventListener("click", () => {
    state.activeRange = "7";
    syncQuickRangeButtons();
    applyQuickRange();
    elements["department-select"].value = "";
    elements["min-magnitude"].value = "0";
    updateMinMagnitudeLabel();
    applyFilters();
  });

  elements["download-filtered"].addEventListener("click", downloadFilteredCsv);

  elements["min-magnitude"].addEventListener("input", () => {
    updateMinMagnitudeLabel();
  });
}

async function loadDashboard() {
  const [rows, meta] = await Promise.all([loadCsvRows(), loadMeta()]);
  state.allRows = rows;
  state.meta = meta;

  if (!rows.length) {
    showError("The published website data file is empty.");
    return;
  }

  hydrateMeta();
  populateFilterOptions();
  updateMinMagnitudeLabel();
  applyQuickRange();
  applyFilters();
}

function loadCsvRows() {
  return new Promise((resolve, reject) => {
    if (typeof Papa === "undefined") {
      reject(new Error("PapaParse was not loaded."));
      return;
    }

    Papa.parse(withCacheBust(DATA_URL), {
      download: true,
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        if (results.errors && results.errors.length) {
          reject(results.errors[0]);
          return;
        }
        const rows = (results.data || [])
          .map(parseRow)
          .filter((row) => row !== null)
          .sort((left, right) => right.eventMs - left.eventMs);
        resolve(rows);
      },
      error: reject,
    });
  });
}

async function loadMeta() {
  try {
    const response = await fetch(withCacheBust(META_URL), { cache: "no-store" });
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch (error) {
    console.warn("Metadata file unavailable", error);
    return null;
  }
}

function parseRow(raw) {
  if (!raw || !raw.event_ts_utc) {
    return null;
  }

  const eventDateEt = String(raw.event_date_et || "").trim();
  const eventTimeEt = String(raw.event_time_et || "").trim();
  const eventTsEt = String(raw.event_ts_et || "").trim();
  const eventTsUtc = String(raw.event_ts_utc || "").trim();
  const eventMs = Number.isFinite(Date.parse(eventTsEt))
    ? Date.parse(eventTsEt)
    : Date.parse(eventTsUtc);

  if (!Number.isFinite(eventMs)) {
    return null;
  }

  return {
    objectid: Number(raw.objectid),
    code: String(raw.code || "").trim(),
    event_ts_et: eventTsEt,
    event_date_et: eventDateEt,
    event_time_et: eventTimeEt,
    event_ts_utc: eventTsUtc,
    lat: parseNumber(raw.lat),
    lon: parseNumber(raw.lon),
    magnitud: parseNumber(raw.magnitud),
    prof: parseNumber(raw.prof),
    profundidad: String(raw.profundidad || "").trim(),
    intensidad: String(raw.intensidad || "").trim(),
    departamento: String(raw.departamento || "").trim(),
    referencia: String(raw.referencia || "").trim(),
    ultimo: Number(raw.ultimo || 0),
    reporte: Number(raw.reporte || 0),
    ingested_at_utc: String(raw.ingested_at_utc || "").trim(),
    eventMs,
  };
}

function hydrateMeta() {
  const minDate = state.meta?.min_event_date_et || state.allRows.at(-1)?.event_date_et || "";
  const maxDate = state.meta?.max_event_date_et || state.allRows[0]?.event_date_et || "";
  elements["generated-at"].textContent = formatMetaTimestamp(state.meta?.generated_at_et || state.allRows[0]?.event_ts_et);
  elements["coverage-text"].textContent = minDate && maxDate ? `${minDate} to ${maxDate}` : "Coverage unavailable";
  elements["row-count"].textContent = formatNumber(state.meta?.row_count || state.allRows.length);
  elements["source-text"].textContent = "Curated feed mirrored into /docs/data and refreshed by GitHub Actions.";

  elements["start-date"].min = minDate;
  elements["start-date"].max = maxDate;
  elements["end-date"].min = minDate;
  elements["end-date"].max = maxDate;
}

function populateFilterOptions() {
  const departments =
    state.meta?.departments ||
    Array.from(
      new Set(
        state.allRows
          .map((row) => row.departamento)
          .filter((value) => value)
      )
    ).sort((left, right) => left.localeCompare(right));

  const select = elements["department-select"];
  select.innerHTML = '<option value="">All departments</option>';
  departments.forEach((department) => {
    const option = document.createElement("option");
    option.value = department;
    option.textContent = department;
    select.appendChild(option);
  });
}

function applyQuickRange() {
  const minDate = elements["start-date"].min;
  const maxDate = elements["end-date"].max;
  if (!minDate || !maxDate) {
    return;
  }

  let startDate = minDate;
  let endDate = maxDate;

  if (state.activeRange === "all") {
    startDate = minDate;
  } else if (state.activeRange === "ytd") {
    startDate = `${maxDate.slice(0, 4)}-01-01`;
    if (startDate < minDate) {
      startDate = minDate;
    }
  } else {
    const days = Number(state.activeRange || 7);
    if (Number.isFinite(days) && days > 0) {
      startDate = shiftIsoDate(maxDate, -(days - 1));
      if (startDate < minDate) {
        startDate = minDate;
      }
    }
  }

  elements["start-date"].value = startDate;
  elements["end-date"].value = endDate;
}

function applyFilters() {
  clearError();

  let startDate = elements["start-date"].value || elements["start-date"].min;
  let endDate = elements["end-date"].value || elements["end-date"].max;
  if (startDate && endDate && startDate > endDate) {
    [startDate, endDate] = [endDate, startDate];
    elements["start-date"].value = startDate;
    elements["end-date"].value = endDate;
  }

  const department = elements["department-select"].value;
  const minMagnitude = parseNumber(elements["min-magnitude"].value) || 0;

  state.filteredRows = state.allRows.filter((row) => {
    if (startDate && row.event_date_et < startDate) {
      return false;
    }
    if (endDate && row.event_date_et > endDate) {
      return false;
    }
    if (department && row.departamento !== department) {
      return false;
    }
    if (Number.isFinite(row.magnitud) && row.magnitud < minMagnitude) {
      return false;
    }
    if (!Number.isFinite(row.magnitud) && minMagnitude > 0) {
      return false;
    }
    return true;
  });

  updateFilterSummary(startDate, endDate, department, minMagnitude);
  renderKpis();
  renderMap();
  renderTrend(startDate, endDate);
  renderMagnitudeMix();
  renderDepartments();
  renderRecentEvents();
}

function renderKpis() {
  const rows = state.filteredRows;
  const latest = rows[0];
  const maxMagnitudeRow = rows.reduce((best, row) => {
    if (!best || (row.magnitud || -Infinity) > (best.magnitud || -Infinity)) {
      return row;
    }
    return best;
  }, null);
  const depthValues = rows.map((row) => row.prof).filter((value) => Number.isFinite(value));
  const avgDepth = depthValues.length
    ? depthValues.reduce((sum, value) => sum + value, 0) / depthValues.length
    : null;

  elements["kpi-filtered"].textContent = formatNumber(rows.length);
  elements["kpi-filtered-note"].textContent = `${formatPercent(rows.length, state.allRows.length)} of published records`;
  elements["kpi-strongest"].textContent = maxMagnitudeRow ? `M ${maxMagnitudeRow.magnitud.toFixed(1)}` : "No events";
  elements["kpi-strongest-note"].textContent = maxMagnitudeRow
    ? `${maxMagnitudeRow.departamento || "Unknown"} · ${maxMagnitudeRow.event_date_et}`
    : "No magnitude available";
  elements["kpi-depth"].textContent = avgDepth === null ? "No data" : `${avgDepth.toFixed(1)} km`;
  elements["kpi-depth-note"].textContent = depthValues.length ? "Average depth in current slice" : "No depth records available";
  elements["kpi-latest"].textContent = latest ? formatEventMoment(latest) : "No events";
  elements["kpi-latest-note"].textContent = latest ? (latest.referencia || latest.departamento || "Latest published event") : "Adjust filters to see events";
}

function renderMap() {
  if (!state.map || !state.markerLayer) {
    return;
  }

  state.markerLayer.clearLayers();

  const mappableRows = state.filteredRows.filter(
    (row) => Number.isFinite(row.lat) && Number.isFinite(row.lon)
  );

  if (!mappableRows.length) {
    elements["map-note"].textContent = "No geocoded events match the current filter.";
    state.map.setView(PERU_VIEW.center, PERU_VIEW.zoom);
    return;
  }

  const displayRows = mappableRows.slice(0, MAP_LIMIT);
  const bounds = [];

  displayRows.forEach((row) => {
    const marker = L.circleMarker([row.lat, row.lon], {
      renderer: state.renderer,
      radius: markerRadius(row.magnitud),
      weight: 0.8,
      color: "#16303d",
      fillColor: magnitudeColor(row.magnitud),
      fillOpacity: 0.78,
    });

    marker.bindPopup(buildPopupMarkup(row), { maxWidth: 320 });
    marker.addTo(state.markerLayer);
    bounds.push([row.lat, row.lon]);
  });

  if (bounds.length > 1) {
    state.map.fitBounds(bounds, { padding: [24, 24] });
  } else {
    state.map.setView(bounds[0], 7);
  }

  elements["map-note"].textContent =
    displayRows.length < mappableRows.length
      ? `Showing the most recent ${formatNumber(displayRows.length)} mapped events out of ${formatNumber(mappableRows.length)} filtered events.`
      : `${formatNumber(mappableRows.length)} mapped events match the current filter.`;
}

function renderTrend(startDate, endDate) {
  const rows = state.filteredRows;
  const container = elements["trend-chart"];
  container.innerHTML = "";

  if (!rows.length || !startDate || !endDate) {
    elements["trend-grain"].textContent = "No events";
    container.innerHTML = '<div class="muted-text">No events in the selected period.</div>';
    return;
  }

  const spanDays = diffDaysInclusive(startDate, endDate);
  const grain = spanDays <= 92 ? "day" : spanDays <= 730 ? "month" : "year";
  const buckets = buildTimeBuckets(rows, startDate, endDate, grain);
  const maxCount = Math.max(...buckets.map((bucket) => bucket.count), 1);
  const labelStep = Math.max(1, Math.ceil(buckets.length / 8));

  buckets.forEach((bucket, index) => {
    const column = document.createElement("div");
    column.className = "bar-column";
    column.title = `${bucket.label}: ${formatNumber(bucket.count)} event${bucket.count === 1 ? "" : "s"}`;
    column.dataset.label = index % labelStep === 0 ? bucket.shortLabel : "";

    const fill = document.createElement("span");
    fill.className = "bar-fill";
    fill.style.setProperty("--size", String(bucket.count / maxCount));

    column.appendChild(fill);
    container.appendChild(column);
  });

  elements["trend-grain"].textContent = `Grouped by ${grain}`;
}

function renderMagnitudeMix() {
  const rows = state.filteredRows;
  const container = elements["magnitude-chart"];
  container.innerHTML = "";

  if (!rows.length) {
    container.innerHTML = '<div class="muted-text">No magnitude records in this slice.</div>';
    return;
  }

  const counts = MAG_BUCKETS.map((bucket) => ({
    label: bucket.label,
    count: rows.filter(
      (row) => Number.isFinite(row.magnitud) && row.magnitud >= bucket.min && row.magnitud <= bucket.max
    ).length,
  }));
  const maxCount = Math.max(...counts.map((item) => item.count), 1);

  counts.forEach((item) => {
    const row = document.createElement("div");
    row.className = "stack-row";
    row.innerHTML = `
      <div class="stack-meta">
        <span>${item.label}</span>
        <strong>${formatNumber(item.count)}</strong>
      </div>
      <div class="stack-track"><span style="--size:${item.count / maxCount}"></span></div>
    `;
    container.appendChild(row);
  });
}

function renderDepartments() {
  const container = elements["department-list"];
  container.innerHTML = "";
  const counts = new Map();

  state.filteredRows.forEach((row) => {
    const department = row.departamento || "Unknown";
    counts.set(department, (counts.get(department) || 0) + 1);
  });

  const ranked = Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, 8);

  if (!ranked.length) {
    container.innerHTML = '<div class="muted-text">No department labels in this slice.</div>';
    return;
  }

  const maxCount = ranked[0][1] || 1;
  ranked.forEach(([department, count]) => {
    const row = document.createElement("div");
    row.className = "rank-row";
    row.innerHTML = `
      <div class="rank-meta">
        <span>${department}</span>
        <strong>${formatNumber(count)}</strong>
      </div>
      <div class="rank-track"><span style="--size:${count / maxCount}"></span></div>
    `;
    container.appendChild(row);
  });
}

function renderRecentEvents() {
  const tbody = elements["recent-events-body"];
  tbody.innerHTML = "";

  if (!state.filteredRows.length) {
    tbody.innerHTML = '<tr><td colspan="6">No events match the current filter.</td></tr>';
    elements["table-count"].textContent = "0 rows";
    return;
  }

  const rows = state.filteredRows.slice(0, TABLE_LIMIT);
  rows.forEach((row) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><span class="code-pill">${escapeHtml(row.code || "Unknown")}</span></td>
      <td>${escapeHtml(row.event_date_et)}<br /><span class="muted-text">${escapeHtml(row.event_time_et || "--")} ET</span></td>
      <td>${Number.isFinite(row.magnitud) ? `M ${row.magnitud.toFixed(1)}` : "--"}</td>
      <td>${Number.isFinite(row.prof) ? `${row.prof} km` : "--"}</td>
      <td>${escapeHtml(row.departamento || "--")}</td>
      <td>${escapeHtml(row.referencia || "--")}</td>
    `;
    tbody.appendChild(tr);
  });

  elements["table-count"].textContent = `Showing ${rows.length} most recent events`;
}

function updateFilterSummary(startDate, endDate, department, minMagnitude) {
  const scope = department ? `Department: ${department}` : "All departments";
  elements["filter-summary"].textContent =
    `${startDate || "--"} to ${endDate || "--"} · ${scope} · M ${minMagnitude.toFixed(1)}+`;
}

function updateMinMagnitudeLabel() {
  const value = parseNumber(elements["min-magnitude"].value) || 0;
  elements["min-mag-value"].textContent = value.toFixed(1);
}

function syncQuickRangeButtons() {
  elements.quickRangeButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.range === state.activeRange);
  });
}

function downloadFilteredCsv() {
  if (!state.filteredRows.length) {
    showError("There are no filtered rows to download.");
    return;
  }

  const csv = Papa.unparse(
    state.filteredRows.map((row) => ({
      objectid: row.objectid,
      code: row.code,
      event_ts_et: row.event_ts_et,
      event_date_et: row.event_date_et,
      event_time_et: row.event_time_et,
      event_ts_utc: row.event_ts_utc,
      lat: row.lat,
      lon: row.lon,
      magnitud: row.magnitud,
      prof: row.prof,
      profundidad: row.profundidad,
      intensidad: row.intensidad,
      departamento: row.departamento,
      referencia: row.referencia,
      ultimo: row.ultimo,
      reporte: row.reporte,
      ingested_at_utc: row.ingested_at_utc,
    }))
  );

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "peru_seismic_filtered.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function buildPopupMarkup(row) {
  return `
    <div class="map-popup">
      <strong>${escapeHtml(row.code || "Unknown event")}</strong>
      <div>${escapeHtml(row.referencia || row.departamento || "No reference available")}</div>
      <div class="meta-line">${escapeHtml(row.event_date_et)} ${escapeHtml(row.event_time_et || "--")} ET</div>
      <div class="meta-line">Magnitude ${Number.isFinite(row.magnitud) ? row.magnitud.toFixed(1) : "--"} · Depth ${Number.isFinite(row.prof) ? `${row.prof} km` : "--"}</div>
    </div>
  `;
}

function buildTimeBuckets(rows, startDate, endDate, grain) {
  if (grain === "day") {
    const counts = new Map(rows.map((row) => [row.event_date_et, 0]));
    rows.forEach((row) => {
      counts.set(row.event_date_et, (counts.get(row.event_date_et) || 0) + 1);
    });

    const output = [];
    let cursor = startDate;
    while (cursor <= endDate) {
      output.push({
        label: cursor,
        shortLabel: cursor.slice(5),
        count: counts.get(cursor) || 0,
      });
      cursor = shiftIsoDate(cursor, 1);
    }
    return output;
  }

  if (grain === "month") {
    const counts = new Map();
    rows.forEach((row) => {
      const key = row.event_date_et.slice(0, 7);
      counts.set(key, (counts.get(key) || 0) + 1);
    });

    const output = [];
    let cursor = `${startDate.slice(0, 7)}-01`;
    const endCursor = `${endDate.slice(0, 7)}-01`;
    while (cursor <= endCursor) {
      const key = cursor.slice(0, 7);
      output.push({
        label: key,
        shortLabel: key.slice(2),
        count: counts.get(key) || 0,
      });
      cursor = shiftMonth(cursor, 1);
    }
    return output;
  }

  const counts = new Map();
  rows.forEach((row) => {
    const key = row.event_date_et.slice(0, 4);
    counts.set(key, (counts.get(key) || 0) + 1);
  });

  const output = [];
  let cursorYear = Number(startDate.slice(0, 4));
  const endYear = Number(endDate.slice(0, 4));
  while (cursorYear <= endYear) {
    const key = String(cursorYear);
    output.push({
      label: key,
      shortLabel: key,
      count: counts.get(key) || 0,
    });
    cursorYear += 1;
  }
  return output;
}

function parseNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function shiftIsoDate(isoDate, deltaDays) {
  const [year, month, day] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  return dt.toISOString().slice(0, 10);
}

function shiftMonth(isoDate, deltaMonths) {
  const [year, month] = isoDate.slice(0, 7).split("-").map(Number);
  const dt = new Date(Date.UTC(year, month - 1, 1));
  dt.setUTCMonth(dt.getUTCMonth() + deltaMonths);
  return dt.toISOString().slice(0, 10);
}

function diffDaysInclusive(startDate, endDate) {
  const start = Date.parse(`${startDate}T00:00:00Z`);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  return Math.max(1, Math.round((end - start) / 86400000) + 1);
}

function magnitudeColor(magnitude) {
  if (!Number.isFinite(magnitude)) {
    return "#7c8b95";
  }
  if (magnitude >= 6) {
    return "#9c2a1a";
  }
  if (magnitude >= 5) {
    return "#c95c1b";
  }
  if (magnitude >= 4) {
    return "#df9d27";
  }
  if (magnitude >= 3) {
    return "#2d9680";
  }
  return "#7ca7a0";
}

function markerRadius(magnitude) {
  if (!Number.isFinite(magnitude)) {
    return 4;
  }
  return Math.max(4, Math.min(16, 2.5 + magnitude * 2));
}

function formatEventMoment(row) {
  if (!row) {
    return "No events";
  }
  return `${row.event_date_et} ${row.event_time_et || "--"}`;
}

function formatMetaTimestamp(value) {
  if (!value) {
    return "Timestamp unavailable";
  }
  return value.replace("T", " ").replace(/([+-]\d{2}:\d{2}|Z)$/, " ET");
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value || 0);
}

function formatPercent(part, whole) {
  if (!whole) {
    return "0%";
  }
  return `${((part / whole) * 100).toFixed(1)}%`;
}

function withCacheBust(url) {
  const stamp = state.meta?.generated_at_utc || Date.now();
  return `${url}?v=${encodeURIComponent(stamp)}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function showError(message) {
  elements["error-banner"].hidden = false;
  elements["error-banner"].textContent = message;
}

function clearError() {
  elements["error-banner"].hidden = true;
  elements["error-banner"].textContent = "";
}
