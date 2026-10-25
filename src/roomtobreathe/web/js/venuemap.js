// Draw a venue on a real map: search the place, draw each zone's outline, and draw a short line across
// each gate's opening. Areas and widths are measured from the drawing, so nobody has to guess them.
// OpenStreetMap needs no account or key, which is what lets any local body use this for free.
import { areaM2, gateSides, lengthM, mergePlaces, parseLocation, queryVariants } from "./geo.js";
import { fetchTiles } from "./tiles.js";
import { inBrowserEngine } from "./whatif.js";

const LEAFLET = "https://unpkg.com/leaflet@1.9.4/dist/";
const COLORS = ["#2456d6", "#e36b0a", "#2f9e5b", "#9b3fd1", "#d42a2a", "#0e8c8c", "#a8730a", "#5d6673"];
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let L = null, map = null, layers = null, draft = null, onChange = null, changedOnly = null;
let mode = null;      // null | "zone" | "gate" | "adjust"
let pts = [];         // points placed while drawing
let sketch = null;    // the shape being drawn

function load(tag, attrs) {
  return new Promise((ok, fail) => {
    const el = document.createElement(tag);
    Object.assign(el, attrs);
    el.onload = ok; el.onerror = () => fail(new Error(`could not load ${attrs.src || attrs.href}`));
    document.head.appendChild(el);
  });
}
export async function loadLibs() {
  if (window.L) return window.L;
  await load("link", { rel: "stylesheet", href: LEAFLET + "leaflet.css" });
  await load("script", { src: LEAFLET + "leaflet.js" });
  return window.L;
}

const help = (t) => { $("#wi-map-help").textContent = t; };
const ll = (latlng) => [Math.round(latlng.lat * 1e7) / 1e7, Math.round(latlng.lng * 1e7) / 1e7];

function label(z, i) {
  return `${z.name || `Zone ${i + 1}`} · ${Math.round(areaM2(draft.origin, z.ll)).toLocaleString()} m²`;
}

function redraw() {
  if (!map) return;
  layers.clearLayers();
  draft.zones.forEach((z, i) => {
    if (!z.ll?.length) return;
    const poly = L.polygon(z.ll, { color: COLORS[i % COLORS.length], weight: 2, fillOpacity: 0.25 })
      .bindTooltip(label(z, i), { permanent: true, direction: "center", className: "map-label" }).addTo(layers);
    if (mode !== "adjust") return;
    z.ll.forEach((p, k) => { // drag a corner to adjust the zone; its area is re-measured
      L.marker(p, { draggable: true, icon: L.divIcon({ className: "vertex", iconSize: [18, 18] }) })
        .on("drag", (e) => { z.ll[k] = ll(e.latlng); poly.setLatLngs(z.ll); poly.setTooltipContent(label(z, i)); })
        .on("dragend", () => { z.area = String(Math.round(areaM2(draft.origin, z.ll))); changedOnly(); })
        .addTo(layers);
    });
  });
  draft.gates.forEach((g, i) => {
    if (!g.ll?.length) return;
    L.polyline(g.ll, { color: g.closed ? "#d42a2a" : "#111", weight: 6, dashArray: g.closed ? "6 6" : null })
      .bindTooltip(`G${i + 1} ${g.name} · ${g.width} m`, { direction: "top" }).addTo(layers);
  });
}

function addZone(latlngs) {
  const pts = latlngs.map(ll);
  if (!draft.origin) draft.origin = pts[0];
  const n = draft.zones.length + 1;
  draft.zones.push({ name: `Zone ${n}`, area: String(Math.round(areaM2(draft.origin, pts))), usable: 100, ll: pts });
  help(`Zone ${n} added: ${Math.round(areaM2(draft.origin, pts)).toLocaleString()} m². Name it in the list below. Draw the next zone, or draw the gates.`);
  onChange();
}

function addGate(a, b) {
  const pts = [ll(a), ll(b)];
  if (!draft.origin) draft.origin = pts[0];
  const width = Math.round(lengthM(draft.origin, pts) * 10) / 10;
  const zonesLL = draft.zones.map((z) => z.ll || []);
  let [s1, s2] = gateSides(draft.origin, pts, zonesLL);
  if (s1 === s2) { // drawn inside one zone or outside everything: let the person choose
    help("That line does not cross a zone edge. Draw it across the opening, from one side of the gap to the other.");
    return;
  }
  // Direction people walk: the first opening to outside is taken as the entry, later ones as exits.
  const touchesOutside = s1 === "outside" || s2 === "outside";
  const hasEntry = draft.gates.some((g) => g.from === "outside");
  if (touchesOutside) {
    const zone = s1 === "outside" ? s2 : s1;
    [s1, s2] = hasEntry ? [zone, "outside"] : ["outside", zone];
  }
  const n = draft.gates.length + 1;
  draft.gates.push({ name: touchesOutside ? (hasEntry ? `Exit ${n}` : "Main entry") : `Gate ${n}`, from: s1, to: s2,
    width, stairs: false, closed: false, ll: pts });
  help(`Gate G${n} added: ${width} m wide. Check its direction ("From → To") in the list below.`);
  onChange();
}

function setMode(m) {
  if (m) idle(false);
  mode = m; pts = [];
  if (sketch) { map.removeLayer(sketch); sketch = null; }
  map.getContainer().classList.toggle("drawing", m === "zone" || m === "gate");
  if (m) map.getContainer().scrollIntoView({ block: "nearest" }); // fully in view, not under the sticky header
  $("#wi-zone-tools").hidden = m !== "zone";
  $("#wi-adjust").textContent = m === "adjust" ? "Done adjusting" : "Adjust shapes";
  redraw();
}

function onMapClick(e) {
  if (mode !== "zone" && mode !== "gate") return;
  pts.push(e.latlng);
  if (sketch) map.removeLayer(sketch);
  if (mode === "gate") {
    if (pts.length === 1) {
      sketch = L.circleMarker(pts[0], { radius: 6, color: "#111" }).addTo(map);
      help("Now tap the other side of the opening.");
      return;
    }
    const [a, b] = pts;
    setMode(null);
    addGate(a, b);
    return;
  }
  sketch = L.polygon(pts, { color: "#2456d6", dashArray: "4 4", fillOpacity: 0.15 }).addTo(map);
  help(pts.length < 3 ? `Corner ${pts.length} placed. Keep tapping round the zone's edge.`
    : `${pts.length} corners, ${Math.round(areaM2(draft.origin || ll(pts[0]), pts.map(ll))).toLocaleString()} m² so far. `
      + "Tap more corners, or press Finish zone.");
}

function finishZone() {
  if (pts.length < 3) { help("A zone needs at least 3 corners."); return; }
  const done = pts;
  setMode(null);
  addZone(done);
}

// Two free OpenStreetMap search services. Only the typed text (and the map's centre, to prefer nearby
// places) is sent.
async function nominatim(q) {
  const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=6&q=${encodeURIComponent(q)}`);
  return (await r.json()).map((h) => {
    const parts = h.display_name.split(",").map((x) => x.trim());
    return { name: parts[0], where: parts.slice(1, 4).join(", "), lat: Number(h.lat), lon: Number(h.lon),
      bounds: h.boundingbox?.map(Number), osm: h.osm_type && h.osm_id ? h.osm_type[0].toUpperCase() + h.osm_id : null,
      kind: `${h.class}=${h.type}` };
  });
}
async function photon(q) {
  const c = map.getCenter();
  const bias = map.getZoom() >= 5 ? `&lat=${c.lat.toFixed(3)}&lon=${c.lng.toFixed(3)}` : "";
  const r = await fetch(`https://photon.komoot.io/api/?limit=6${bias}&q=${encodeURIComponent(q)}`);
  return (await r.json()).features.map((f) => {
    const p = f.properties, [lon, lat] = f.geometry.coordinates;
    const where = [p.street, p.district || p.locality, p.city, p.state, p.country].filter((x, i, a) => x && a.indexOf(x) === i);
    const [w, n, e, s] = p.extent || [];
    return { name: p.name || where[0], where: where.slice(0, 3).join(", "), lat, lon, bounds: p.extent ? [s, n, w, e] : null,
      osm: p.osm_type && p.osm_id ? p.osm_type + p.osm_id : null, kind: `${p.osm_key}=${p.osm_value}` };
  });
}

// Small map with a hint until there is a place to show.
function idle(on) {
  const el = $("#wi-map");
  if (!el) return;
  el.classList.toggle("idle", on);
  el.querySelector(".map-hint")?.remove();
  if (on) el.insertAdjacentHTML("beforeend", `<div class="map-hint"><span>Search for your venue above, or press Where am I</span></div>`);
  setTimeout(() => map?.invalidateSize(), 300);
}

function goTo(place) {
  idle(false);
  if (place.bounds && place.bounds.every(Number.isFinite) && place.bounds[0] !== place.bounds[1]) {
    const [s, n, w, e] = place.bounds;
    map.fitBounds([[s, w], [n, e]], { maxZoom: 18 });
  } else {
    map.setView([place.lat, place.lon], 17);
  }
  if (!draft.name && place.name) { draft.name = place.name; changedOnly(); }
  $("#wi-map-results").innerHTML = "";
  const label = [place.name, place.where].filter(Boolean).join(", ");
  help(`${label}. Looking for the ground's outline…`);
  autoOutline(place, label).catch(() => {
    help(`${label}. Check it is the right place, then press Draw a zone and tap the corners of the area where people will stand.`);
  });
}

// ------------------------------------------------------------------ the venue, found for you
// OpenStreetMap usually knows the outline of a stadium, park, maidan or temple compound. Ask Nominatim for
// it, then let the engine find the ways in (where streets and paths cross the outline), so the customer
// gets a ready venue in one click instead of drawing polygons and gates.
const MIN_AREA = 300, MAX_AREA = 3e6;
function ringOf(hit) {
  const g = hit?.geojson;
  if (!g) return null;
  const coords = g.type === "Polygon" ? g.coordinates[0]
    : g.type === "MultiPolygon" ? g.coordinates.map((p) => p[0]).sort((a, b) => b.length - a.length)[0] : null;
  return coords ? coords.map(([lon, lat]) => [Math.round(lat * 1e7) / 1e7, Math.round(lon * 1e7) / 1e7]) : null;
}
async function nominatimJson(path) {
  const r = await fetch(`https://nominatim.openstreetmap.org/${path}&format=json&polygon_geojson=1&polygon_threshold=0.00001`);
  if (!r.ok) throw new Error(`search ${r.status}`);
  return r.json();
}
async function findOutline(place) {
  if (place.osm && /^[WR]/.test(place.osm)) {
    const [hit] = await nominatimJson(`lookup?osm_ids=${place.osm}`);
    const ring = ringOf(hit);
    if (ring) return ring;
  }
  return ringOf(await nominatimJson(`reverse?zoom=17&lat=${place.lat}&lon=${place.lon}`));
}

let preview = null;
async function autoOutline(place, label) {
  const ring = await findOutline(place);
  if (!ring || ring.length < 4) throw new Error("no outline");
  const origin = [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
  const area = areaM2(origin, ring);
  if (area < MIN_AREA || area > MAX_AREA) throw new Error("outline too small or too large");
  if (preview) map.removeLayer(preview);
  preview = L.layerGroup().addTo(map);
  L.polygon(ring, { color: "#ff9900", weight: 3, dashArray: "6 5", fillOpacity: 0.12 }).addTo(preview);
  map.fitBounds(L.polygon(ring).getBounds(), { padding: [24, 24], maxZoom: 18 });
  const box = $("#wi-found");
  box.hidden = false;
  box.innerHTML = `<div class="found-head"><span class="found-pin" aria-hidden="true">✓</span><div><b>Found ${esc(place.name || "the ground")}</b>
    <div class="small muted">${Math.round(area).toLocaleString()} m² from OpenStreetMap · finding the ways in…</div></div></div>`;
  let gates = { gates: [], notes: [] };
  try {
    const { tiles } = await fetchTiles(origin[0], origin[1], 700);
    gates = await inBrowserEngine(null, { ring, origin, name: place.name || "", radius_m: 700 }, "detect_gates", { tiles });
  } catch (err) {
    gates.notes = [`The ways in could not be found automatically (${err.message}). Draw them on the map.`];
  }
  for (const g of gates.gates) {
    L.polyline(g.line, { color: g.guessed ? "#c45500" : "#111", weight: 7, dashArray: g.guessed ? "4 4" : null })
      .bindTooltip(`${g.name} · ${g.width_m} m${g.guessed ? " (guess)" : ""}`).addTo(preview);
  }
  const n = gates.gates.length;
  box.innerHTML = `<div class="found-head"><span class="found-pin" aria-hidden="true">✓</span><div><b>Found ${esc(place.name || "the ground")}</b>
      <div class="small muted">${Math.round(area).toLocaleString()} m² · ${n ? `${n} way${n === 1 ? "" : "s"} in` : "no ways in found"}
        ${gates.gates.some((g) => g.guessed) ? "(guessed: move them to the real gates)" : n ? "(widths estimated)" : ""}</div></div></div>
    <div class="btns"><button type="button" class="btn-buy" id="wi-use-found">Use this venue</button>
      <button type="button" id="wi-skip-found">Draw it myself</button></div>
    ${gates.notes?.length ? `<p class="small muted">${esc(gates.notes.join(" "))}</p>` : ""}`;
  help(`${label}.`);
  $("#wi-use-found").onclick = () => {
    draft.origin = origin;
    draft.name = draft.name || place.name || "";
    draft.zones = [{ name: place.name || "Ground", area: String(Math.round(area)), usable: 100, ll: ring }];
    draft.gates = gates.gates.map((g, i) => ({ name: g.name, from: i === 0 ? "outside" : 0, to: i === 0 ? 0 : "outside",
      width: g.width_m, stairs: false, closed: false, ll: g.line, guessed: g.guessed, estimated: true }));
    map.removeLayer(preview); preview = null;
    box.hidden = true;
    help(`${place.name || "The venue"} is set: ${Math.round(area).toLocaleString()} m², ${n} way${n === 1 ? "" : "s"} in. `
      + "Drag corners with Adjust shapes, or add gates, if anything differs on the ground.");
    onChange();
    document.dispatchEvent(new CustomEvent("rtb:venue-ready"));
  };
  $("#wi-skip-found").onclick = () => {
    map.removeLayer(preview); preview = null;
    box.hidden = true;
    help(`${label}. Press Draw a zone and tap the corners of the area where people will stand.`);
  };
}

async function search(e) {
  e.preventDefault();
  const q = $("#wi-map-q").value.trim();
  const list = $("#wi-map-results");
  list.innerHTML = "";
  if (!q) return;
  const at = parseLocation(q);
  if (at) { goTo({ name: "", where: `Pinned at ${at[0]}, ${at[1]}`, lat: at[0], lon: at[1] }); return; }
  if (/goo\.gl|maps\.app/.test(q)) {
    help("Short Google Maps links cannot be read here. Open the link, then copy the long address from the browser bar, or the coordinates.");
    return;
  }
  help("Searching…");
  const variants = queryVariants(q);
  const tries = variants.flatMap((v) => [photon(v), nominatim(v)]);
  const found = await Promise.allSettled(tries);
  const places = mergePlaces(found.filter((f) => f.status === "fulfilled").map((f) => f.value));
  if (!places.length) {
    help(found.every((f) => f.status === "rejected")
      ? "Search is not available right now. Pan and zoom the map to the place, or paste its coordinates or a Google Maps link."
      : `Nothing called "${q}" found. Try a nearby landmark or road, or paste a Google Maps link to the place.`);
    return;
  }
  if (places.length === 1) { goTo(places[0]); return; }
  // Several matches but only one is a place where crowds gather (a stadium, not the station named after it):
  // pick it, and keep the others one tap away.
  const venues = places.filter((p) => VENUE_KIND.test(p.kind || ""));
  const distinct = venues.filter((p, i) => venues.findIndex((q) => Math.hypot(q.lat - p.lat, q.lon - p.lon) < 0.002) === i);
  if (distinct.length === 1) {
    goTo(distinct[0]);
    list.innerHTML = `<li class="small muted">Not this one? <button type="button" class="link" id="wi-other">See all ${places.length} matches</button></li>`;
    $("#wi-other").onclick = () => showPlaces(places, q);
    return;
  }
  showPlaces(places, q);
}

const VENUE_KIND = /(stadium|sports_centre|pitch|park|recreation_ground|fairground|festival|showground|common|square|place_of_worship|temple|mosque|church|gurudwara|marketplace|exhibition|events_venue|arena|amphitheatre|maidan|ground|garden)/;

function showPlaces(places, q) {
  const list = $("#wi-map-results");
  // Grounds, parks, stadiums and temples first: those are where crowds gather.
  places = [...places].sort((a, b) => VENUE_KIND.test(b.kind || "") - VENUE_KIND.test(a.kind || ""));
  help(q.includes(",") || q.trim().split(/\s+/).length >= 3 ? `${places.length} places match. Pick yours:`
    : `${places.length} places match. Pick yours, or add the city, e.g. "${q}, Kolkata".`);
  list.innerHTML = places.map((p, i) => `<li><button type="button" data-i="${i}"><b>${esc(p.name)}</b><span>${esc(p.where)}</span></button></li>`).join("")
    + `<li class="small muted">Not listed? Search a nearby landmark, or paste a Google Maps link.</li>`;
  list.onclick = (ev) => {
    const b = ev.target.closest("button[data-i]");
    if (b) goTo(places[Number(b.dataset.i)]);
  };
}

let mapIsReady;
const mapReady = new Promise((resolve) => { mapIsReady = resolve; });

// Search from anywhere (the header search box): runs once the map has loaded.
export async function searchPlace(q) {
  await mapReady;
  $("#wi-map-q").value = q;
  $("#wi-map-panel").scrollIntoView({ block: "start", behavior: "smooth" });
  await search({ preventDefault() {} });
}

export async function openMap(state, changed) {
  draft = state; changedOnly = changed; onChange = () => { changed(); redraw(); };
  $("#wi-map-panel").hidden = false;
  if (map) { map.invalidateSize(); redraw(); return; }
  help("Loading the map…");
  L = await loadLibs();
  // Scrolling the page must not zoom the map: wheel-zoom only after the map is clicked.
  map = L.map("wi-map", { zoomControl: true, scrollWheelZoom: false }).setView(draft.origin || [20, 0], draft.origin ? 17 : 2);
  map.on("click", () => map.scrollWheelZoom.enable());
  map.on("mouseout", () => map.scrollWheelZoom.disable());
  if (!draft.origin && !draft.zones.length) idle(true);
  const streets = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, className: "street-tiles", attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' });
  const satellite = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 19, attribution: "Imagery © Esri, Maxar, Earthstar Geographics" });
  satellite.addTo(map);
  L.control.layers({ Satellite: satellite, Streets: streets }, null, { position: "topright" }).addTo(map);
  layers = L.layerGroup().addTo(map);
  map.on("click", onMapClick);
  map.doubleClickZoom.disable(); // fast taps while drawing must not zoom
  $("#wi-map-search").addEventListener("submit", search);
  mapIsReady();
  $("#wi-draw-zone").addEventListener("click", () => {
    setMode("zone");
    help("Tap each corner of the zone's edge in turn, then press Finish zone.");
  });
  $("#wi-zone-done").addEventListener("click", finishZone);
  $("#wi-zone-undo").addEventListener("click", () => {
    pts.pop();
    if (sketch) { map.removeLayer(sketch); sketch = null; }
    if (pts.length) sketch = L.polygon(pts, { color: "#2456d6", dashArray: "4 4", fillOpacity: 0.15 }).addTo(map);
    help(`${pts.length} corners.`);
  });
  $("#wi-zone-cancel").addEventListener("click", () => { setMode(null); help("Cancelled."); });
  $("#wi-draw-gate").addEventListener("click", () => {
    setMode("gate");
    help("Tap one side of the opening, at its narrowest point.");
  });
  $("#wi-adjust").addEventListener("click", () => {
    setMode(mode === "adjust" ? null : "adjust");
    help(mode === "adjust" ? "Drag the white corners. Press Done adjusting when finished." : "Shapes saved.");
  });
  $("#wi-locate").addEventListener("click", () => {
    help("Finding you…");
    map.locate({ setView: true, maxZoom: 17 });
  });
  map.on("locationfound", () => { idle(false); help("This is where you are. Draw the area where people will stand."); });
  map.on("locationerror", () => help("Location not available. Search for the place instead."));
  help(draft.origin ? "Your venue. Press Adjust shapes to move corners, or draw more zones and gates."
    : "Type the venue's name in the search box at the top: we find its outline and its ways in for you.");
  redraw();
  const drawn = draft.zones.flatMap((z) => z.ll || []).concat(draft.gates.flatMap((g) => g.ll || []));
  if (drawn.length) map.fitBounds(drawn, { padding: [30, 30], maxZoom: 19 });
}

export const refreshMap = () => redraw();
