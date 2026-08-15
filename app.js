/* ---------------------------------------------------------
   Waymark — fully local run/hike/bike logger
   No accounts, no analytics, no network calls except map tiles.
--------------------------------------------------------- */

const DB_NAME = "waymark";
const DB_VERSION = 1;
const STORE = "entries";

let db;
let map, liveLine, drawLine, userMarker;
let mode = "idle"; // idle | recording | paused | drawing
let recordPoints = []; // {lat, lng, t}
let drawPoints = [];   // {lat, lng}
let watchId = null;
let startTime = null;
let elapsedBeforePause = 0;
let timerInterval = null;

const el = (id) => document.getElementById(id);

/* ---------------- IndexedDB ---------------- */

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const database = req.result;
      if (!database.objectStoreNames.contains(STORE)) {
        const store = database.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function saveEntry(entry) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function deleteEntry(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function getAllEntries() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => b.createdAt - a.createdAt));
    req.onerror = () => reject(req.error);
  });
}

/* ---------------- Map setup ---------------- */

function initMap() {
  map = L.map("map", { zoomControl: false, attributionControl: true }).setView([51.6214, -3.9436], 13); // Swansea fallback
  L.control.zoom({ position: "bottomright" }).addTo(map);

  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);

  liveLine = L.polyline([], { color: "#A8432B", weight: 4 }).addTo(map);
  drawLine = L.polyline([], { color: "#C08A2E", weight: 4, dashArray: "2 8", lineCap: "round" }).addTo(map);

  map.on("click", (e) => {
    if (mode === "drawing") {
      addDrawPoint(e.latlng.lat, e.latlng.lng);
    }
  });

  centerOnUser();
}

function centerOnUser() {
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      map.setView([pos.coords.latitude, pos.coords.longitude], 15);
      placeUserMarker(pos.coords.latitude, pos.coords.longitude);
    },
    () => {},
    { enableHighAccuracy: true, timeout: 8000 }
  );
}

function placeUserMarker(lat, lng) {
  const icon = L.divIcon({ className: "waypoint-dot", iconSize: [10, 10] });
  if (userMarker) {
    userMarker.setLatLng([lat, lng]);
  } else {
    userMarker = L.marker([lat, lng], { icon }).addTo(map);
  }
}

/* ---------------- Geometry helpers ---------------- */

function haversine(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function totalDistance(points) {
  let d = 0;
  for (let i = 1; i < points.length; i++) d += haversine(points[i - 1], points[i]);
  return d; // meters
}

function fmtTime(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function fmtPace(distM, ms) {
  if (distM < 20) return "—";
  const minPerKm = ms / 60000 / (distM / 1000);
  if (!isFinite(minPerKm) || minPerKm <= 0) return "—";
  const m = Math.floor(minPerKm);
  const s = Math.round((minPerKm - m) * 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/* ---------------- Recording (GPS run/hike/bike) ---------------- */

function startRecording() {
  mode = "recording";
  recordPoints = [];
  elapsedBeforePause = 0;
  startTime = Date.now();
  liveLine.setLatLngs([]);

  el("idleControls").classList.add("hidden");
  el("recordingControls").classList.remove("hidden");
  el("readout").classList.remove("hidden");
  el("pauseRunBtn").textContent = "Pause";

  timerInterval = setInterval(updateReadout, 1000);

  watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true,
    maximumAge: 1000,
    timeout: 10000
  });

  showToast("Recording started");
}

function onPosition(pos) {
  const p = { lat: pos.coords.latitude, lng: pos.coords.longitude, t: Date.now() };
  recordPoints.push(p);
  liveLine.addLatLng([p.lat, p.lng]);
  placeUserMarker(p.lat, p.lng);
  if (recordPoints.length < 4) map.panTo([p.lat, p.lng]);
  updateReadout();
}

function onPositionError(err) {
  showToast("GPS signal lost — keep moving into open sky");
}

function togglePause() {
  if (mode === "recording") {
    mode = "paused";
    navigator.geolocation.clearWatch(watchId);
    clearInterval(timerInterval);
    elapsedBeforePause += Date.now() - startTime;
    el("pauseRunBtn").textContent = "Resume";
    showToast("Paused");
  } else if (mode === "paused") {
    mode = "recording";
    startTime = Date.now();
    timerInterval = setInterval(updateReadout, 1000);
    watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
      enableHighAccuracy: true,
      maximumAge: 1000,
      timeout: 10000
    });
    el("pauseRunBtn").textContent = "Pause";
    showToast("Resumed");
  }
}

function currentElapsed() {
  if (mode === "recording") return elapsedBeforePause + (Date.now() - startTime);
  return elapsedBeforePause;
}

function updateReadout() {
  const distM = totalDistance(recordPoints);
  const ms = currentElapsed();
  el("statDistance").innerHTML = (distM / 1000).toFixed(2) + "<small>km</small>";
  el("statTime").textContent = fmtTime(ms);
  el("statPace").innerHTML = fmtPace(distM, ms) + "<small>/km</small>";
}

function stopRecording() {
  if (mode === "recording") {
    elapsedBeforePause += Date.now() - startTime;
  }
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  clearInterval(timerInterval);
  mode = "idle";

  el("recordingControls").classList.add("hidden");
  el("idleControls").classList.remove("hidden");

  if (recordPoints.length < 2) {
    showToast("Too short to save");
    resetRecordingUI();
    return;
  }

  openSaveModal("run");
}

function resetRecordingUI() {
  el("readout").classList.add("hidden");
  liveLine.setLatLngs([]);
  recordPoints = [];
}

/* ---------------- Drawing planned routes ---------------- */

function startDrawing() {
  mode = "drawing";
  drawPoints = [];
  drawLine.setLatLngs([]);
  el("idleControls").classList.add("hidden");
  el("drawingControls").classList.remove("hidden");
  el("drawBanner").classList.remove("hidden");
}

function addDrawPoint(lat, lng) {
  drawPoints.push({ lat, lng });
  drawLine.setLatLngs(drawPoints.map((p) => [p.lat, p.lng]));
}

function undoDrawPoint() {
  drawPoints.pop();
  drawLine.setLatLngs(drawPoints.map((p) => [p.lat, p.lng]));
}

function cancelDrawing() {
  mode = "idle";
  drawPoints = [];
  drawLine.setLatLngs([]);
  el("drawingControls").classList.add("hidden");
  el("idleControls").classList.remove("hidden");
  el("drawBanner").classList.add("hidden");
}

function finishDrawing() {
  if (drawPoints.length < 2) {
    showToast("Add at least two points");
    return;
  }
  el("drawBanner").classList.add("hidden");
  el("drawingControls").classList.add("hidden");
  el("idleControls").classList.remove("hidden");
  openSaveModal("planned-route");
}

/* ---------------- Save modal ---------------- */

let pendingKind = null; // "run" | "planned-route"

function openSaveModal(kind) {
  pendingKind = kind;
  const points = kind === "run" ? recordPoints : drawPoints;
  const distM = totalDistance(points);
  const ms = kind === "run" ? currentElapsed() : null;

  el("saveModalTitle").textContent = kind === "run" ? "Save run" : "Save planned route";
  el("saveTypeSelect").value = kind === "run" ? "run" : "hike";
  el("saveNameInput").value = "";

  let summary = `${(distM / 1000).toFixed(2)} km`;
  if (ms) summary += ` · ${fmtTime(ms)} · ${fmtPace(distM, ms)} /km`;
  summary += ` · ${points.length} points`;
  el("saveSummary").textContent = summary;

  el("saveModal").classList.remove("hidden");
}

function closeSaveModal() {
  el("saveModal").classList.add("hidden");
}

async function confirmSave() {
  const points = pendingKind === "run" ? recordPoints : drawPoints;
  const distM = totalDistance(points);
  const name = el("saveNameInput").value.trim() || (pendingKind === "run" ? "Untitled run" : "Untitled route");
  const type = el("saveTypeSelect").value;

  const entry = {
    id: crypto.randomUUID(),
    kind: pendingKind, // run | planned-route
    name,
    type, // run | hike | bike
    createdAt: Date.now(),
    distanceM: distM,
    durationMs: pendingKind === "run" ? currentElapsed() : null,
    points
  };

  await saveEntry(entry);
  closeSaveModal();
  showToast("Saved to your log");

  if (pendingKind === "run") {
    resetRecordingUI();
  } else {
    drawPoints = [];
    drawLine.setLatLngs([]);
  }

  refreshHistory();
}

function discardEntry() {
  closeSaveModal();
  if (pendingKind === "run") {
    resetRecordingUI();
  } else {
    drawPoints = [];
    drawLine.setLatLngs([]);
  }
  showToast("Discarded");
}

/* ---------------- History drawer ---------------- */

let displayLayer = null;

async function refreshHistory() {
  const entries = await getAllEntries();
  const list = el("historyList");
  list.innerHTML = "";

  if (entries.length === 0) {
    el("historyEmpty").classList.remove("hidden");
  } else {
    el("historyEmpty").classList.add("hidden");
  }

  for (const entry of entries) {
    const li = document.createElement("li");
    li.className = "history-item";

    const date = new Date(entry.createdAt);
    const dateStr = date.toLocaleDateString(undefined, { day: "numeric", month: "short" });

    let meta = `${(entry.distanceM / 1000).toFixed(2)} km`;
    if (entry.durationMs) meta += ` · ${fmtTime(entry.durationMs)} · ${fmtPace(entry.distanceM, entry.durationMs)} /km`;
    meta += ` · ${dateStr}`;

    li.innerHTML = `
      <div class="history-item-top">
        <span class="history-item-name">${escapeHtml(entry.name)}</span>
        <span class="history-item-type">${entry.type}</span>
      </div>
      <div class="history-item-meta">${meta}</div>
      <div class="history-item-actions">
        <button data-action="view">View</button>
        <button data-action="export">Export GPX</button>
        <button data-action="delete" class="danger">Delete</button>
      </div>
    `;

    li.querySelector('[data-action="view"]').onclick = () => viewEntry(entry);
    li.querySelector('[data-action="export"]').onclick = () => exportGPX(entry);
    li.querySelector('[data-action="delete"]').onclick = () => onDeleteEntry(entry.id);

    list.appendChild(li);
  }
}

function viewEntry(entry) {
  closeHistory();
  if (displayLayer) map.removeLayer(displayLayer);
  const color = entry.kind === "run" ? "#A8432B" : "#C08A2E";
  const latlngs = entry.points.map((p) => [p.lat, p.lng]);
  displayLayer = L.polyline(latlngs, { color, weight: 4 }).addTo(map);
  map.fitBounds(displayLayer.getBounds(), { padding: [40, 40] });
}

async function onDeleteEntry(id) {
  await deleteEntry(id);
  refreshHistory();
  showToast("Deleted");
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

/* ---------------- GPX export ---------------- */

function exportGPX(entry) {
  const trkpts = entry.points
    .map((p) => {
      const timeAttr = p.t ? `<time>${new Date(p.t).toISOString()}</time>` : "";
      return `      <trkpt lat="${p.lat}" lon="${p.lng}">${timeAttr}</trkpt>`;
    })
    .join("\n");

  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Waymark" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${escapeXml(entry.name)}</name>
    <type>${entry.type}</type>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`;

  const blob = new Blob([gpx], { type: "application/gpx+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${entry.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.gpx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function escapeXml(str) {
  return str.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c]));
}

/* ---------------- History drawer open/close ---------------- */

function openHistory() {
  refreshHistory();
  el("historyDrawer").classList.remove("hidden");
}
function closeHistory() {
  el("historyDrawer").classList.add("hidden");
}

/* ---------------- Toast ---------------- */

let toastTimer;
function showToast(msg) {
  const t = el("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2200);
}

/* ---------------- Status line ---------------- */

function updateStatusLine() {
  const online = navigator.onLine;
  el("statusline").textContent = online ? "Online · map tiles caching for offline" : "Offline · using cached tiles & local data";
}

/* ---------------- Wire up UI ---------------- */

function wireUI() {
  el("startRunBtn").onclick = startRecording;
  el("pauseRunBtn").onclick = togglePause;
  el("stopRunBtn").onclick = stopRecording;

  el("drawRouteBtn").onclick = startDrawing;
  el("undoPointBtn").onclick = undoDrawPoint;
  el("finishDrawBtn").onclick = finishDrawing;
  el("cancelDrawBtn").onclick = cancelDrawing;

  el("discardBtn").onclick = discardEntry;
  el("confirmSaveBtn").onclick = confirmSave;

  el("historyBtn").onclick = openHistory;
  el("closeHistoryBtn").onclick = closeHistory;

  window.addEventListener("online", updateStatusLine);
  window.addEventListener("offline", updateStatusLine);
}

/* ---------------- Boot ---------------- */

async function boot() {
  initMap();
  wireUI();
  updateStatusLine();

  try {
    db = await openDB();
    if (navigator.storage && navigator.storage.persist) {
      const persisted = await navigator.storage.persist();
      if (!persisted) showToast("Tip: install to home screen so your log can't be cleared");
    }
  } catch (e) {
    showToast("Local storage unavailable in this browser");
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

boot();
