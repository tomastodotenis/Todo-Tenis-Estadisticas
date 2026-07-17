// ============================================================
// CONFIGURACIÓN
// ============================================================
const CONFIG = {
  // Pegá acá la "Web app URL" que te da Apps Script al implementar
  // (Implementar > Nueva implementación > Aplicación web)
  BACKEND_URL: "https://script.google.com/macros/s/AKfycbwwSG3ilgzkhZTKVO45_KcLUIjHJCJ2Q4v51xueiZj0iC_-ykmUvV_neHvRCyaUVHo40w/exec",
};

// ============================================================
// ESTADO
// ============================================================
let allRecords = []; // {date: Date, title, talle, sku, units}
let currentPeriod = "day";
let currentChartType = "bar";
let currentView = "products";
let currentFiltered = [];
let chartInstance = null;

const $ = (id) => document.getElementById(id);

// ============================================================
// CARGA DE DATOS DESDE EL BACKEND
// ============================================================
async function loadData() {
  if (CONFIG.BACKEND_URL.includes("PEGÁ_ACÁ")) {
    setStatus(false, "Falta configurar la URL del backend en app.js (CONFIG.BACKEND_URL).");
    return;
  }
  setStatus(true, "Cargando datos...");
  $("syncBtn").disabled = true;
  $("syncBtn").textContent = "Actualizando...";

  try {
    const res = await fetch(CONFIG.BACKEND_URL);
    if (!res.ok) throw new Error(`Backend respondió ${res.status}`);
    const data = await res.json();

    allRecords = (data.records || []).map((r) => ({
      ...r,
      date: r.date ? new Date(r.date) : null,
    }));

    const lastSync = data.lastSync ? new Date(data.lastSync) : null;
    const lastSyncLabel = lastSync
      ? lastSync.toLocaleString("es-AR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
      : "—";

    setStatus(true, `Datos al día. Última actualización del servidor: ${lastSyncLabel}.`);
    $("cacheInfo").textContent = `${allRecords.length} filas de venta cargadas`;

    $("viewPanel").hidden = false;
    $("filtersPanel").hidden = false;
    $("chartPanel").hidden = false;
    $("tablePanel").hidden = false;

    renderForCurrentFilters();
  } catch (err) {
    console.error(err);
    setStatus(false, "No se pudo cargar: " + err.message);
  } finally {
    $("syncBtn").disabled = false;
    $("syncBtn").textContent = "Actualizar";
  }
}

function setStatus(ok, text) {
  $("statusDot").classList.toggle("on", ok);
  $("statusText").textContent = text;
}

$("syncBtn").addEventListener("click", loadData);

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
// VISTA: PRODUCTOS / TALLES
// ============================================================
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

// ============================================================
// GRÁFICO Y TABLA
// ============================================================
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
  loadData();
});
