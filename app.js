const OPEN_F1_BASE = "https://api.openf1.org/v1";

const state = {
  sessions: [],
  drivers: [],
  lapsByDriver: new Map(),
  selectedDrivers: new Set(),
  selectedYear: new Date().getFullYear(),
};

const sessionSelect = document.getElementById("sessionSelect");
const yearSelect = document.getElementById("yearSelect");
const driverFilterInput = document.getElementById("driverFilter");
const refreshBtn = document.getElementById("refreshBtn");
const driverList = document.getElementById("driverList");
const statusLabel = document.getElementById("status");
const lapTableHead = document.querySelector("#lapTable thead");
const lapTableBody = document.querySelector("#lapTable tbody");
const lapChart = document.getElementById("lapChart");
const ctx = lapChart.getContext("2d");

init();

async function init() {
  populateYears();
  bindEvents();
  await loadSessions();
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

  driverFilterInput.addEventListener("input", renderDriverList);

  refreshBtn.addEventListener("click", async () => {
    if (!sessionSelect.value) {
      await loadSessions();
      return;
    }
    await loadSessionData(Number(sessionSelect.value));
  });
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

async function loadSessions() {
  setStatus(`Loading ${state.selectedYear} race sessions from OpenF1...`);
  refreshBtn.disabled = true;

  try {
    const sessions = await fetchJson(buildUrl("sessions", {
      year: state.selectedYear,
      session_name: "Race",
    }));

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
    await loadSessionData(preferredSession.session_key);
  } catch (error) {
    console.error(error);
    clearSessionData();
    setStatus(`Failed to load sessions. ${error.message}`);
  } finally {
    refreshBtn.disabled = false;
  }
}

async function loadSessionData(sessionKey) {
  setStatus("Loading drivers and lap data...");
  refreshBtn.disabled = true;

  try {
    const [drivers, laps] = await Promise.all([
      fetchJson(buildUrl("drivers", { session_key: sessionKey })),
      fetchJson(buildUrl("laps", { session_key: sessionKey })),
    ]);

    state.drivers = dedupeDrivers(drivers);
    state.lapsByDriver = groupLapsByDriver(laps);

    const defaultSelected = state.drivers.slice(0, 4).map((driver) => driver.driver_number);
    state.selectedDrivers = new Set(defaultSelected);

    renderDriverList();
    renderLapTable();
    renderLapChart();

    const session = state.sessions.find((item) => item.session_key === sessionKey);
    const sessionText = session ? `${session.country_name} ${session.year}` : `session ${sessionKey}`;
    setStatus(`Loaded ${laps.length} laps for ${state.drivers.length} drivers (${sessionText}).`);
  } catch (error) {
    console.error(error);
    clearSessionData();
    setStatus(`Failed to load session data. ${error.message}`);
  } finally {
    refreshBtn.disabled = false;
  }
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
  state.selectedDrivers = new Set();
  renderDriverList();
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
      renderLapTable();
      renderLapChart();
    });

    const text = document.createElement("span");
    text.textContent = `#${driver.driver_number} ${driver.full_name} (${driver.team_name})`;

    label.append(checkbox, text);
    driverList.appendChild(label);
  }
}

function renderLapTable() {
  const selected = getSelectedDrivers();
  lapTableHead.innerHTML = "";
  lapTableBody.innerHTML = "";

  if (!selected.length) {
    return;
  }

  const maxLap = Math.max(
    0,
    ...selected.map((driver) => {
      const laps = state.lapsByDriver.get(driver.driver_number) || [];
      return laps[laps.length - 1]?.lap_number || 0;
    })
  );

  const headRow = document.createElement("tr");
  headRow.appendChild(cell("Lap", "th"));
  selected.forEach((driver) => {
    headRow.appendChild(cell(`#${driver.driver_number} ${driver.last_name}`, "th"));
  });
  lapTableHead.appendChild(headRow);

  for (let lapNo = 1; lapNo <= maxLap; lapNo += 1) {
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
    const laps = state.lapsByDriver.get(driver.driver_number) || [];
    return {
      driver,
      points: laps.map((lap) => ({ x: lap.lap_number, y: lap.lap_duration })),
    };
  });

  const allX = datasets.flatMap((dataset) => dataset.points.map((point) => point.x));
  const allY = datasets.flatMap((dataset) => dataset.points.map((point) => point.y));

  if (!allX.length || !allY.length) {
    drawText("No lap data for selected drivers.", width / 2, height / 2);
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

async function fetchJson(url) {
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`${response.status} ${response.statusText} for ${url}. ${bodyText.slice(0, 180)}`);
  }

  return response.json();
}

function setStatus(message) {
  statusLabel.textContent = message;
}
