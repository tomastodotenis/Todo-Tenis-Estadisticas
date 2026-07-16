// ============================================================
// CONFIGURACIÓN — completá esto antes de publicar la app
// ============================================================
const CONFIG = {
  // Pegá acá el Client ID que te da Google Cloud Console
  // (termina en .apps.googleusercontent.com)
  CLIENT_ID: "177848532466-h59ae4tio4klac8uh9clhsb68voeapnp.apps.googleusercontent.com",

  // Carpeta raíz de Drive con las ventas (Año > Mes > Planillas)
  // Ya viene precargada con la que compartiste.
  DEFAULT_ROOT_FOLDER_ID: "1DuyhPClinMyDpSaJKIcHLCVoHGkj5NuM",

  SCOPES: "https://www.googleapis.com/auth/drive.readonly",
  CACHE_KEY: "ttr_sales_cache_v1",
  FOLDER_KEY: "ttr_root_folder_id",
};

// Encabezados esperados en las planillas (se buscan por texto, no por posición,
// porque la fila donde empiezan puede variar entre meses)
const HEADERS = {
  title: "Título de la publicación",
  units: "Unidades",
  date: "Fecha de venta",
  sku: "SKU",
  variant: "Variante",
};

const MONTHS_ES = {
  enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5,
  julio: 6, agosto: 7, septiembre: 8, setiembre: 8, octubre: 9,
  noviembre: 10, diciembre: 11,
};

// ============================================================
// ESTADO
// ============================================================
let accessToken = null;
let tokenClient = null;
let allRecords = []; // {date: Date, title, units, sku}
let currentPeriod = "day";
let currentChartType = "bar";
let chartInstance = null;

const $ = (id) => document.getElementById(id);

// ============================================================
// AUTH (Google Identity Services)
// ============================================================
function initAuth() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.CLIENT_ID,
    scope: CONFIG.SCOPES,
    callback: (resp) => {
      if (resp.error) {
        setStatus(false, "No se pudo conectar: " + resp.error);
        return;
      }
      accessToken = resp.access_token;
      onConnected();
    },
  });
}

$("authBtn").addEventListener("click", () => {
  if (CONFIG.CLIENT_ID.includes("PONÉ_TU_CLIENT_ID")) {
    alert(
      "Falta configurar el Client ID de Google.\n\n" +
      "Abrí app.js y reemplazá CONFIG.CLIENT_ID por el que generaste en Google Cloud Console."
    );
    return;
  }
  tokenClient.requestAccessToken({ prompt: accessToken ? "" : "consent" });
});

function onConnected() {
  setStatus(true, "Conectado. Elegí un período y presioná “Actualizar datos”.");
  $("settingsPanel").hidden = false;
  $("syncPanel").hidden = false;
  $("filtersPanel").hidden = false;
  $("viewPanel").hidden = false;
  $("chartPanel").hidden = false;
  $("tablePanel").hidden = false;
  $("authBtn").textContent = "Reconectar";

  const savedFolder = localStorage.getItem(CONFIG.FOLDER_KEY) || CONFIG.DEFAULT_ROOT_FOLDER_ID;
  $("folderIdInput").value = savedFolder;

  loadCacheFromStorage();
  renderForCurrentFilters();
}

function setStatus(ok, text) {
  $("statusDot").classList.toggle("on", ok);
  $("statusText").textContent = text;
}

// ============================================================
// SETTINGS PANEL TOGGLE
// ============================================================
$("settingsToggle").addEventListener("click", () => {
  $("settingsPanel").hidden = !$("settingsPanel").hidden;
});
$("saveFolderBtn").addEventListener("click", () => {
  const val = $("folderIdInput").value.trim();
  if (!val) return;
  localStorage.setItem(CONFIG.FOLDER_KEY, val);
  $("settingsPanel").hidden = true;
  setStatus(true, "Carpeta guardada. Presioná “Actualizar datos” para sincronizar.");
});

// ============================================================
// DRIVE — recorrido recursivo de carpetas
// ============================================================
async function driveList(q, fields) {
  let files = [];
  let pageToken = null;
  do {
    const url = new URL("https://www.googleapis.com/drive/v3/files");
    url.searchParams.set("q", q);
    url.searchParams.set("fields", `nextPageToken, files(${fields})`);
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`Drive API error ${res.status}`);
    const data = await res.json();
    files = files.concat(data.files || []);
    pageToken = data.nextPageToken || null;
  } while (pageToken);
  return files;
}

// Recorre recursivamente y devuelve todos los archivos de Sheets encontrados
async function collectSpreadsheets(rootFolderId, onFolder) {
  const spreadsheets = [];
  const queue = [rootFolderId];

  while (queue.length) {
    const folderId = queue.shift();
    if (onFolder) onFolder(folderId);

    const children = await driveList(
      `'${folderId}' in parents and trashed = false`,
      "id, name, mimeType, modifiedTime"
    );

    for (const item of children) {
      if (item.mimeType === "application/vnd.google-apps.folder") {
        queue.push(item.id);
      } else if (item.mimeType === "application/vnd.google-apps.spreadsheet") {
        spreadsheets.push(item);
      }
    }
  }
  return spreadsheets;
}

// ============================================================
// SHEETS — lectura y parseo
// ============================================================
async function fetchSpreadsheetTabs(spreadsheetId) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties.title`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Sheets API error ${res.status}`);
  const data = await res.json();
  return (data.sheets || []).map((s) => s.properties.title);
}

async function fetchSpreadsheetValues(spreadsheetId, tabNames) {
  if (!tabNames.length) return {};
  const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchGet`);
  tabNames.forEach((t) => url.searchParams.append("ranges", `'${t}'`));
  url.searchParams.set("majorDimension", "ROWS");

  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`Sheets values error ${res.status}`);
  const data = await res.json();

  const out = {};
  (data.valueRanges || []).forEach((vr, i) => {
    out[tabNames[i]] = vr.values || [];
  });
  return out;
}

// Busca la fila de encabezado buscando el texto exacto, sin asumir una fila fija
function findHeaderRow(rows) {
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    const row = rows[r].map((c) => (c || "").trim());
    if (row.includes(HEADERS.title) && row.includes(HEADERS.units)) {
      return { rowIndex: r, cols: row };
    }
  }
  return null;
}

function parseSpanishDate(str) {
  if (!str) return null;
  const m = str.match(/(\d{1,2}) de (\w+) de (\d{4})(?:\s+(\d{1,2}):(\d{2}))?/i);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = MONTHS_ES[m[2].toLowerCase()];
  const year = parseInt(m[3], 10);
  const hour = m[4] ? parseInt(m[4], 10) : 0;
  const min = m[5] ? parseInt(m[5], 10) : 0;
  if (month === undefined) return null;
  return new Date(year, month, day, hour, min);
}

// Extrae el valor de "Talle" desde el texto de Variante, ej:
// "Color : Negro | Diseño de la tela : Lisa | Talle : 9.5 US" -> "9.5 US"
function extractTalle(variantText) {
  if (!variantText) return "";
  const m = variantText.match(/Talle\s*:\s*([^|]+)/i);
  return m ? m[1].trim() : "";
}

function parseTabRows(rows) {
  const header = findHeaderRow(rows);
  if (!header) return [];

  const titleCol = header.cols.indexOf(HEADERS.title);
  const unitsCol = header.cols.indexOf(HEADERS.units);
  const dateCol = header.cols.indexOf(HEADERS.date);
  const skuCol = header.cols.indexOf(HEADERS.sku);
  const variantCol = header.cols.indexOf(HEADERS.variant);

  const records = [];
  for (let r = header.rowIndex + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    const title = (row[titleCol] || "").trim();
    const unitsRaw = (row[unitsCol] || "").trim();
    if (!title || !unitsRaw) continue; // filas resumen de "Paquete de N productos" no tienen título propio

    const units = parseInt(unitsRaw.replace(/\./g, ""), 10);
    if (!Number.isFinite(units) || units <= 0) continue;

    const date = dateCol >= 0 ? parseSpanishDate(row[dateCol]) : null;
    const talle = variantCol >= 0 ? extractTalle(row[variantCol]) : "";

    records.push({
      title,
      units,
      sku: skuCol >= 0 ? (row[skuCol] || "").trim() : "",
      talle,
      date,
    });
  }
  return records;
}

// ============================================================
// CACHE (localStorage, por archivo + modifiedTime)
// ============================================================
let fileCache = {}; // { [fileId]: { modifiedTime, records } }

function loadCacheFromStorage() {
  try {
    const raw = localStorage.getItem(CONFIG.CACHE_KEY);
    fileCache = raw ? JSON.parse(raw) : {};
  } catch {
    fileCache = {};
  }
  rebuildAllRecordsFromCache();
}

function rebuildAllRecordsFromCache() {
  allRecords = [];
  for (const fileId in fileCache) {
    const entry = fileCache[fileId];
    (entry.records || []).forEach((r) => {
      allRecords.push({ ...r, date: r.date ? new Date(r.date) : null });
    });
  }
  updateCacheInfo();
}

function saveCacheToStorage() {
  try {
    localStorage.setItem(CONFIG.CACHE_KEY, JSON.stringify(fileCache));
  } catch (e) {
    console.warn("No se pudo guardar el cache local (puede estar lleno):", e);
  }
}

function updateCacheInfo() {
  const files = Object.keys(fileCache).length;
  $("cacheInfo").textContent = files
    ? `${files} planillas en cache · ${allRecords.length} filas de venta`
    : "";
}

// ============================================================
// SYNC — botón principal
// ============================================================
$("syncBtn").addEventListener("click", runSync);

async function runSync() {
  const rootFolderId = (localStorage.getItem(CONFIG.FOLDER_KEY) || CONFIG.DEFAULT_ROOT_FOLDER_ID).trim();
  const btn = $("syncBtn");
  btn.disabled = true;
  btn.textContent = "Buscando planillas...";
  $("progressTrack").hidden = false;
  $("progressFill").style.width = "5%";

  try {
    const spreadsheets = await collectSpreadsheets(rootFolderId);
    const total = spreadsheets.length;
    $("syncProgress").textContent = `0 / ${total}`;

    let done = 0;
    for (const file of spreadsheets) {
      const cached = fileCache[file.id];
      if (!cached || cached.modifiedTime !== file.modifiedTime) {
        const tabs = await fetchSpreadsheetTabs(file.id);
        const values = await fetchSpreadsheetValues(file.id, tabs);
        let records = [];
        for (const tabName of tabs) {
          records = records.concat(parseTabRows(values[tabName] || []));
        }
        fileCache[file.id] = {
          modifiedTime: file.modifiedTime,
          name: file.name,
          records: records.map((r) => ({ ...r, date: r.date ? r.date.toISOString() : null })),
        };
      }
      done++;
      $("syncProgress").textContent = `${done} / ${total}`;
      $("progressFill").style.width = `${5 + (done / Math.max(total, 1)) * 95}%`;
    }

    // Elimina del cache archivos que ya no existen en Drive
    const validIds = new Set(spreadsheets.map((f) => f.id));
    Object.keys(fileCache).forEach((id) => {
      if (!validIds.has(id)) delete fileCache[id];
    });

    saveCacheToStorage();
    rebuildAllRecordsFromCache();
    setStatus(true, `Sincronizado: ${total} planillas revisadas.`);
    renderForCurrentFilters();
  } catch (err) {
    console.error(err);
    setStatus(false, "Error al sincronizar: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Actualizar datos";
    $("progressTrack").hidden = true;
  }
}

// ============================================================
// FILTROS DE PERÍODO
// ============================================================
document.querySelectorAll("#periodSegmented .seg").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#periodSegmented .seg").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentPeriod = btn.dataset.period;
    renderFilterControls();
    renderForCurrentFilters();
  });
});

function renderFilterControls() {
  const el = $("filterControls");
  const today = new Date().toISOString().slice(0, 10);

  if (currentPeriod === "day") {
    el.innerHTML = `<input type="date" id="dayInput" value="${today}" />`;
    $("dayInput").addEventListener("change", renderForCurrentFilters);
  } else if (currentPeriod === "week") {
    const week = isoWeekString(new Date());
    el.innerHTML = `<input type="week" id="weekInput" value="${week}" />`;
    $("weekInput").addEventListener("change", renderForCurrentFilters);
  } else if (currentPeriod === "month") {
    const month = today.slice(0, 7);
    el.innerHTML = `<input type="month" id="monthInput" value="${month}" />`;
    $("monthInput").addEventListener("change", renderForCurrentFilters);
  } else if (currentPeriod === "range") {
    el.innerHTML = `
      <div class="range-row">
        <input type="date" id="rangeFrom" value="${today}" />
        <input type="date" id="rangeTo" value="${today}" />
      </div>`;
    $("rangeFrom").addEventListener("change", renderForCurrentFilters);
    $("rangeTo").addEventListener("change", renderForCurrentFilters);
  }
}

function isoWeekString(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  const weekNo = 1 + Math.round(((d - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
  return `${d.getFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

function getSelectedRange() {
  if (currentPeriod === "day") {
    const val = $("dayInput")?.value;
    if (!val) return null;
    const [y, m, d] = val.split("-").map(Number);
    const from = new Date(y, m - 1, d, 0, 0, 0);
    const to = new Date(y, m - 1, d, 23, 59, 59);
    return { from, to, label: from.toLocaleDateString("es-AR", { day: "2-digit", month: "long", year: "numeric" }) };
  }
  if (currentPeriod === "week") {
    const val = $("weekInput")?.value;
    if (!val) return null;
    const [yearStr, weekStr] = val.split("-W");
    const year = Number(yearStr);
    const week = Number(weekStr);
    const jan4 = new Date(year, 0, 4);
    const mondayW1 = new Date(jan4);
    mondayW1.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7));
    const from = new Date(mondayW1);
    from.setDate(mondayW1.getDate() + (week - 1) * 7);
    const to = new Date(from);
    to.setDate(from.getDate() + 6);
    to.setHours(23, 59, 59);
    return {
      from, to,
      label: `Sem. ${week} — ${from.toLocaleDateString("es-AR", { day: "2-digit", month: "short" })} al ${to.toLocaleDateString("es-AR", { day: "2-digit", month: "short" })}`,
    };
  }
  if (currentPeriod === "month") {
    const val = $("monthInput")?.value;
    if (!val) return null;
    const [y, m] = val.split("-").map(Number);
    const from = new Date(y, m - 1, 1, 0, 0, 0);
    const to = new Date(y, m, 0, 23, 59, 59);
    return { from, to, label: from.toLocaleDateString("es-AR", { month: "long", year: "numeric" }) };
  }
  if (currentPeriod === "range") {
    const fromVal = $("rangeFrom")?.value;
    const toVal = $("rangeTo")?.value;
    if (!fromVal || !toVal) return null;
    const [fy, fm, fd] = fromVal.split("-").map(Number);
    const [ty, tm, td] = toVal.split("-").map(Number);
    const from = new Date(fy, fm - 1, fd, 0, 0, 0);
    const to = new Date(ty, tm - 1, td, 23, 59, 59);
    return {
      from, to,
      label: `${from.toLocaleDateString("es-AR")} → ${to.toLocaleDateString("es-AR")}`,
    };
  }
  return null;
}

// ============================================================
// AGREGACIÓN Y RENDER
// ============================================================
let currentView = "products"; // "products" | "sizes"
let currentFiltered = []; // último set de registros filtrado por período

document.querySelectorAll("#viewSegmented .seg").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#viewSegmented .seg").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentView = btn.dataset.view;
    $("productPicker").hidden = currentView !== "sizes";
    renderForCurrentFilters();
  });
});

$("productSelect").addEventListener("change", () => renderSizesView());

function renderForCurrentFilters() {
  const range = getSelectedRange();
  if (!range) return;

  currentFiltered = allRecords.filter((r) => r.date && r.date >= range.from && r.date <= range.to);
  const totalUnits = currentFiltered.reduce((sum, r) => sum + r.units, 0);

  $("periodLabel").textContent = range.label;
  $("totalUnitsLabel").textContent = `${totalUnits} unidades`;

  if (currentView === "products") {
    renderProductsView();
  } else {
    populateProductSelect();
    renderSizesView();
  }
}

function renderProductsView() {
  $("chartTitle").textContent = "Ranking de productos";
  $("lbNameHead").textContent = "Producto";

  const totals = new Map();
  currentFiltered.forEach((r) => {
    totals.set(r.title, (totals.get(r.title) || 0) + r.units);
  });
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);

  renderChart(ranked.slice(0, 10));
  renderLeaderboard(ranked.slice(0, 20));
}

// Arma el desplegable de productos del período actual, ordenado por unidades
function populateProductSelect() {
  const totals = new Map();
  currentFiltered.forEach((r) => {
    totals.set(r.title, (totals.get(r.title) || 0) + r.units);
  });
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);

  const select = $("productSelect");
  const previous = select.value;
  select.innerHTML = ranked
    .map(([title, units]) => `<option value="${escapeHtml(title)}">${escapeHtml(title)} (${units})</option>`)
    .join("");

  if (ranked.some(([title]) => title === previous)) {
    select.value = previous;
  }
}

function renderSizesView() {
  const product = $("productSelect").value;
  $("chartTitle").textContent = product ? "Talles vendidos" : "Talles";
  $("lbNameHead").textContent = "Talle";

  if (!product) {
    renderChart([]);
    renderLeaderboard([]);
    return;
  }

  const totals = new Map();
  currentFiltered
    .filter((r) => r.title === product)
    .forEach((r) => {
      const key = r.talle || "Sin talle";
      totals.set(key, (totals.get(key) || 0) + r.units);
    });

  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  renderChart(ranked);
  renderLeaderboard(ranked);
}

function renderChart(ranked) {
  const canvas = $("mainChart");
  $("chartEmpty").hidden = ranked.length > 0;
  canvas.style.display = ranked.length ? "block" : "none";
  if (chartInstance) chartInstance.destroy();
  if (!ranked.length) return;

  const labels = ranked.map(([title]) => (title.length > 28 ? title.slice(0, 26) + "…" : title));
  const values = ranked.map(([, units]) => units);

  const palette = ["#D6FF3F", "#A8CC2E", "#7FD0F5", "#F5F8FA", "#FF9E6B", "#C89BFF", "#66E0C3", "#FFD86B", "#FF6B5E", "#8FA8C4"];

  const config =
    currentChartType === "bar"
      ? {
          type: "bar",
          data: { labels, datasets: [{ data: values, backgroundColor: "#D6FF3F", borderRadius: 5, maxBarThickness: 26 }] },
          options: {
            indexAxis: "y",
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
              x: { ticks: { color: "#9FC1D9" }, grid: { color: "rgba(255,255,255,0.06)" } },
              y: { ticks: { color: "#F5F8FA", font: { size: 11 } }, grid: { display: false } },
            },
          },
        }
      : {
          type: "doughnut",
          data: { labels, datasets: [{ data: values, backgroundColor: palette }] },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { position: "bottom", labels: { color: "#F5F8FA", boxWidth: 10, font: { size: 10 } } },
            },
          },
        };

  chartInstance = new Chart(canvas, config);
}

function renderLeaderboard(ranked) {
  const el = $("leaderboard");
  el.innerHTML = "";
  ranked.forEach(([title, units], i) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="lb-num">${i + 1}</span>
      <span class="lb-title">${escapeHtml(title)}</span>
      <span class="lb-val">${units}</span>`;
    el.appendChild(li);
  });
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

document.querySelectorAll("#chartSegmented .seg").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("#chartSegmented .seg").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    currentChartType = btn.dataset.chart;
    renderForCurrentFilters();
  });
});

// ============================================================
// INIT
// ============================================================
window.addEventListener("load", () => {
  renderFilterControls();
  // GIS se carga async; esperamos a que esté disponible
  const waitForGis = setInterval(() => {
    if (window.google && google.accounts && google.accounts.oauth2) {
      clearInterval(waitForGis);
      initAuth();
    }
  }, 100);
});
