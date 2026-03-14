const DATA_URL = "./data/earthquakes_live_curated.csv";
const META_URL = "./data/dashboard_meta.json";
const PERU_VIEW = {
  center: [-9.19, -75.02],
  zoom: 5,
};
const MAP_LIMIT = 2500;
const SCATTER_LIMIT = 1800;
const TABLE_LIMIT = 12;
const MAG_BANDS = [
  { label: "Very Light", maxExclusive: 3.0, color: "#1f9d72", rag: "Green" },
  { label: "Minor", maxExclusive: 4.0, color: "#55b97f", rag: "Green" },
  { label: "Light", maxExclusive: 5.0, color: "#a8c75a", rag: "Green" },
  { label: "Moderate", maxExclusive: 6.0, color: "#f2b535", rag: "Amber" },
  { label: "Strong", maxExclusive: 7.0, color: "#f47a20", rag: "Amber" },
  { label: "Major", maxExclusive: 8.0, color: "#eb4b3c", rag: "Red" },
  { label: "Big", maxExclusive: 9.0, color: "#b91c1c", rag: "Red" },
  { label: "Extreme", maxExclusive: Infinity, color: "#7f1d1d", rag: "Red" },
];
const BUBBLE_COLORS = [
  "#9ec8e7",
  "#8a7f7b",
  "#ffbe78",
  "#67b95f",
  "#c8aa37",
  "#dca5cc",
  "#7bc7c6",
  "#5d84ba",
  "#ef8d2f",
  "#b16db3",
  "#d7d2ce",
  "#49a2a8",
];
const DEPARTMENT_GRID_SIZE = 1;

const state = {
  allRows: [],
  scopedRows: [],
  filteredRows: [],
  meta: null,
  map: null,
  markerLayer: null,
  renderer: null,
  activeRange: "ytd",
  tooltip: null,
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
    "summary-year-count",
    "summary-year-count-note",
    "summary-year-max",
    "summary-year-max-note",
    "summary-year-depth",
    "summary-year-depth-note",
    "summary-today-count",
    "summary-today-count-note",
    "summary-today-max",
    "summary-today-max-note",
    "band-chart",
    "band-note",
    "occurrence-chart",
    "occurrence-note",
    "rolling-chart",
    "rolling-note",
    "month-chart",
    "month-note",
    "year-chart",
    "year-note",
    "scatter-chart",
    "scatter-note",
    "scatter-legend",
    "depth-heatmap-chart",
    "depth-heatmap-note",
    "bubble-chart",
    "bubble-note",
    "map-note",
    "table-count",
    "recent-events-body",
    "error-banner",
    "chart-tooltip",
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
      state.activeRange = button.dataset.range || "ytd";
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
    state.activeRange = "ytd";
    syncQuickRangeButtons();
    elements["department-select"].value = "";
    elements["min-magnitude"].value = "0";
    updateMinMagnitudeLabel();
    applyQuickRange();
    applyFilters();
  });

  elements["min-magnitude"].addEventListener("input", updateMinMagnitudeLabel);
  elements["download-filtered"].addEventListener("click", downloadFilteredCsv);
}

async function loadDashboard() {
  const [rows, meta] = await Promise.all([loadCsvRows(), loadMeta()]);
  state.allRows = enrichMissingDepartments(rows);
  state.meta = meta;

  if (!state.allRows.length) {
    showError("The published website data file is empty.");
    return;
  }

  hydrateMeta();
  populateFilterOptions();
  updateMinMagnitudeLabel();
  syncQuickRangeButtons();
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

  if (!Number.isFinite(eventMs) || !eventDateEt) {
    return null;
  }

  const magnitud = parseNumber(raw.magnitud);
  const prof = parseNumber(raw.prof);
  const band = magnitudeBand(magnitud);
  const departmentKey = canonicalDepartment(raw.departamento) || inferDepartmentFromReference(raw.referencia);

  return {
    objectid: Number(raw.objectid),
    code: String(raw.code || "").trim(),
    event_ts_et: eventTsEt,
    event_date_et: eventDateEt,
    event_time_et: eventTimeEt,
    event_ts_utc: eventTsUtc,
    lat: parseNumber(raw.lat),
    lon: parseNumber(raw.lon),
    magnitud,
    prof,
    profundidad: String(raw.profundidad || "").trim(),
    intensidad: String(raw.intensidad || "").trim(),
    departamento: formatDepartmentLabel(departmentKey),
    departamento_key: departmentKey,
    referencia: String(raw.referencia || "").trim(),
    ultimo: Number(raw.ultimo || 0),
    reporte: Number(raw.reporte || 0),
    ingested_at_utc: String(raw.ingested_at_utc || "").trim(),
    magnitudeBand: band.label,
    ragRating: band.rag,
    bandColor: band.color,
    eventMs,
  };
}

function hydrateMeta() {
  const minDate = state.meta?.min_event_date_et || state.allRows.at(-1)?.event_date_et || "";
  const maxDate = state.meta?.max_event_date_et || state.allRows[0]?.event_date_et || "";
  const generatedAt = state.meta?.generated_at_et || state.allRows[0]?.event_ts_et;

  elements["generated-at"].textContent = formatMetaTimestamp(generatedAt);
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
    state.meta?.departments?.map(canonicalDepartment).map(formatDepartmentLabel).filter(Boolean) ||
    Array.from(new Set(state.allRows.map((row) => row.departamento).filter(Boolean)));

  const unique = Array.from(new Set(departments)).sort((left, right) => left.localeCompare(right));
  const select = elements["department-select"];
  select.innerHTML = '<option value="">All departments</option>';

  unique.forEach((department) => {
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
    const days = Number(state.activeRange || 30);
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

  state.scopedRows = state.allRows.filter((row) => {
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

  state.filteredRows = state.scopedRows.filter((row) => {
    if (startDate && row.event_date_et < startDate) {
      return false;
    }
    if (endDate && row.event_date_et > endDate) {
      return false;
    }
    return true;
  });

  updateFilterSummary(startDate, endDate, department, minMagnitude);
  renderSummaryCards(state.scopedRows);
  renderMagnitudeBands(state.filteredRows);
  renderOccurrenceSeries(state.filteredRows, startDate, endDate);
  renderMonthYearSeries(state.scopedRows);
  renderScatterPlot(state.filteredRows);
  renderBubbleChart(state.filteredRows, startDate, endDate);
  renderMap();
  renderRecentEvents();
}

function renderSummaryCards(rows) {
  const todayEt = currentEtDate();
  const currentYear = todayEt.slice(0, 4);
  const yearRows = rows.filter((row) => row.event_date_et.startsWith(`${currentYear}-`));
  const todayRows = rows.filter((row) => row.event_date_et === todayEt);
  const yearMax = strongestRow(yearRows);
  const todayMax = strongestRow(todayRows);
  const avgYearDepth = average(rows.filter((row) => row.event_date_et.startsWith(`${currentYear}-`)).map((row) => row.prof));

  elements["summary-year-count"].textContent = formatNumber(yearRows.length);
  elements["summary-year-count-note"].textContent = `${currentYear} events in current scope`;
  elements["summary-year-max"].textContent = yearMax ? `M ${yearMax.magnitud.toFixed(1)}` : "No events";
  elements["summary-year-max-note"].textContent = yearMax ? `${yearMax.departamento || "Unknown"} · ${formatTemporalLabel(yearMax.event_date_et)}` : `No ${currentYear} event in scope`;
  elements["summary-year-depth"].textContent = avgYearDepth === null ? "No data" : `${avgYearDepth.toFixed(1)} km`;
  elements["summary-year-depth-note"].textContent = avgYearDepth === null ? "No depth records this year" : `Average depth for ${currentYear}`;
  elements["summary-today-count"].textContent = formatNumber(todayRows.length);
  elements["summary-today-count-note"].textContent = `Date: ${formatTemporalLabel(todayEt)}`;
  elements["summary-today-max"].textContent = todayMax ? `M ${todayMax.magnitud.toFixed(1)}` : "No events";
  elements["summary-today-max-note"].textContent = todayMax ? `${todayMax.departamento || "Unknown"} · ${todayMax.event_time_et} ET` : `No events on ${formatTemporalLabel(todayEt)}`;
}

function renderMagnitudeBands(rows) {
  const container = elements["band-chart"];
  container.innerHTML = "";

  if (!rows.length) {
    container.innerHTML = '<div class="chart-empty">No events match the selected date range.</div>';
    elements["band-note"].textContent = "No band distribution available.";
    return;
  }

  const maxCount = Math.max(
    ...MAG_BANDS.map((band) => rows.filter((row) => row.magnitudeBand === band.label).length),
    1
  );

  MAG_BANDS.forEach((band) => {
    const count = rows.filter((row) => row.magnitudeBand === band.label).length;
    const percent = rows.length ? (count / rows.length) * 100 : 0;
    const row = document.createElement("div");
    row.className = "band-row";
    row.innerHTML = `
      <div class="band-meta-line">
        <div class="band-name-wrap">
          <span class="band-swatch" style="background:${band.color}"></span>
          <span class="band-name">${band.label}</span>
          <span class="rag-chip">${band.rag}</span>
        </div>
        <strong>${formatNumber(count)}</strong>
      </div>
      <div class="band-track"><span style="--size:${count / maxCount}; --fill:${band.color}"></span></div>
      <div class="band-foot">${percent.toFixed(1)}% of filtered events</div>
    `;
    container.appendChild(row);
  });

  elements["band-note"].textContent = `${formatNumber(rows.length)} events in the filtered slice`;
}

function renderOccurrenceSeries(rows, startDate, endDate) {
  const buckets = buildDailyBuckets(rows, startDate, endDate);
  const rollingBuckets = buildRollingAverageSeries(buckets, 7);
  drawLineChart(elements["occurrence-chart"], buckets, {
    color: "#0d7a6b",
    fill: "rgba(13, 122, 107, 0.18)",
    maxXTicks: 8,
    yLabel: "Occurrences",
    tooltipFormatter: (point) => tooltipMarkup(
      formatTemporalLabel(point.label),
      `${formatNumber(point.value)} earthquake${point.value === 1 ? "" : "s"}`
    ),
  });
  drawLineChart(elements["rolling-chart"], rollingBuckets, {
    color: "#1d5f92",
    fill: "rgba(93, 132, 186, 0.16)",
    maxXTicks: 8,
    yLabel: "7-day avg",
    yTickFormatter: (value) => value.toFixed(1),
    tooltipFormatter: (point) => tooltipMarkup(
      formatTemporalLabel(point.label),
      `${point.value.toFixed(2)} average earthquakes per day over the trailing 7 days`
    ),
  });
  elements["occurrence-note"].textContent = `${formatNumber(rows.length)} events from ${formatTemporalLabel(startDate)} to ${formatTemporalLabel(endDate)}`;
  elements["rolling-note"].textContent = rollingBuckets.length ? "Smooths short spikes so the trend is easier to read" : "No rolling trend";
}

function renderMonthYearSeries(rows) {
  const monthBuckets = buildRollingMonthBuckets(rows, 24);
  const yearBuckets = buildYearBuckets(rows);

  drawLineChart(elements["month-chart"], monthBuckets, {
    color: "#b8812d",
    fill: "rgba(184, 129, 45, 0.14)",
    maxXTicks: 7,
    yLabel: "Monthly events",
    tooltipFormatter: (point) => tooltipMarkup(
      formatTemporalLabel(point.label),
      `${formatNumber(point.value)} earthquake${point.value === 1 ? "" : "s"}`
    ),
  });
  drawLineChart(elements["year-chart"], yearBuckets, {
    color: "#204d5e",
    fill: "rgba(32, 77, 94, 0.14)",
    maxXTicks: 8,
    yLabel: "Yearly events",
    tooltipFormatter: (point) => tooltipMarkup(
      formatTemporalLabel(point.label),
      `${formatNumber(point.value)} earthquake${point.value === 1 ? "" : "s"}`
    ),
  });

  elements["month-note"].textContent = monthBuckets.length ? "Last 24 months in current department and magnitude scope" : "No monthly history";
  elements["year-note"].textContent = yearBuckets.length ? "Full available yearly history in current department and magnitude scope" : "No yearly history";
}

function renderScatterPlot(rows) {
  const svg = elements["scatter-chart"];
  const heatmapSvg = elements["depth-heatmap-chart"];
  const legend = elements["scatter-legend"];
  legend.innerHTML = "";

  const magnitudeRows = rows.filter((row) => Number.isFinite(row.magnitud));
  const validRows = magnitudeRows.filter((row) => Number.isFinite(row.prof));
  if (!magnitudeRows.length) {
    clearSvg(svg);
    clearSvg(heatmapSvg);
    svg.appendChild(emptyText(svg, "No magnitude/depth pairs in the filtered slice."));
    heatmapSvg.appendChild(emptyText(heatmapSvg, "No depth-band pattern data in the filtered slice."));
    elements["scatter-note"].textContent = "No scatterplot data.";
    elements["depth-heatmap-note"].textContent = "No heatmap data.";
    return;
  }

  const sampledRows = validRows.length ? sampleRows(validRows, SCATTER_LIMIT) : [];
  const depthMax = sampledRows.length ? Math.max(10, niceCeiling(percentile(sampledRows.map((row) => row.prof), 0.98), 10)) : 10;
  const magMax = Math.max(4, niceCeiling(Math.max(...magnitudeRows.map((row) => row.magnitud)), 1));
  const heatmap = buildDepthMagnitudeHeatmap(validRows);
  renderScatterLegend(legend, magnitudeRows);
  if (sampledRows.length) {
    drawScatterPlot(svg, sampledRows, {
      xMax: depthMax,
      yMax: magMax,
      xLabel: "Depth (km)",
      yLabel: "Magnitude",
    });
  } else {
    clearSvg(svg);
    svg.appendChild(emptyText(svg, "No magnitude/depth pairs in the filtered slice."));
  }
  drawDepthHeatmap(heatmapSvg, heatmap);
  elements["scatter-note"].textContent = sampledRows.length
    ? `${formatNumber(sampledRows.length)} sampled points colored by magnitude band and RAG category`
    : "No depth values are available in the current filtered slice";
  elements["depth-heatmap-note"].textContent = heatmap.topCell
    ? `Peak cell: ${heatmap.topCell.magnitudeLabel} · ${heatmap.topCell.depthLabel} · ${(heatmap.topCell.rowShare * 100).toFixed(1)}%`
    : "No depth-band pattern data";
}

function renderScatterLegend(container, rows) {
  const seen = new Set(rows.map((row) => row.magnitudeBand));
  MAG_BANDS.filter((band) => seen.has(band.label)).forEach((band) => {
    const item = document.createElement("div");
    item.className = "legend-item";
    item.innerHTML = `
      <span class="legend-swatch" style="background:${band.color}"></span>
      <span>${band.label}</span>
      <span class="legend-rag">${band.rag}</span>
    `;
    container.appendChild(item);
  });
}

function renderBubbleChart(rows, startDate, endDate) {
  const svg = elements["bubble-chart"];
  const counts = new Map();
  rows.forEach((row) => {
    const department = row.departamento || "Unknown";
    counts.set(department, (counts.get(department) || 0) + 1);
  });

  const ranked = Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1])
    .slice(0, 12)
    .map(([label, count], index) => ({
      label,
      count,
      color: BUBBLE_COLORS[index % BUBBLE_COLORS.length],
    }));

  if (!ranked.length) {
    clearSvg(svg);
    svg.appendChild(emptyText(svg, "No department distribution available."));
    elements["bubble-note"].textContent = `No departamentos match ${formatTemporalLabel(startDate)} to ${formatTemporalLabel(endDate)}.`;
    return;
  }

  const width = 700;
  const height = 430;
  const maxCount = ranked[0].count || 1;
  const items = ranked.map((item) => ({
    ...item,
    radius: 28 + Math.sqrt(item.count / maxCount) * 84,
  }));
  const bubbles = layoutBubbles(items, width, height);
  drawBubbleChart(svg, bubbles, maxCount);
  elements["bubble-note"].textContent = `Top ${ranked.length} departamentos from ${formatNumber(rows.length)} filtered events, ${formatTemporalLabel(startDate)} to ${formatTemporalLabel(endDate)}`;
}

function renderMap() {
  if (!state.map || !state.markerLayer) {
    return;
  }

  state.markerLayer.clearLayers();
  const mappableRows = state.filteredRows.filter((row) => Number.isFinite(row.lat) && Number.isFinite(row.lon));

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
      color: "#17313e",
      fillColor: row.bandColor,
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

function renderRecentEvents() {
  const tbody = elements["recent-events-body"];
  tbody.innerHTML = "";

  if (!state.filteredRows.length) {
    tbody.innerHTML = '<tr><td colspan="7">No events match the current filter.</td></tr>';
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
      <td><span class="band-inline"><span class="band-inline-dot" style="background:${row.bandColor}"></span>${escapeHtml(row.magnitudeBand)}</span></td>
      <td>${escapeHtml(row.departamento || "--")}</td>
      <td>${escapeHtml(row.referencia || "--")}</td>
    `;
    tbody.appendChild(tr);
  });

  elements["table-count"].textContent = `Showing ${rows.length} most recent events`;
}

function updateFilterSummary(startDate, endDate, department, minMagnitude) {
  const scope = department ? `Department: ${department}` : "All departments";
  elements["filter-summary"].textContent = `${formatTemporalLabel(startDate)} to ${formatTemporalLabel(endDate)} · ${scope} · M ${minMagnitude.toFixed(1)}+`;
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
      magnitude_band: row.magnitudeBand,
      rag_rating: row.ragRating,
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

function magnitudeBand(magnitude) {
  if (!Number.isFinite(magnitude)) {
    return { label: "Unknown", color: "#7c8b95", rag: "Unknown" };
  }

  for (const band of MAG_BANDS) {
    if (magnitude < band.maxExclusive) {
      return band;
    }
  }
  return MAG_BANDS[MAG_BANDS.length - 1];
}

function buildPopupMarkup(row) {
  return `
    <div class="map-popup">
      <strong>${escapeHtml(row.code || "Unknown event")}</strong>
      <div>${escapeHtml(row.referencia || row.departamento || "No reference available")}</div>
      <div class="meta-line">${escapeHtml(row.event_date_et)} ${escapeHtml(row.event_time_et || "--")} ET</div>
      <div class="meta-line">${escapeHtml(row.magnitudeBand)} · ${escapeHtml(row.ragRating)} · Depth ${Number.isFinite(row.prof) ? `${row.prof} km` : "--"}</div>
    </div>
  `;
}

function buildDailyBuckets(rows, startDate, endDate) {
  const counts = new Map();
  rows.forEach((row) => {
    counts.set(row.event_date_et, (counts.get(row.event_date_et) || 0) + 1);
  });

  const output = [];
  let cursor = startDate;
  while (cursor <= endDate) {
    output.push({
      label: cursor,
      shortLabel: shortDateLabel(cursor),
      value: counts.get(cursor) || 0,
    });
    cursor = shiftIsoDate(cursor, 1);
  }
  return output;
}

function buildRollingMonthBuckets(rows, monthWindow) {
  if (!rows.length) {
    return [];
  }

  const counts = new Map();
  rows.forEach((row) => {
    const key = row.event_date_et.slice(0, 7);
    counts.set(key, (counts.get(key) || 0) + 1);
  });

  const maxMonth = rows[0].event_date_et.slice(0, 7);
  let cursor = `${maxMonth}-01`;
  for (let step = 1; step < monthWindow; step += 1) {
    cursor = shiftMonth(cursor, -1);
  }

  const output = [];
  for (let step = 0; step < monthWindow; step += 1) {
    const key = cursor.slice(0, 7);
    output.push({
      label: key,
      shortLabel: shortMonthLabel(key),
      value: counts.get(key) || 0,
    });
    cursor = shiftMonth(cursor, 1);
  }
  return output;
}

function buildRollingAverageSeries(series, windowSize) {
  if (!series.length) {
    return [];
  }
  return series.map((point, index) => {
    const start = Math.max(0, index - windowSize + 1);
    const window = series.slice(start, index + 1);
    const average = window.reduce((sum, item) => sum + item.value, 0) / window.length;
    return {
      ...point,
      value: average,
    };
  });
}

function buildDepthMagnitudeHeatmap(rows) {
  const depthBins = [
    { label: "0-30 km", min: 0, max: 30 },
    { label: "30-70 km", min: 30, max: 70 },
    { label: "70-150 km", min: 70, max: 150 },
    { label: "150-300 km", min: 150, max: 300 },
    { label: "300+ km", min: 300, max: Infinity },
  ];
  const magnitudeBins = MAG_BANDS.map((band) => ({
    label: band.label,
    min: band === MAG_BANDS[0] ? 0 : 0,
    maxExclusive: band.maxExclusive,
    color: band.color,
  }));

  const cells = depthBins.map((depthBin) =>
    magnitudeBins.map((magnitudeBin) => ({
      depthLabel: depthBin.label,
      magnitudeLabel: magnitudeBin.label,
      magnitudeColor: magnitudeBin.color,
      count: 0,
    }))
  );

  rows.forEach((row) => {
    const depthIndex = depthBins.findIndex((bin) => row.prof >= bin.min && row.prof < bin.max);
    const magnitudeIndex = MAG_BANDS.findIndex((band) => row.magnitud < band.maxExclusive);
    if (depthIndex === -1 || magnitudeIndex === -1) {
      return;
    }
    cells[depthIndex][magnitudeIndex].count += 1;
  });

  const totalCount = rows.length;
  cells.forEach((row) => {
    const rowTotal = row.reduce((sum, cell) => sum + cell.count, 0);
    row.forEach((cell) => {
      cell.rowTotal = rowTotal;
      cell.rowShare = rowTotal ? cell.count / rowTotal : 0;
      cell.totalShare = totalCount ? cell.count / totalCount : 0;
      cell.isRiskBand = ["Moderate", "Strong", "Major", "Big", "Extreme"].includes(cell.magnitudeLabel);
    });
  });

  const flat = cells.flat();
  const maxRowShare = Math.max(...flat.map((cell) => cell.rowShare), 0);
  const topCell = flat.filter((cell) => cell.count > 0).sort((left, right) => right.rowShare - left.rowShare || right.count - left.count)[0] || null;

  return {
    depthBins,
    magnitudeBins,
    cells,
    totalCount,
    maxRowShare,
    topCell,
  };
}

function buildYearBuckets(rows) {
  if (!rows.length) {
    return [];
  }

  const counts = new Map();
  rows.forEach((row) => {
    const key = row.event_date_et.slice(0, 4);
    counts.set(key, (counts.get(key) || 0) + 1);
  });

  const minYear = Number(rows.at(-1).event_date_et.slice(0, 4));
  const maxYear = Number(rows[0].event_date_et.slice(0, 4));
  const output = [];
  for (let year = minYear; year <= maxYear; year += 1) {
    const key = String(year);
    output.push({
      label: key,
      shortLabel: key,
      value: counts.get(key) || 0,
    });
  }
  return output;
}

function drawLineChart(svg, series, options) {
  clearSvg(svg);
  if (!series.length) {
    svg.appendChild(emptyText(svg, "No series data available."));
    return;
  }

  const width = 700;
  const height = Number(svg.getAttribute("viewBox").split(" ")[3] || 320);
  const pad = { top: 20, right: 28, bottom: 44, left: 48 };
  const innerWidth = width - pad.left - pad.right;
  const innerHeight = height - pad.top - pad.bottom;
  const maxValue = Math.max(...series.map((point) => point.value), 1);
  const xStep = series.length > 1 ? innerWidth / (series.length - 1) : innerWidth / 2;
  const yScale = (value) => pad.top + innerHeight - (value / maxValue) * innerHeight;
  const xScale = (index) => pad.left + (series.length === 1 ? innerWidth / 2 : index * xStep);
  const tickIndices = buildTickIndices(series.length, options.maxXTicks || 8);

  for (let line = 0; line <= 4; line += 1) {
    const y = pad.top + (innerHeight / 4) * line;
    svg.appendChild(
      svgNode("line", {
        x1: pad.left,
        x2: width - pad.right,
        y1: y,
        y2: y,
        class: "grid-line",
      })
    );

    const value = maxValue - (maxValue / 4) * line;
    svg.appendChild(
      svgNode("text", {
        x: pad.left - 8,
        y: y + 4,
        class: "axis-text",
        "text-anchor": "end",
      }, options.yTickFormatter ? options.yTickFormatter(value) : formatNumber(Math.round(value)))
    );
  }

  const points = series.map((point, index) => `${xScale(index)},${yScale(point.value)}`);
  const areaPath = [
    `M ${pad.left} ${pad.top + innerHeight}`,
    ...series.map((point, index) => `L ${xScale(index)} ${yScale(point.value)}`),
    `L ${xScale(series.length - 1)} ${pad.top + innerHeight}`,
    "Z",
  ].join(" ");

  svg.appendChild(svgNode("path", { d: areaPath, fill: options.fill || "rgba(14,122,108,0.16)", class: "area-shape" }));
  svg.appendChild(svgNode("polyline", {
    points: points.join(" "),
    fill: "none",
    stroke: options.color || "#0d7a6b",
    "stroke-width": 3,
    class: "line-path",
  }));

  series.forEach((point, index) => {
    const cx = xScale(index);
    const cy = yScale(point.value);
    svg.appendChild(svgNode("circle", {
      cx,
      cy,
      r: 3.2,
      fill: options.color || "#0d7a6b",
      class: "line-point",
    }));

    const hitArea = svgNode("circle", {
      cx,
      cy,
      r: 10,
      fill: "transparent",
      class: "chart-hit-area",
    });
    attachTooltip(hitArea, (event) => {
      const formatter = options.tooltipFormatter || ((seriesPoint) => tooltipMarkup(formatTemporalLabel(seriesPoint.label), formatNumber(seriesPoint.value)));
      showTooltip(event, formatter(point));
    });
    svg.appendChild(hitArea);

    if (tickIndices.includes(index)) {
      const anchor = index === 0 ? "start" : index === series.length - 1 ? "end" : "middle";
      svg.appendChild(
        svgNode("text", {
          x: cx,
          y: height - 12,
          class: "axis-text",
          "text-anchor": anchor,
        }, point.shortLabel || point.label)
      );
    }
  });

  svg.appendChild(
    svgNode("text", {
      x: 20,
      y: pad.top + innerHeight / 2,
      class: "axis-title",
      transform: `rotate(-90 20 ${pad.top + innerHeight / 2})`,
      "text-anchor": "middle",
    }, options.yLabel || "")
  );
}

function drawScatterPlot(svg, rows, options) {
  clearSvg(svg);
  const width = 700;
  const height = 360;
  const pad = { top: 20, right: 16, bottom: 48, left: 58 };
  const innerWidth = width - pad.left - pad.right;
  const innerHeight = height - pad.top - pad.bottom;

  const xScale = (value) => pad.left + Math.min(value, options.xMax) / options.xMax * innerWidth;
  const yScale = (value) => pad.top + innerHeight - (value / options.yMax) * innerHeight;

  for (let index = 0; index <= 4; index += 1) {
    const y = pad.top + (innerHeight / 4) * index;
    const value = (options.yMax / 4) * (4 - index);
    svg.appendChild(svgNode("line", {
      x1: pad.left,
      x2: width - pad.right,
      y1: y,
      y2: y,
      class: "grid-line",
    }));
    svg.appendChild(svgNode("text", {
      x: pad.left - 10,
      y: y + 4,
      class: "axis-text",
      "text-anchor": "end",
    }, value.toFixed(1)));
  }

  for (let index = 0; index <= 5; index += 1) {
    const depth = (options.xMax / 5) * index;
    const x = pad.left + (innerWidth / 5) * index;
    svg.appendChild(svgNode("line", {
      x1: x,
      x2: x,
      y1: pad.top,
      y2: height - pad.bottom,
      class: "grid-line",
    }));
    svg.appendChild(svgNode("text", {
      x,
      y: height - 16,
      class: "axis-text",
      "text-anchor": "middle",
    }, `${Math.round(depth)}`));
  }

  rows.forEach((row) => {
    const point = svgNode("circle", {
      cx: xScale(row.prof),
      cy: yScale(row.magnitud),
      r: Math.max(3, Math.min(8, 2 + row.magnitud * 0.7)),
      fill: row.bandColor,
      "fill-opacity": 0.78,
      stroke: "#17313e",
      "stroke-width": 0.6,
      class: "scatter-point",
    });
    attachTooltip(point, (event) => {
      showTooltip(
        event,
        tooltipMarkup(
          `${escapeHtml(row.code || "Earthquake")} · ${escapeHtml(row.magnitudeBand)}`,
          `${Number.isFinite(row.magnitud) ? `Magnitude ${row.magnitud.toFixed(1)}` : "Magnitude unavailable"}<br />${Number.isFinite(row.prof) ? `Depth ${row.prof} km` : "Depth unavailable"}<br />${escapeHtml(formatTemporalLabel(row.event_date_et))} · ${escapeHtml(row.departamento || "Unknown")}`
        )
      );
    });
    svg.appendChild(point);
  });

  svg.appendChild(svgNode("text", {
    x: width / 2,
    y: height - 2,
    class: "axis-title",
    "text-anchor": "middle",
  }, options.xLabel));
  svg.appendChild(svgNode("text", {
    x: 18,
    y: pad.top + innerHeight / 2,
    class: "axis-title",
    transform: `rotate(-90 18 ${pad.top + innerHeight / 2})`,
    "text-anchor": "middle",
  }, options.yLabel));
}

function drawDepthHeatmap(svg, heatmap) {
  clearSvg(svg);
  if (!heatmap.totalCount) {
    svg.appendChild(emptyText(svg, "No depth-band pattern data available."));
    return;
  }

  const width = 700;
  const height = 320;
  const pad = { top: 18, right: 16, bottom: 86, left: 90 };
  const innerWidth = width - pad.left - pad.right;
  const innerHeight = height - pad.top - pad.bottom;
  const colWidth = innerWidth / heatmap.magnitudeBins.length;
  const rowHeight = innerHeight / heatmap.depthBins.length;

  heatmap.depthBins.forEach((depthBin, rowIndex) => {
    const y = pad.top + rowIndex * rowHeight;
    svg.appendChild(svgNode("text", {
      x: pad.left - 12,
      y: y + rowHeight / 2 + 4,
      class: "axis-text",
      "text-anchor": "end",
    }, depthBin.label));
  });

  heatmap.magnitudeBins.forEach((magnitudeBin, colIndex) => {
    const x = pad.left + colIndex * colWidth + colWidth / 2;
    const lines = splitAxisLabel(magnitudeBin.label);
    const label = svgNode("text", {
      x,
      y: pad.top + innerHeight + 20 - (lines.length > 1 ? 6 : 0),
      class: "axis-text heatmap-axis-label",
      "text-anchor": "middle",
    });
    lines.forEach((line, lineIndex) => {
      label.appendChild(svgNode("tspan", {
        x,
        dy: lineIndex === 0 ? 0 : 12,
      }, line));
    });
    svg.appendChild(label);
  });

  heatmap.cells.forEach((row, rowIndex) => {
    row.forEach((cell, colIndex) => {
      const x = pad.left + colIndex * colWidth;
      const y = pad.top + rowIndex * rowHeight;
      const opacity = cell.count > 0 ? 0.1 + (cell.rowShare / heatmap.maxRowShare) * 0.9 : 0.05;
      const rect = svgNode("rect", {
        x: x + 1,
        y: y + 1,
        width: colWidth - 2,
        height: rowHeight - 2,
        rx: 8,
        fill: cell.magnitudeColor,
        "fill-opacity": opacity.toFixed(3),
        stroke: cell.isRiskBand ? "rgba(122, 24, 24, 0.36)" : "rgba(22, 40, 48, 0.08)",
        "stroke-width": cell.isRiskBand ? 1.5 : 1,
      });
      attachTooltip(rect, (event) => {
        showTooltip(
          event,
          tooltipMarkup(
            `${escapeHtml(cell.magnitudeLabel)} · ${escapeHtml(cell.depthLabel)}`,
            `${formatNumber(cell.count)} earthquakes<br />${(cell.rowShare * 100).toFixed(1)}% of this depth band<br />${(cell.totalShare * 100).toFixed(1)}% of filtered events`
          )
        );
      });
      svg.appendChild(rect);

      svg.appendChild(svgNode("text", {
        x: x + colWidth / 2,
        y: y + rowHeight / 2 + 4,
        class: "axis-text",
        "text-anchor": "middle",
      }, cell.count > 0 ? `${Math.round(cell.rowShare * 100)}%` : ""));
    });
  });

  svg.appendChild(svgNode("text", {
    x: width / 2,
    y: height - 12,
    class: "axis-title",
    "text-anchor": "middle",
  }, "Magnitude band"));
  svg.appendChild(svgNode("text", {
    x: 18,
    y: pad.top + innerHeight / 2,
    class: "axis-title",
    transform: `rotate(-90 18 ${pad.top + innerHeight / 2})`,
    "text-anchor": "middle",
  }, "Depth band"));
}

function drawBubbleChart(svg, bubbles, maxCount) {
  clearSvg(svg);
  if (!bubbles.length) {
    svg.appendChild(emptyText(svg, "No bubble data available."));
    return;
  }

  bubbles.forEach((bubble) => {
    const circle = svgNode("circle", {
      cx: bubble.x,
      cy: bubble.y,
      r: bubble.radius,
      fill: bubble.color,
      "fill-opacity": 0.92,
      stroke: "rgba(22, 40, 48, 0.22)",
      "stroke-width": 1.4,
      class: "bubble-node",
    });
    attachTooltip(circle, (event) => {
      const share = maxCount ? ((bubble.count / maxCount) * 100).toFixed(1) : "0.0";
      showTooltip(
        event,
        tooltipMarkup(
          escapeHtml(bubble.label),
          `${formatNumber(bubble.count)} earthquakes in the current filtered slice<br />${share}% of the largest bubble`
        )
      );
    });
    svg.appendChild(circle);

    const label = splitBubbleLabel(bubble.label);
    const fontSize = Math.max(10, Math.min(20, bubble.radius / 3.25));
    const showCount = bubble.radius >= 40;
    const text = svgNode("text", {
      x: bubble.x,
      y: bubble.y - (showCount ? 8 : 4),
      class: "bubble-label",
      "text-anchor": "middle",
      "font-size": fontSize,
    });
    label.forEach((line, lineIndex) => {
      text.appendChild(svgNode("tspan", {
        x: bubble.x,
        dy: lineIndex === 0 ? 0 : fontSize * 1.05,
      }, line));
    });
    if (showCount) {
      text.appendChild(svgNode("tspan", {
        x: bubble.x,
        dy: fontSize * 1.12,
        class: "bubble-count",
      }, formatNumber(bubble.count)));
    }
    svg.appendChild(text);
  });
}

function layoutBubbles(items, width, height) {
  const placed = [];
  const leadX = Math.max(items[0]?.radius + 18 || 0, width * 0.18);
  const leadY = height * 0.53;
  const clusterX = width * 0.58;
  const clusterY = height * 0.53;
  const margin = 14;
  const preferredOffsets = [
    { x: 12, y: -112 },
    { x: 132, y: -48 },
    { x: 234, y: 12 },
    { x: 118, y: 104 },
    { x: -48, y: 62 },
    { x: 216, y: 122 },
    { x: 84, y: 170 },
    { x: -18, y: 156 },
    { x: 300, y: 126 },
    { x: 286, y: 26 },
    { x: 156, y: -138 },
  ];

  items.forEach((item, index) => {
    if (index === 0) {
      placed.push({ ...item, x: leadX, y: leadY });
      return;
    }

    let position = null;
    const preferred = preferredOffsets[index - 1];
    const anchorX = preferred ? clusterX + preferred.x * (width / 700) : clusterX;
    const anchorY = preferred ? clusterY + preferred.y * (height / 430) : clusterY;
    for (let spiral = 0; spiral < 420 && !position; spiral += 1) {
      const angle = spiral * 0.72;
      const distance = spiral === 0 ? 0 : 6 + spiral * 1.9;
      const x = anchorX + Math.cos(angle) * distance * 1.02;
      const y = anchorY + Math.sin(angle) * distance * 0.82;
      if (x - item.radius < margin || x + item.radius > width - margin) {
        continue;
      }
      if (y - item.radius < margin || y + item.radius > height - margin) {
        continue;
      }
      if (!placed.some((other) => distanceBetween(x, y, other.x, other.y) < item.radius + other.radius + 8)) {
        position = { ...item, x, y };
      }
    }

    if (!position) {
      position = {
        ...item,
        x: Math.min(width - item.radius - margin, clusterX + (index % 4) * 74),
        y: Math.min(height - item.radius - margin, margin + item.radius + Math.floor(index / 4) * 78),
      };
    }
    placed.push(position);
  });

  return placed;
}

function currentEtDate() {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value || "0000";
  const month = parts.find((part) => part.type === "month")?.value || "01";
  const day = parts.find((part) => part.type === "day")?.value || "01";
  return `${year}-${month}-${day}`;
}

function currentYearFromRows(rows) {
  return rows.length ? rows[0].event_date_et.slice(0, 4) : currentEtDate().slice(0, 4);
}

function strongestRow(rows) {
  return rows.reduce((best, row) => {
    if (!Number.isFinite(row.magnitud)) {
      return best;
    }
    if (!best || row.magnitud > best.magnitud) {
      return row;
    }
    return best;
  }, null);
}

function sampleRows(rows, limit) {
  if (rows.length <= limit) {
    return rows;
  }
  const output = [];
  const step = rows.length / limit;
  for (let index = 0; index < limit; index += 1) {
    output.push(rows[Math.floor(index * step)]);
  }
  return output;
}

function enrichMissingDepartments(rows) {
  const grid = buildDepartmentGrid(rows);
  return rows.map((row) => {
    if (row.departamento_key) {
      return row;
    }
    const inferredKey = inferDepartmentFromGrid(row.lat, row.lon, grid);
    if (!inferredKey) {
      return row;
    }
    return {
      ...row,
      departamento_key: inferredKey,
      departamento: formatDepartmentLabel(inferredKey),
    };
  });
}

function canonicalDepartment(value) {
  if (value === null || value === undefined) {
    return "";
  }
  let normalized = String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();

  if (!normalized) {
    return "";
  }

  const aliases = {
    "AMAZONA": "AMAZONAS",
    "APURIMAC": "APURIMAC",
    "ATALAYA": "UCAYALI",
    "ATICO": "AREQUIPA",
    "CALLAO REGION": "CALLAO",
    "HUANUCO": "HUANUCO",
    "JUNIN": "JUNIN",
    "LA LIBERTDAD": "LA LIBERTAD",
    "MARCONA": "ICA",
    "PROVINCIA CONSTITUCIONAL DEL CALLAO": "CALLAO",
    "NO DE LA PROVINCIA CONSTITUCIONAL DEL CALLAO": "CALLAO",
    "SAN MARTIN": "SAN MARTIN",
  };

  if (normalized.includes("PROVINCIA CONSTITUCIONAL DEL CALLAO")) {
    normalized = "CALLAO";
  }

  return aliases[normalized] || normalized;
}

function inferDepartmentFromReference(reference) {
  if (!reference) {
    return "";
  }
  const rawReference = String(reference).trim();
  const tail = rawReference.split(/\s-\s|-/).pop();
  const inferred = canonicalDepartment(tail);
  return inferred && inferred.split(" ").length <= 4 ? inferred : "";
}

function buildDepartmentGrid(rows) {
  const grid = new Map();
  rows.forEach((row) => {
    if (!row.departamento_key || !Number.isFinite(row.lat) || !Number.isFinite(row.lon)) {
      return;
    }
    const key = departmentCellKey(row.lat, row.lon);
    if (!grid.has(key)) {
      grid.set(key, new Map());
    }
    const cell = grid.get(key);
    cell.set(row.departamento_key, (cell.get(row.departamento_key) || 0) + 1);
  });
  return grid;
}

function inferDepartmentFromGrid(lat, lon, grid) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !grid.size) {
    return "";
  }

  const latIndex = Math.round(lat / DEPARTMENT_GRID_SIZE);
  const lonIndex = Math.round(lon / DEPARTMENT_GRID_SIZE);

  for (let radius = 0; radius <= 4; radius += 1) {
    const scores = new Map();
    for (let latStep = -radius; latStep <= radius; latStep += 1) {
      for (let lonStep = -radius; lonStep <= radius; lonStep += 1) {
        const cell = grid.get(`${latIndex + latStep}:${lonIndex + lonStep}`);
        if (!cell) {
          continue;
        }
        const weight = 1 / (1 + Math.abs(latStep) + Math.abs(lonStep));
        cell.forEach((count, departmentKey) => {
          scores.set(departmentKey, (scores.get(departmentKey) || 0) + count * weight);
        });
      }
    }

    if (scores.size) {
      return Array.from(scores.entries()).sort((left, right) => right[1] - left[1])[0][0];
    }
  }

  return "";
}

function departmentCellKey(lat, lon) {
  return `${Math.round(lat / DEPARTMENT_GRID_SIZE)}:${Math.round(lon / DEPARTMENT_GRID_SIZE)}`;
}

function formatDepartmentLabel(value) {
  if (!value) {
    return "";
  }
  if (value === "OCEANO") {
    return "Oceano";
  }
  return value
    .toLowerCase()
    .split(" ")
    .map((part) => {
      if (part === "de" || part === "del" || part === "la") {
        return part;
      }
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

function parseNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function average(values) {
  const filtered = values.filter((value) => Number.isFinite(value));
  if (!filtered.length) {
    return null;
  }
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function percentile(values, fraction) {
  const filtered = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (!filtered.length) {
    return 0;
  }
  const index = Math.max(0, Math.min(filtered.length - 1, Math.floor((filtered.length - 1) * fraction)));
  return filtered[index];
}

function niceCeiling(value, step) {
  if (!Number.isFinite(value) || value <= 0) {
    return step;
  }
  return Math.ceil(value / step) * step;
}

function markerRadius(magnitude) {
  if (!Number.isFinite(magnitude)) {
    return 4;
  }
  return Math.max(4, Math.min(16, 2.4 + magnitude * 1.8));
}

function shortDateLabel(isoDate) {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function shortMonthLabel(isoMonth) {
  const [year, month] = isoMonth.split("-").map(Number);
  const label = new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-US", {
    month: "short",
    year: "2-digit",
    timeZone: "UTC",
  });
  return label.replace(" ", " '");
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

function distanceBetween(ax, ay, bx, by) {
  return Math.hypot(ax - bx, ay - by);
}

function splitBubbleLabel(label) {
  const parts = label.split(" ");
  if (parts.length === 1) {
    return parts;
  }
  if (parts.length === 2) {
    return parts;
  }
  return [parts.slice(0, Math.ceil(parts.length / 2)).join(" "), parts.slice(Math.ceil(parts.length / 2)).join(" ")];
}

function splitAxisLabel(label) {
  const parts = String(label || "").split(" ");
  if (parts.length <= 1) {
    return [String(label || "")];
  }
  return [parts.slice(0, -1).join(" "), parts[parts.length - 1]];
}

function buildTickIndices(length, maxTicks) {
  if (!length) {
    return [];
  }
  if (length === 1) {
    return [0];
  }
  const tickCount = Math.min(length, Math.max(2, maxTicks || 8));
  const indices = new Set([0, length - 1]);
  for (let index = 1; index < tickCount - 1; index += 1) {
    indices.add(Math.round((index * (length - 1)) / (tickCount - 1)));
  }
  return Array.from(indices).sort((left, right) => left - right);
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

function withCacheBust(url) {
  const stamp = state.meta?.generated_at_utc || Date.now();
  return `${url}?v=${encodeURIComponent(stamp)}`;
}

function formatTemporalLabel(value) {
  if (!value) {
    return "--";
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
  }
  if (/^\d{4}-\d{2}$/.test(value)) {
    const [year, month] = value.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
  }
  if (/^\d{4}$/.test(value)) {
    return value;
  }
  return value;
}

function tooltipMarkup(title, body) {
  return `<strong>${title}</strong><div class="tooltip-meta">${body}</div>`;
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

function clearSvg(svg) {
  while (svg.firstChild) {
    svg.removeChild(svg.firstChild);
  }
}

function attachTooltip(node, handler) {
  node.addEventListener("mouseenter", handler);
  node.addEventListener("mousemove", handler);
  node.addEventListener("mouseleave", hideTooltip);
  node.addEventListener("blur", hideTooltip);
}

function ensureTooltip() {
  if (state.tooltip) {
    return state.tooltip;
  }
  state.tooltip = elements["chart-tooltip"] || document.getElementById("chart-tooltip");
  if (!state.tooltip) {
    state.tooltip = document.createElement("div");
    state.tooltip.id = "chart-tooltip";
    state.tooltip.className = "chart-tooltip";
    state.tooltip.hidden = true;
    document.body.appendChild(state.tooltip);
  }
  return state.tooltip;
}

function showTooltip(event, html) {
  const tooltip = ensureTooltip();
  tooltip.innerHTML = html;
  tooltip.hidden = false;
  moveTooltip(event);
}

function moveTooltip(event) {
  const tooltip = ensureTooltip();
  const offset = 18;
  const width = tooltip.offsetWidth || 220;
  const height = tooltip.offsetHeight || 80;
  const left = Math.min(window.innerWidth - width - 16, event.clientX + offset);
  const top = Math.min(window.innerHeight - height - 16, event.clientY + offset);
  tooltip.style.left = `${Math.max(12, left)}px`;
  tooltip.style.top = `${Math.max(12, top)}px`;
}

function hideTooltip() {
  const tooltip = ensureTooltip();
  tooltip.hidden = true;
}

function svgNode(tag, attrs, textContent = "") {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  Object.entries(attrs || {}).forEach(([key, value]) => {
    node.setAttribute(key, String(value));
  });
  if (textContent) {
    node.textContent = textContent;
  }
  return node;
}

function emptyText(svg, message) {
  const viewBox = svg.getAttribute("viewBox").split(" ").map(Number);
  return svgNode("text", {
    x: viewBox[2] / 2,
    y: viewBox[3] / 2,
    class: "chart-empty-text",
    "text-anchor": "middle",
  }, message);
}
