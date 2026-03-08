const OPEN_F1_BASE = "https://api.openf1.org/v1";

const state = {
  sessions: [],
  drivers: [],
  lapsByDriver: new Map(),
  selectedDrivers: new Set(),
};

const sessionSelect = document.getElementById("sessionSelect");
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
  setStatus("Loading race sessions...");
  await loadSessions();
  bindEvents();
  if (sessionSelect.value) {
    await loadSessionData(Number(sessionSelect.value));
  }
}

function bindEvents() {
  sessionSelect.addEventListener("change", async (event) => {
    await loadSessionData(Number(event.target.value));
  });

  driverFilterInput.addEventListener("input", renderDriverList);

  refreshBtn.addEventListener("click", async () => {
    if (!sessionSelect.value) return;
    await loadSessionData(Number(sessionSelect.value));
  });
}

async function loadSessions() {
  const thisYear = new Date().getFullYear();
  const years = [thisYear, thisYear - 1, thisYear - 2];

  let sessions = [];
  for (const year of years) {
    const url = `${OPEN_F1_BASE}/sessions?year=${year}&session_type=Race`;
    const response = await fetch(url);
    if (!response.ok) continue;
    sessions = await response.json();
    if (sessions.length) break;
  }

  state.sessions = sessions
    .sort((a, b) => new Date(b.date_start) - new Date(a.date_start))
    .slice(0, 20);

  sessionSelect.innerHTML = "";

  for (const session of state.sessions) {
    const option = document.createElement("option");
    option.value = session.session_key;
    option.textContent = `${session.year} ${session.country_name} — ${session.session_name}`;
    sessionSelect.appendChild(option);
  }

  if (state.sessions.length === 0) {
    setStatus("No race sessions available from API.");
  }
}

async function loadSessionData(sessionKey) {
  try {
    setStatus("Loading drivers and lap data...");
    refreshBtn.disabled = true;

    const [drivers, laps] = await Promise.all([
      fetchJson(`${OPEN_F1_BASE}/drivers?session_key=${sessionKey}`),
      fetchJson(`${OPEN_F1_BASE}/laps?session_key=${sessionKey}`),
    ]);

    state.drivers = dedupeDrivers(drivers);
    state.lapsByDriver = groupLapsByDriver(laps);

    const defaultSelected = state.drivers.slice(0, 3).map((d) => d.driver_number);
    state.selectedDrivers = new Set(defaultSelected);

    renderDriverList();
    renderLapTable();
    renderLapChart();

    setStatus(`Loaded ${laps.length} laps for ${state.drivers.length} drivers.`);
  } catch (error) {
    console.error(error);
    setStatus(`Failed to load data: ${error.message}`);
  } finally {
    refreshBtn.disabled = false;
  }
}

function dedupeDrivers(drivers) {
  const map = new Map();
  for (const driver of drivers) {
    map.set(driver.driver_number, driver);
  }
  return [...map.values()].sort((a, b) => a.driver_number - b.driver_number);
}

function groupLapsByDriver(laps) {
  const map = new Map();
  for (const lap of laps) {
    if (!lap.driver_number || !lap.lap_number || !lap.lap_duration) continue;
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

  const maxLap = Math.max(
    0,
    ...selected.map((driver) => {
      const laps = state.lapsByDriver.get(driver.driver_number) || [];
      return laps[laps.length - 1]?.lap_number || 0;
    })
  );

  const headRow = document.createElement("tr");
  headRow.appendChild(cell("Lap", "th"));
  selected.forEach((driver) => headRow.appendChild(cell(`#${driver.driver_number} ${driver.last_name}`, "th")));
  lapTableHead.appendChild(headRow);

  for (let lapNo = 1; lapNo <= maxLap; lapNo++) {
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

  const allX = datasets.flatMap((d) => d.points.map((p) => p.x));
  const allY = datasets.flatMap((d) => d.points.map((p) => p.y));

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
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.json();
}

function setStatus(message) {
  statusLabel.textContent = message;
}
