const OPEN_F1_BASE = "https://api.openf1.org/v1";
const API_DELAY_MS = 360;
const API_RETRY_DELAYS_MS = [500, 1200, 2000];
const CACHE_TTL_MS = 30_000;

const responseCache = new Map();
let lastApiRequestAt = 0;

const state = {
  sessions: [],
  drivers: [],
  lapsByDriver: new Map(),
  stintsByDriver: new Map(),
  qualiLapsByDriver: new Map(),
  selectedDrivers: new Set(),
  selectedYear: new Date().getFullYear(),
  lapRange: { from: 1, to: 1 },
};

const sessionSelect = document.getElementById("sessionSelect");
const yearSelect = document.getElementById("yearSelect");
const lapFromInput = document.getElementById("lapFrom");
const lapToInput = document.getElementById("lapTo");
const driverFilterInput = document.getElementById("driverFilter");
const refreshBtn = document.getElementById("refreshBtn");
const driverList = document.getElementById("driverList");
const statusLabel = document.getElementById("status");
const lapTableHead = document.querySelector("#lapTable thead");
const lapTableBody = document.querySelector("#lapTable tbody");
const lapChart = document.getElementById("lapChart");
const paceGrid = document.getElementById("paceGrid");
const headToHead = document.getElementById("headToHead");
const qualiDelta = document.getElementById("qualiDelta");
const stintTimeline = document.getElementById("stintTimeline");
const ctx = lapChart.getContext("2d");

init();

async function init() {
  populateYears();
  bindEvents();
  await loadSessions();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRateLimitSlot() {
  const now = Date.now();
  const waitMs = Math.max(0, API_DELAY_MS - (now - lastApiRequestAt));
  if (waitMs > 0) {
    await sleep(waitMs);
  }
  lastApiRequestAt = Date.now();
}

function bindEvents() {
  yearSelect.addEventListener("change", async (event) => {
    state.selectedYear = Number(event.target.value);
    await loadSessions();
  });

  sessionSelect.addEventListener("change", async (event) => {
    const sessionKey = Number(event.target.value);
    if (Number.isFinite(sessionKey)) {
      await loadSessionData(sessionKey);
    }
  });

  lapFromInput.addEventListener("change", onLapRangeChange);
  lapToInput.addEventListener("change", onLapRangeChange);
  driverFilterInput.addEventListener("input", renderDriverList);

  refreshBtn.addEventListener("click", async () => {
    if (!sessionSelect.value) {
      await loadSessions(true);
      return;
    }
    await loadSessionData(Number(sessionSelect.value), true);
  });
}

function onLapRangeChange() {
  const maxLap = getMaxLapInSelection();
  const from = normalizeLapValue(Number(lapFromInput.value), 1, maxLap);
  const to = normalizeLapValue(Number(lapToInput.value), 1, maxLap);

  state.lapRange.from = Math.min(from, to);
  state.lapRange.to = Math.max(from, to);

  lapFromInput.value = String(state.lapRange.from);
  lapToInput.value = String(state.lapRange.to);

  renderPhase1Analytics();
  renderLapTable();
  renderLapChart();
}

function populateYears() {
  const thisYear = new Date().getFullYear();
  yearSelect.innerHTML = "";
  for (let year = thisYear; year >= 2023; year -= 1) {
    const option = document.createElement("option");
    option.value = String(year);
    option.textContent = String(year);
    if (year === state.selectedYear) option.selected = true;
    yearSelect.appendChild(option);
  }
}

async function loadSessions(forceRefresh = false) {
  setStatus(`Loading ${state.selectedYear} race sessions from OpenF1...`);
  refreshBtn.disabled = true;

  try {
    const sessions = await fetchJson(buildUrl("sessions", {
      year: state.selectedYear,
      session_name: "Race",
    }), { forceRefresh });

    state.sessions = sessions.sort((a, b) => new Date(a.date_start) - new Date(b.date_start));
    sessionSelect.innerHTML = "";

    if (!state.sessions.length) {
      clearSessionData();
      setStatus(`No race sessions found for ${state.selectedYear}.`);
      return;
    }

    for (const session of state.sessions) {
      const option = document.createElement("option");
      option.value = session.session_key;
      option.textContent = `${session.country_name} — ${session.session_name}`;
      sessionSelect.appendChild(option);
    }

    const preferredSession =
      state.sessions.find((session) => session.country_name?.toLowerCase().includes("australia")) ?? state.sessions[0];

    sessionSelect.value = String(preferredSession.session_key);
    await loadSessionData(preferredSession.session_key, forceRefresh);
  } catch (error) {
    console.error(error);
    clearSessionData();
    setStatus(`Failed to load sessions. ${error.message}`);
  } finally {
    refreshBtn.disabled = false;
  }
}

async function loadSessionData(sessionKey, forceRefresh = false) {
  setStatus("Loading drivers, laps, stints, and qualifying data...");
  refreshBtn.disabled = true;

  try {
    const session = state.sessions.find((item) => item.session_key === sessionKey);

    const [drivers, laps, stints, qualifyingSession] = await Promise.all([
      fetchJson(buildUrl("drivers", { session_key: sessionKey }), { forceRefresh }),
      fetchJson(buildUrl("laps", { session_key: sessionKey }), { forceRefresh }),
      fetchJson(buildUrl("stints", { session_key: sessionKey }), { forceRefresh }),
      loadQualifyingSession(session, forceRefresh),
    ]);

    state.drivers = dedupeDrivers(drivers);
    state.lapsByDriver = groupLapsByDriver(laps);
    state.stintsByDriver = groupStintsByDriver(stints);

    if (qualifyingSession?.session_key) {
      const qualiLaps = await fetchJson(buildUrl("laps", { session_key: qualifyingSession.session_key }), { forceRefresh });
      state.qualiLapsByDriver = groupLapsByDriver(qualiLaps);
    } else {
      state.qualiLapsByDriver = new Map();
    }

    const defaultSelected = state.drivers.slice(0, 4).map((driver) => driver.driver_number);
    state.selectedDrivers = new Set(defaultSelected);

    initializeLapRange();
    renderDriverList();
    renderPhase1Analytics();
    renderLapTable();
    renderLapChart();
    renderStintTimeline();

    const sessionText = session ? `${session.country_name} ${session.year}` : `session ${sessionKey}`;
    setStatus(`Loaded ${laps.length} race laps for ${state.drivers.length} drivers (${sessionText}).`);
  } catch (error) {
    console.error(error);
    clearSessionData();
    setStatus(`Failed to load session data. ${error.message}`);
  } finally {
    refreshBtn.disabled = false;
  }
}

async function loadQualifyingSession(raceSession, forceRefresh = false) {
  if (!raceSession?.meeting_key) return null;

  const qualiSessions = await fetchJson(buildUrl("sessions", {
    meeting_key: raceSession.meeting_key,
    session_name: "Qualifying",
  }), { forceRefresh });

  return qualiSessions[0] ?? null;
}

function buildUrl(resource, params = {}) {
  const url = new URL(`${OPEN_F1_BASE}/${resource}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

function clearSessionData() {
  state.drivers = [];
  state.lapsByDriver = new Map();
  state.stintsByDriver = new Map();
  state.qualiLapsByDriver = new Map();
  state.selectedDrivers = new Set();
  state.lapRange = { from: 1, to: 1 };
  syncLapRangeInputs();
  renderDriverList();
  renderPhase1Analytics();
  renderStintTimeline();
  renderLapTable();
  renderLapChart();
}

function dedupeDrivers(drivers) {
  const map = new Map();
  for (const driver of drivers) {
    if (driver.driver_number == null) continue;
    map.set(driver.driver_number, driver);
  }
  return [...map.values()].sort((a, b) => a.driver_number - b.driver_number);
}

function groupLapsByDriver(laps) {
  const map = new Map();
  for (const lap of laps) {
    if (lap.driver_number == null || lap.lap_number == null || lap.lap_duration == null) continue;
    if (!map.has(lap.driver_number)) map.set(lap.driver_number, []);
    map.get(lap.driver_number).push(lap);
  }

  for (const [driverNumber, driverLaps] of map.entries()) {
    driverLaps.sort((a, b) => a.lap_number - b.lap_number);
    map.set(driverNumber, driverLaps);
  }

  return map;
}

function groupStintsByDriver(stints) {
  const map = new Map();
  for (const stint of stints) {
    if (stint.driver_number == null) continue;
    if (!map.has(stint.driver_number)) map.set(stint.driver_number, []);
    map.get(stint.driver_number).push(stint);
  }

  for (const [driverNumber, driverStints] of map.entries()) {
    driverStints.sort((a, b) => (a.lap_start ?? 0) - (b.lap_start ?? 0));
    map.set(driverNumber, driverStints);
  }

  return map;
}

function initializeLapRange() {
  const maxLap = getMaxLapInSelection();
  state.lapRange = { from: 1, to: maxLap };
  syncLapRangeInputs();
}

function syncLapRangeInputs() {
  const maxLap = Math.max(1, getMaxLapInSelection());
  lapFromInput.min = "1";
  lapToInput.min = "1";
  lapFromInput.max = String(maxLap);
  lapToInput.max = String(maxLap);
  lapFromInput.value = String(state.lapRange.from);
  lapToInput.value = String(state.lapRange.to);
}

function normalizeLapValue(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function getMaxLapInSelection() {
  const allLaps = [...state.lapsByDriver.values()].flat();
  const maxLap = Math.max(1, ...allLaps.map((lap) => lap.lap_number ?? 1));
  return maxLap;
}

function renderDriverList() {
  const filter = driverFilterInput.value.trim().toLowerCase();
  driverList.innerHTML = "";

  const visibleDrivers = state.drivers.filter((driver) => {
    const text = `${driver.full_name} ${driver.team_name} ${driver.driver_number}`.toLowerCase();
    return text.includes(filter);
  });

  if (!visibleDrivers.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No drivers found.";
    driverList.appendChild(empty);
    return;
  }

  for (const driver of visibleDrivers) {
    const label = document.createElement("label");
    label.className = "driver-item";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.selectedDrivers.has(driver.driver_number);
    checkbox.addEventListener("change", (event) => {
      if (event.target.checked) {
        state.selectedDrivers.add(driver.driver_number);
      } else {
        state.selectedDrivers.delete(driver.driver_number);
      }
      renderPhase1Analytics();
      renderLapTable();
      renderLapChart();
      renderStintTimeline();
    });

    const text = document.createElement("span");
    text.textContent = `#${driver.driver_number} ${driver.full_name} (${driver.team_name})`;

    label.append(checkbox, text);
    driverList.appendChild(label);
  }
}

function renderPhase1Analytics() {
  renderPaceMetrics();
  renderHeadToHead();
  renderQualifyingDelta();
}

function renderPaceMetrics() {
  const selected = getSelectedDrivers();
  paceGrid.innerHTML = "";

  if (!selected.length) {
    paceGrid.innerHTML = `<p class="empty">Select drivers to compute race pace.</p>`;
    return;
  }

  const metrics = selected.map((driver) => {
    const validLaps = getRacePaceLaps(driver.driver_number);
    return {
      driver,
      avg: average(validLaps),
      median: median(validLaps),
      best: validLaps.length ? Math.min(...validLaps) : null,
      count: validLaps.length,
    };
  });

  for (const item of metrics) {
    const card = document.createElement("article");
    card.className = "metric-card";
    card.innerHTML = `
      <h3>#${item.driver.driver_number} ${item.driver.last_name}</h3>
      <p><strong>Median pace:</strong> ${formatMetric(item.median)}</p>
      <p><strong>Average pace:</strong> ${formatMetric(item.avg)}</p>
      <p><strong>Best lap:</strong> ${formatMetric(item.best)}</p>
      <p><strong>Valid laps:</strong> ${item.count} (L${state.lapRange.from}-L${state.lapRange.to})</p>
    `;
    paceGrid.appendChild(card);
  }
}

function renderHeadToHead() {
  const selected = getSelectedDrivers().slice(0, 2);

  if (selected.length < 2) {
    headToHead.innerHTML = `<h3>Head-to-head</h3><p class="empty">Select at least 2 drivers.</p>`;
    return;
  }

  const [a, b] = selected;
  const aLaps = getRacePaceLaps(a.driver_number);
  const bLaps = getRacePaceLaps(b.driver_number);

  const aMedian = median(aLaps);
  const bMedian = median(bLaps);
  const delta = aMedian != null && bMedian != null ? aMedian - bMedian : null;

  headToHead.innerHTML = `
    <h3>Head-to-head race pace</h3>
    <p><strong>${a.last_name}</strong> median: ${formatMetric(aMedian)}</p>
    <p><strong>${b.last_name}</strong> median: ${formatMetric(bMedian)}</p>
    <p><strong>Delta (${a.last_name} - ${b.last_name}):</strong> ${formatDelta(delta)}</p>
    <p class="muted">Based on valid race laps from L${state.lapRange.from} to L${state.lapRange.to} (pit in/out excluded).</p>
  `;
}

function renderQualifyingDelta() {
  const selected = getSelectedDrivers().slice(0, 2);

  if (selected.length < 2) {
    qualiDelta.innerHTML = `<h3>Qualifying delta</h3><p class="empty">Select at least 2 drivers.</p>`;
    return;
  }

  if (!state.qualiLapsByDriver.size) {
    qualiDelta.innerHTML = `<h3>Qualifying delta</h3><p class="empty">No qualifying lap data found for this meeting.</p>`;
    return;
  }

  const [a, b] = selected;
  const aBest = bestLap(state.qualiLapsByDriver.get(a.driver_number) || []);
  const bBest = bestLap(state.qualiLapsByDriver.get(b.driver_number) || []);
  const delta = aBest != null && bBest != null ? aBest - bBest : null;

  qualiDelta.innerHTML = `
    <h3>Qualifying delta (best lap)</h3>
    <p><strong>${a.last_name}</strong>: ${formatMetric(aBest)}</p>
    <p><strong>${b.last_name}</strong>: ${formatMetric(bBest)}</p>
    <p><strong>Delta (${a.last_name} - ${b.last_name}):</strong> ${formatDelta(delta)}</p>
  `;
}

function renderStintTimeline() {
  const selected = getSelectedDrivers();
  stintTimeline.innerHTML = "";

  if (!selected.length) {
    stintTimeline.innerHTML = `<p class="empty">Select drivers to view stint timeline.</p>`;
    return;
  }

  const maxLap = Math.max(
    1,
    ...selected.map((driver) => {
      const laps = state.lapsByDriver.get(driver.driver_number) || [];
      return laps[laps.length - 1]?.lap_number || 1;
    })
  );

  for (const driver of selected) {
    const row = document.createElement("div");
    row.className = "timeline-row";
    const stints = state.stintsByDriver.get(driver.driver_number) || [];

    const label = document.createElement("div");
    label.className = "timeline-label";
    label.textContent = `#${driver.driver_number} ${driver.last_name}`;

    const track = document.createElement("div");
    track.className = "timeline-track";

    for (const stint of stints) {
      const start = stint.lap_start ?? 1;
      const end = stint.lap_end ?? start;
      const left = ((start - 1) / maxLap) * 100;
      const width = (Math.max(end - start + 1, 1) / maxLap) * 100;

      const segment = document.createElement("div");
      segment.className = `stint-segment ${compoundClass(stint.compound ?? stint.tyre_compound)}`;
      segment.style.left = `${left}%`;
      segment.style.width = `${width}%`;
      segment.title = `${stint.compound ?? stint.tyre_compound ?? "Unknown"}: L${start}-L${end}`;
      track.appendChild(segment);
    }

    if (!stints.length) {
      const empty = document.createElement("span");
      empty.className = "empty";
      empty.textContent = "No stint data";
      track.appendChild(empty);
    }

    row.append(label, track);
    stintTimeline.appendChild(row);
  }
}

function compoundClass(value) {
  const normalized = String(value || "unknown").toLowerCase();
  if (normalized.includes("soft")) return "soft";
  if (normalized.includes("medium")) return "medium";
  if (normalized.includes("hard")) return "hard";
  if (normalized.includes("inter")) return "inter";
  if (normalized.includes("wet")) return "wet";
  return "unknown";
}

function renderLapTable() {
  const selected = getSelectedDrivers();
  lapTableHead.innerHTML = "";
  lapTableBody.innerHTML = "";

  if (!selected.length) return;

  const { from, to } = state.lapRange;
  const headRow = document.createElement("tr");
  headRow.appendChild(cell("Lap", "th"));
  selected.forEach((driver) => {
    headRow.appendChild(cell(`#${driver.driver_number} ${driver.last_name}`, "th"));
  });
  lapTableHead.appendChild(headRow);

  for (let lapNo = from; lapNo <= to; lapNo += 1) {
    const row = document.createElement("tr");
    row.appendChild(cell(String(lapNo)));

    selected.forEach((driver) => {
      const lap = (state.lapsByDriver.get(driver.driver_number) || []).find((entry) => entry.lap_number === lapNo);
      row.appendChild(cell(lap ? formatLapTime(lap.lap_duration) : "—"));
    });

    lapTableBody.appendChild(row);
  }
}

function renderLapChart() {
  const selected = getSelectedDrivers();
  const width = lapChart.width;
  const height = lapChart.height;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#0f141b";
  ctx.fillRect(0, 0, width, height);

  if (!selected.length) {
    drawText("Select at least one driver.", width / 2, height / 2);
    return;
  }

  const datasets = selected.map((driver) => {
    const laps = getRaceLapsInRange(driver.driver_number);
    return {
      driver,
      points: laps.map((lap) => ({ x: lap.lap_number, y: lap.lap_duration })),
    };
  });

  const allX = datasets.flatMap((dataset) => dataset.points.map((point) => point.x));
  const allY = datasets.flatMap((dataset) => dataset.points.map((point) => point.y));

  if (!allX.length || !allY.length) {
    drawText(`No lap data in selected range L${state.lapRange.from}-L${state.lapRange.to}.`, width / 2, height / 2);
    return;
  }

  const minX = Math.min(...allX);
  const maxX = Math.max(...allX);
  const minY = Math.min(...allY) * 0.98;
  const maxY = Math.max(...allY) * 1.02;

  const plot = { left: 56, right: width - 20, top: 20, bottom: height - 44 };
  drawAxes(plot);

  const colors = ["#2f81f7", "#d29922", "#3fb950", "#ff7b72", "#a371f7", "#56d4dd"];

  datasets.forEach((dataset, index) => {
    const color = colors[index % colors.length];
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();

    dataset.points.forEach((point, i) => {
      const x = scale(point.x, minX, maxX || minX + 1, plot.left, plot.right);
      const y = scale(point.y, minY, maxY || minY + 1, plot.bottom, plot.top);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });

    ctx.stroke();
    drawLegend(dataset.driver, color, index);
  });

  drawText(`Lap ${minX} - ${maxX}`, width / 2, height - 14);
}

function drawAxes(plot) {
  ctx.strokeStyle = "#39414b";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(plot.left, plot.top);
  ctx.lineTo(plot.left, plot.bottom);
  ctx.lineTo(plot.right, plot.bottom);
  ctx.stroke();
}

function drawLegend(driver, color, index) {
  const x = 68 + (index % 3) * 340;
  const y = 30 + Math.floor(index / 3) * 18;
  ctx.fillStyle = color;
  ctx.fillRect(x, y - 8, 10, 10);
  ctx.fillStyle = "#e6edf3";
  ctx.font = "12px sans-serif";
  ctx.fillText(`#${driver.driver_number} ${driver.last_name}`, x + 14, y);
}

function drawText(text, x, y) {
  ctx.fillStyle = "#9ba7b4";
  ctx.font = "14px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(text, x, y);
  ctx.textAlign = "left";
}

function scale(value, inMin, inMax, outMin, outMax) {
  const ratio = (value - inMin) / (inMax - inMin || 1);
  return outMin + ratio * (outMax - outMin);
}

function getSelectedDrivers() {
  return state.drivers.filter((driver) => state.selectedDrivers.has(driver.driver_number));
}

function getRaceLapsInRange(driverNumber) {
  const laps = state.lapsByDriver.get(driverNumber) || [];
  return laps.filter((lap) => lap.lap_number >= state.lapRange.from && lap.lap_number <= state.lapRange.to);
}

function getRacePaceLaps(driverNumber) {
  return getRaceLapsInRange(driverNumber)
    .filter((lap) => !lap.is_pit_out_lap && !lap.is_pit_in_lap)
    .map((lap) => lap.lap_duration)
    .filter((lapDuration) => Number.isFinite(lapDuration) && lapDuration > 0);
}

function bestLap(laps) {
  if (!laps.length) return null;
  const values = laps.map((lap) => lap.lap_duration).filter((value) => Number.isFinite(value) && value > 0);
  if (!values.length) return null;
  return Math.min(...values);
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }
  return sorted[middle];
}

function formatMetric(seconds) {
  if (seconds == null) return "—";
  return formatLapTime(seconds);
}

function formatDelta(deltaSeconds) {
  if (deltaSeconds == null) return "—";
  const sign = deltaSeconds > 0 ? "+" : "";
  return `${sign}${deltaSeconds.toFixed(3)}s`;
}

function formatLapTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const rem = seconds - mins * 60;
  return `${mins}:${rem.toFixed(3).padStart(6, "0")}`;
}

function cell(value, type = "td") {
  const element = document.createElement(type);
  element.textContent = value;
  return element;
}

async function fetchJson(url, options = {}) {
  const { forceRefresh = false } = options;
  const cached = responseCache.get(url);
  const now = Date.now();

  if (!forceRefresh && cached && now - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  for (let attempt = 0; attempt <= API_RETRY_DELAYS_MS.length; attempt += 1) {
    await waitForRateLimitSlot();

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
    });

    if (response.ok) {
      const data = await response.json();
      responseCache.set(url, { data, timestamp: Date.now() });
      return data;
    }

    const bodyText = await response.text();
    const shouldRetry = response.status === 429 && attempt < API_RETRY_DELAYS_MS.length;

    if (shouldRetry) {
      const retryAfterSeconds = Number(response.headers.get("retry-after"));
      const retryMs = Number.isFinite(retryAfterSeconds)
        ? retryAfterSeconds * 1000
        : API_RETRY_DELAYS_MS[attempt];
      await sleep(retryMs);
      continue;
    }

    throw new Error(`${response.status} ${response.statusText} for ${url}. ${bodyText.slice(0, 220)}`);
  }

  throw new Error(`Request failed after retries for ${url}.`);
}

function setStatus(message) {
  statusLabel.textContent = message;
}
