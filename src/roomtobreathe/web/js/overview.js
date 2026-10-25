// "The area around the venue": crowd routes, traffic, emergency access and where to place every team.
// The computation is the Python engine (roomtobreathe.surroundings), on the control-room server or in this
// browser (Pyodide). Map data comes from OpenStreetMap's free Overpass servers and is cached in the browser.
import { parsePeople } from "./numbers.js";
import { fetchTiles } from "./tiles.js";
import { loadLibs } from "./venuemap.js";
import { inBrowserEngine, usingServer, venueForChecks } from "./whatif.js";

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const MIRRORS = [ // same list and order as roomtobreathe/surroundings/osm.py (why: see there)
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass-api.de/api/interpreter",
];
const ICON = { pass: "✓", warn: "!", fail: "✕" };
const ROLE_ICON = { "Police": "👮", "Traffic police": "🚦", "Steward": "🦺", "First-aid post": "⛑️", "Ambulance": "🚑",
  "Station staff": "🚉", "Fire tender": "🚒" };
const AGENCIES = ["Police", "Traffic police", "Health", "Organisers", "Transport operator", "Fire service"];
const LOS = { A: "#2f9e5b", B: "#2f9e5b", C: "#d7a300", D: "#e36b0a", E: "#d42a2a", F: "#8b0000" };
const RADIUS_M = 1500;
let last = null, map = null, groups = null, mapFile = null, lastOsm = null, lastVenueId = null;
const detailed = () => Boolean(document.querySelector("#ov-detailed")?.checked);

// ------------------------------------------------------------------ corrections
// People who walked the streets know better than the map: footpath widths (OpenStreetMap rarely has
// them), streets that will be closed to traffic, streets blocked by construction or a market. They are
// kept in this browser per venue, saved in the venue file, and used by every later plan.
const fixKey = (id) => `rtb:ov-fix:${id}`;
function loadFixes(id) { try { return JSON.parse(localStorage.getItem(fixKey(id)) || "{}"); } catch { return {}; } }
function saveFixes(id, fixes) { try { localStorage.setItem(fixKey(id), JSON.stringify(fixes)); } catch { /* private mode */ } }
export function correctionsFor(id) { return loadFixes(id); }

function withFixes(venue) {
  const fixes = { ...(venue.surroundings?.overrides || {}), ...loadFixes(venue.id) };
  return { ...venue, surroundings: { ...(venue.surroundings || {}), overrides: fixes } };
}

// A named street is corrected as a whole (OpenStreetMap splits streets into many segments);
// an unnamed lane by its segment.
const fixId = (p) => (p.street && !p.street.startsWith("unnamed") ? `name:${p.street}` : String(p.way));

function fixForm(p) {
  const fixes = loadFixes(lastVenueId), key = fixId(p), cur = fixes[key] || {};
  const el = document.createElement("form");
  el.className = "fix-form";
  el.innerHTML = `<b>${esc(p.street)}</b>
    <div class="small muted">${p.ppm_per_m} people per metre per minute at the busiest · level ${esc(p.los)}</div>
    <label class="small">Footpath width, both sides together (m)
      <input name="walk_width" type="number" min="0" step="0.5" value="${cur.walk_width ?? p.walk_width_m}"></label>
    ${p.width_estimated && cur.walk_width === undefined ? `<div class="small muted">Estimated from the street type: measure it if you can.</div>` : ""}
    ${p.drivable || p.closed_to_traffic ? `<label class="small"><input name="closed" type="checkbox"${cur.closed_to_traffic ? " checked" : ""}> Closed to traffic during the event</label>` : ""}
    <label class="small"><input name="blocked" type="checkbox"${cur.no_walk ? " checked" : ""}> Blocked for people on foot (works, market, locked)</label>
    <div class="small muted">${key.startsWith("name:") ? "Applies to the whole street." : "Applies to this stretch."}</div>
    <div class="btns"><button class="primary">Save correction</button>${fixes[key] ? `<button type="button" data-undo>Undo my correction</button>` : ""}</div>`;
  el.addEventListener("submit", (e) => {
    e.preventDefault();
    const f = new FormData(el), all = loadFixes(lastVenueId), fix = {};
    const w = Number(f.get("walk_width"));
    if (Number.isFinite(w) && Math.abs(w - p.walk_width_m) > 0.05) fix.walk_width = w;
    if (f.has("closed")) fix.closed_to_traffic = true;
    if (f.has("blocked")) fix.no_walk = true;
    if (Object.keys(fix).length) all[key] = { ...fix, street: p.street }; else delete all[key];
    saveFixes(lastVenueId, all);
    map?.closePopup();
    renderFixes();
  });
  el.querySelector("[data-undo]")?.addEventListener("click", () => {
    const all = loadFixes(lastVenueId);
    delete all[key];
    saveFixes(lastVenueId, all);
    map?.closePopup();
    renderFixes();
  });
  return el;
}

function renderFixes() {
  const box = $("#ov-fixes");
  if (!box) return;
  const fixes = loadFixes(lastVenueId), n = Object.keys(fixes).length;
  const describe = (f) => [f.walk_width !== undefined ? `footpath ${f.walk_width} m` : "", f.closed_to_traffic ? "closed to traffic" : "",
    f.no_walk ? "blocked for walkers" : ""].filter(Boolean).join(", ");
  box.innerHTML = n ? `<b>Your corrections (${n})</b><ul class="small">${Object.entries(fixes).map(([way, f]) =>
    `<li>${esc(f.street || `street ${way}`)}: ${esc(describe(f))} <button type="button" class="link" data-unfix="${esc(way)}">remove</button></li>`).join("")}</ul>
    <button type="button" class="primary" id="ov-replan">Re-plan with my corrections</button>`
    : `<span class="small muted">Tap a coloured street on the map to correct its footpath width, or mark it closed to traffic or blocked.</span>`;
  box.querySelectorAll("[data-unfix]").forEach((b) => b.addEventListener("click", () => {
    const all = loadFixes(lastVenueId);
    delete all[b.dataset.unfix];
    saveFixes(lastVenueId, all);
    renderFixes();
  }));
  $("#ov-replan")?.addEventListener("click", () => $("#ov-form").requestSubmit());
}

const status = (t) => { $("#ov-status").textContent = t; };

async function sha1(text) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const PART_NAMES = ["streets", "main roads further out", "stations, stops, car parks, hospitals, police and fire stations"]; // as in osm.py
const HEDGE_MS = 15_000; // if a server has not answered in 15 s, also ask the next one

// One query, hedged across the servers: the first good answer wins and the others are cancelled.
function fetchPart(query, onTry, first = 0) {
  return new Promise((resolve, reject) => {
    const ctls = [], errors = [];
    let next = 0, done = false, timer = null;
    const order = [...MIRRORS.slice(first % MIRRORS.length), ...MIRRORS.slice(0, first % MIRRORS.length)];
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); ctls.forEach((c) => c.abort()); fn(v); };
    const launch = () => {
      if (done || next >= MIRRORS.length) return;
      const url = order[next++], ctl = new AbortController();
      ctls.push(ctl);
      onTry?.(new URL(url).host);
      const t = setTimeout(() => ctl.abort(), 150_000);
      fetch(url, { method: "POST", body: new URLSearchParams({ data: query }), signal: ctl.signal })
        .then(async (r) => {
          if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
          const text = await r.text();
          if (!text.trimStart().startsWith("{") || !text.includes('"elements"')) throw new Error("not map data");
          finish(resolve, text);
        })
        .catch((e) => {
          if (done) return;
          errors.push(`${new URL(url).host}: ${e.name === "AbortError" ? "timed out" : e.message}`);
          if (errors.length === MIRRORS.length) finish(reject, new Error(errors.join("; ")));
          else { clearTimeout(timer); launch(); }
        })
        .finally(() => clearTimeout(t));
      clearTimeout(timer);
      timer = setTimeout(launch, HEDGE_MS);
    };
    launch();
  });
}

async function cached(key, make) {
  let cache = null;
  try { cache = await caches.open("rtb-osm-v2"); } catch { /* private mode or plain http */ }
  if (cache) {
    const hit = await cache.match(key).catch(() => null);
    if (hit && Date.now() - Number(hit.headers.get("x-saved") || 0) < 30 * 864e5) return hit.text();
  }
  const text = await make();
  if (cache) await cache.put(key, new Response(text, { headers: { "x-saved": String(Date.now()) } })).catch(() => {});
  return text;
}

// Streets change slowly, so each part is kept in this browser for 30 days. The three parts download in
// parallel; only the streets are essential, the rest is reported as missing if it fails.
async function fetchOsm(queries) {
  const state = queries.map(() => "waiting");
  const show = () => status(`Downloading from OpenStreetMap's free servers: ${PART_NAMES.map((n, i) => `${n} ${state[i]}`).join(" · ")}. This can take a minute or two.`);
  show();
  const results = await Promise.allSettled(queries.map(async (q, i) => {
    const text = await cached(`https://rtb.local/osm/${await sha1(q)}`, () => fetchPart(q, (host) => { state[i] = `(asking ${host})`; show(); }, i)); // each part starts on a different server
    state[i] = "✓"; show();
    return text;
  }));
  if (results[0].status === "rejected") {
    console.warn("Overpass:", results[0].reason.message); // which server said what, for whoever debugs it
    throw new Error("the free map servers are busy right now. Try again in a minute, or use a map file (below).");
  }
  return { parts: results.filter((r) => r.status === "fulfilled").map((r) => r.value),
    missing: results.map((r, i) => (r.status === "rejected" ? PART_NAMES[i] : null)).filter(Boolean) };
}

function readParams() {
  const f = new FormData($("#ov-form"));
  const a = new FormData($("#as-form"));
  const modes = {};
  for (const k of ["metro", "rail", "bus", "ferry", "car", "walk"]) {
    const v = Number(f.get(k));
    if (v > 0) modes[k] = v;
  }
  const arrival = Number(a.get("arrival_minutes")) || null;
  return {
    attendance: parsePeople(a.get("attendance")), modes, arrival_minutes: arrival,
    event_end_min: (arrival || 60) + Number(f.get("duration") || 120),
    public_level: Number(f.get("public_level") || 1), radius_m: RADIUS_M,
  };
}

async function run(e) {
  e.preventDefault();
  const { venue, problems } = venueForChecks();
  if (problems.length || !venue) { status(problems[0] || "First tell us where the event is (step 1)."); return; }
  if (!venue.origin) { status("Draw the venue on the map in step 1 (Find it on the map): the surroundings need its location."); return; }
  const p = readParams();
  if (!(p.attendance > 0)) { status("Type how many people you expect (step 2)."); return; }
  if (!Object.keys(p.modes).length) { status("Say how people travel: at least one share above 0."); return; }
  $("#ov-run").disabled = true;
  const t0 = performance.now();
  const planVenue = withFixes(venue);
  lastVenueId = venue.id;
  try {
    let r;
    if (usingServer()) {
      status("Downloading the streets and planning on the control-room server (the first time can take a few minutes)…");
      const resp = await fetch("api/overview", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venue: planVenue, attendance: p.attendance, options: { ...p, source: detailed() ? "overpass" : "tiles" }, ...(mapFile ? { osm_text: mapFile } : {}) }) });
      if (!resp.ok) throw new Error((await resp.json().catch(() => ({}))).detail || resp.statusText);
      r = await resp.json();
    } else {
      status("Starting the engine in your browser…");
      let osm;
      const where = `${venue.origin[0].toFixed(5)},${venue.origin[1].toFixed(5)}`;
      if (mapFile) {
        osm = { parts: [mapFile], missing: [] };
      } else if (!detailed() && lastOsm?.where === where && lastOsm.tiles) {
        osm = lastOsm; // re-planning: same place, no need to download again
      } else if (!detailed()) {
        try {
          osm = { ...(await fetchTiles(venue.origin[0], venue.origin[1], Math.max(3000, 2 * RADIUS_M), status)), where };
        } catch (err) { // tiles unreachable: fall back to the Overpass servers
          status(`The fast map tiles did not load (${err.message}); asking the OpenStreetMap servers instead…`);
          const queries = await inBrowserEngine(null, { lat: venue.origin[0], lon: venue.origin[1], radius_m: RADIUS_M }, "overpass_queries", {}, "#ov-status");
          osm = { ...(await fetchOsm(queries)), where };
        }
      } else if (lastOsm?.where === where && lastOsm.parts && !lastOsm.missing.length) {
        osm = lastOsm; // re-planning: same place, no need to download again
      } else {
        const queries = await inBrowserEngine(null, { lat: venue.origin[0], lon: venue.origin[1], radius_m: RADIUS_M }, "overpass_queries", {}, "#ov-status");
        osm = { ...(await fetchOsm(queries)), where };
      }
      lastOsm = mapFile ? null : osm;
      r = await inBrowserEngine(planVenue, p, "overview", { osm: osm.parts, tiles: osm.tiles, tilesKey: osm.tiles ? where : null, missing: osm.missing }, "#ov-status");
    }
    last = r;
    await render(r);
    status(`Planned in ${((performance.now() - t0) / 1000).toFixed(0)} s. ${r.data.streets.toLocaleString()} streets and ${r.data.places} places from OpenStreetMap.`);
    $("#ov-out").scrollIntoView({ block: "start" });
  } catch (err) {
    status(`Could not plan the surroundings: ${err.message}`);
  } finally {
    $("#ov-run").disabled = false;
  }
}

function timeline(t) {
  const end = t.event_end_min, gone = end + t.departure_minutes, total = gone + 15;
  const X = (m) => `${(100 * (m + 30)) / (total + 30)}%`;
  const seg = (a, b, cls, label) => `<div class="tl-seg ${cls}" style="left:${X(a)};width:calc(${X(b)} - ${X(a)})" title="${esc(label)}">${esc(label)}</div>`;
  return `<div class="timeline" role="img" aria-label="Event timeline">
    ${seg(-30, 0, "tl-prep", "Teams in place")}${seg(0, t.arrival_minutes, "tl-arr", "Arrival")}
    ${seg(t.arrival_minutes, end, "tl-event", "Event")}${seg(end, gone, "tl-dep", "Departure")}</div>
    <div class="small muted">Gates open at minute 0 · arrivals over ${t.arrival_minutes} min · event ends at minute ${end} ·
      the crowd leaves over ${t.departure_minutes} min (set from the crowd size; change it from experience at this venue).</div>`;
}

const table = (head, rows) => `<div class="scroll"><table class="wi-table"><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("") || `<tr><td colspan="${head.length}">None.</td></tr>`}</tbody></table></div>`;
const pct = (v) => `${Math.round(v * 100)}%`;

async function render(r) {
  const out = $("#ov-out");
  const checks = r.checks.map((c) => `<li class="c-${c.level}"><span class="c-icon" aria-hidden="true">${ICON[c.level]}</span>
    <div><b>${esc(c.title)}</b><div class="small">${esc(c.detail)}</div></div></li>`).join("");
  const totals = table(["Agency", "Role", "Staff", "Posts"], r.totals.map((t) => `<tr><td>${esc(t.agency)}</td><td>${ROLE_ICON[t.role] || ""} ${esc(t.role)}</td><td class="num">${t.count.toLocaleString()}</td><td class="num">${t.posts}</td></tr>`));
  const byAgency = {};
  r.deployments.forEach((d, i) => (byAgency[d.agency] ??= []).push({ ...d, i }));
  const agencies = Object.keys(byAgency).sort((a, b) => AGENCIES.indexOf(a) - AGENCIES.indexOf(b));
  const plan = agencies.map((ag, k) => `<details class="agency"${k === 0 ? " open" : ""}><summary><b>${esc(ag)}</b> <span class="small muted">${byAgency[ag].length} post(s), ${byAgency[ag].reduce((s, d) => s + d.count, 0)} staff</span></summary>
    <ol class="posts">${byAgency[ag].map((d) => `<li><button type="button" class="link" data-post="${d.i}">${ROLE_ICON[d.role] || ""} <b>${esc(d.role)} × ${d.count}</b> · ${esc(d.place)}</button>
      <div class="small">${esc(d.why)}</div><div class="small muted">${esc(d.when)}</div></li>`).join("")}</ol></details>`).join("");
  const closures = table(["Close to traffic", "When", "Diversion via", "Extra"], r.traffic.closures.map((c) => `<tr><td>${esc(c.street)} <span class="small muted">${c.length_m.toLocaleString()} m</span></td><td class="small">${esc(c.when)}</td><td>${esc(c.diversion_via.join(", ") || "local access only")}</td><td class="num">${c.diversion_extra_m === null ? "" : `${c.diversion_extra_m.toLocaleString()} m`}</td></tr>`));
  const chokes = table(["Street", "When", "Level", "Load", "Footpath", "Fix"], r.choke_points.slice(0, 12).map((s) => `<tr><td>${esc(s.street)}</td><td>${esc(s.phase)}</td><td style="color:${LOS[s.los]}"><b>${s.los}</b></td><td class="num">${pct(s.load)}</td><td class="num">${s.walk_width_m} m${s.width_estimated ? "*" : ""}</td><td class="small">${esc((s.fixes || [])[0] || "")}</td></tr>`));
  const transit = table(["Place", "Mode", "When", "People", "Busiest 15 min"], r.transit.slice(0, 12).map((t) => `<tr><td>${esc(t.name)}</td><td>${esc(t.mode)}</td><td>${esc(t.phase)}</td><td class="num">${t.people.toLocaleString()}</td><td class="num">${t.peak_15min.toLocaleString()}</td></tr>`));
  const em = r.emergency, cor = em.corridor;
  const hosp = em.hospitals.map((h) => `<li>🏥 <b>${esc(h.name)}</b>: ${h.drive_min} min by road with event traffic <span class="small muted">(${esc(h.suitability)})</span></li>`).join("")
    || "<li>No hospital found on the map: agree receiving hospitals with the health department.</li>";
  const corTxt = cor.found ? `<p>🚑 <b>Ambulance route</b> from ${esc(cor.hospital)} to ${esc(cor.gate)}: ${cor.length_m.toLocaleString()} m, about ${cor.drive_min} min, via ${esc(cor.via.join(", ") || "local streets")}.
    ${cor.shared_with_crowd.length ? `Keep one lane coned off where it meets the crowd: ${esc(cor.shared_with_crowd.map((s) => `${s.street} (${s.length_m} m)`).join(", "))}.` : "It avoids the departing crowd."}</p>` : "";
  const layerBoxes = [["crowd_departure", "Crowd leaving", true], ["crowd_arrival", "Crowd arriving", false], ["roads", "Closures and diversions", true],
    ["emergency", "Ambulance route and hospitals", true], ...AGENCIES.map((a) => [`ag:${a}`, a, true]), ["transit", "Stations and pick-up points", true]]
    .map(([k, l, on]) => `<label class="small"><input type="checkbox" data-layer="${esc(k)}"${on ? " checked" : ""}> ${esc(l)}</label>`).join("");
  out.innerHTML = `
    <div class="score v-${r.verdict}">
      <div class="score-head"><span class="v-icon" aria-hidden="true">${ICON[r.verdict]}</span>
        <div><div class="v-head">${esc(r.headline)}</div><div class="v-sub">${esc(r.venue)} · ${r.attendance.toLocaleString()} people ·
          travel: ${esc(Object.entries(r.modes).map(([k, v]) => `${k} ${pct(v)}`).join(", "))}</div></div></div>
      <div class="score-nums">
        <div class="num"><span class="n">${r.totals.reduce((s, t) => s + t.count, 0).toLocaleString()}</span><span class="l">staff at ${r.deployments.length} posts</span></div>
        <div class="num"><span class="n">${r.traffic.closures.length}</span><span class="l">roads to close</span></div>
        <div class="num ${r.choke_points.some((c) => c.los >= "E") ? "bad" : "good"}"><span class="n">${r.choke_points.filter((c) => c.los >= "E").length}</span><span class="l">overloaded streets (arrival or departure)</span></div>
        <div class="num"><span class="n">${em.hospitals[0] ? `${em.hospitals[0].drive_min} min` : "?"}</span><span class="l">${esc(em.hospitals[0]?.name || "no hospital found")}</span></div>
      </div>
    </div>
    <details class="why" open><summary>What the plan found</summary><ul class="checks">${checks}</ul></details>
    ${timeline(r.times)}
    <div class="ov-layers">${layerBoxes}</div>
    <div id="ov-map" class="wi-map ov-map" aria-label="Map of crowd routes, closures, ambulance route and teams"></div>
    <div id="ov-fixes" class="ov-fixes"></div>
    <div class="legend small"><span><i style="background:#2f9e5b"></i>comfortable</span><span><i style="background:#d7a300"></i>busy</span>
      <span><i style="background:#e36b0a"></i>crowded</span><span><i style="background:#d42a2a"></i>overflowing</span>
      <span><i style="background:#111"></i>closed to traffic</span><span><i style="background:#7a3fd1"></i>diversion</span><span><i style="background:#0a84ff"></i>ambulance route</span></div>
    <h3>Who goes where</h3>${totals}${plan}
    <h3>Road closures and diversions</h3>${closures}
    <h3>Emergency access</h3><ul class="plain">${hosp}</ul>${corTxt}
    <h3>Busiest streets outside the venue</h3>${chokes}<p class="small muted">* footpath width estimated from the street type: check it on the ground.</p>
    <h3>Stations and stops</h3>${transit}
    <details class="more"><summary>Assumptions and data</summary><ul class="small">${[...r.notes, ...r.rules_of_thumb].map((n) => `<li>${esc(n)}</li>`).join("")}</ul>
      <p class="small muted">Map data © OpenStreetMap contributors (ODbL). Footfall, travel shares and staffing ratios are planning
        assumptions: the police, traffic, health and the organisers must check this plan on the ground and adapt it.</p></details>
    <div class="btns"><button type="button" class="primary" id="ov-print">Open the printable plan</button>
      <span class="brief"><select id="ov-agency" aria-label="Agency">${agencies.map((a) => `<option>${esc(a)}</option>`).join("")}</select>
        <button type="button" id="ov-brief">Briefing sheet</button></span>
      <button type="button" id="ov-csv">All posts (CSV)</button>
      <button type="button" id="ov-geojson">Map data (GeoJSON)</button></div>`;
  out.hidden = false;
  await drawMap(r);
  renderFixes();
  out.querySelector(".ov-layers").addEventListener("change", (e) => toggle(e.target.dataset.layer, e.target.checked));
  out.addEventListener("click", (e) => {
    const b = e.target.closest("[data-post]");
    if (b && map) {
      const d = r.deployments[Number(b.dataset.post)];
      map.setView(d.lat_lon, 18);
      $("#ov-map").scrollIntoView({ block: "center" });
    }
  });
  $("#ov-print").addEventListener("click", () => printable(""));
  $("#ov-brief").addEventListener("click", () => printable($("#ov-agency").value));
  $("#ov-csv").addEventListener("click", () => download(postsCsv(r), "event-posts.csv", "text/csv"));
  $("#ov-geojson").addEventListener("click", () => download(JSON.stringify(r.geojson), "event-overview.geojson", "application/geo+json"));
}

async function drawMap(r) {
  const L = await loadLibs();
  if (map) { map.remove(); map = null; }
  map = L.map("ov-map", { scrollWheelZoom: false }); // the page scrolls; click the map to zoom with the wheel
  map.on("click", () => map.scrollWheelZoom.enable());
  map.on("mouseout", () => map.scrollWheelZoom.disable());
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, className: "street-tiles", attribution: "© OpenStreetMap contributors" }).addTo(map);
  groups = {};
  const group = (k) => (groups[k] ??= L.layerGroup().addTo(map));
  for (const f of r.geojson.features) {
    const p = f.properties;
    let k = p.layer;
    if (k === "closure" || k === "diversion") k = "roads";
    if (k === "ambulance_route" || k === "hospital") k = "emergency";
    if (k === "pickup") k = "transit";
    if (k === "deployment") k = `ag:${p.agency}`;
    const layer = L.geoJSON(f, {
      style: () => p.layer.startsWith("crowd") ? { color: LOS[p.los] || "#888", weight: p.los > "C" ? 6 : 3, opacity: 0.85 }
        : p.layer === "closure" ? { color: "#111", weight: 6, dashArray: "8 6" }
        : p.layer === "diversion" ? { color: "#7a3fd1", weight: 3, dashArray: "2 6" }
        : p.layer === "ambulance_route" ? { color: "#0a84ff", weight: 5 }
        : p.layer === "venue" ? { color: "#2456d6", weight: 2, fillOpacity: 0.12 } : {},
      pointToLayer: (_, ll) => L.marker(ll, { icon: L.divIcon({ className: "ov-pin", iconSize: [24, 24],
        html: `<span>${p.layer === "deployment" ? (ROLE_ICON[p.role] || "•") : p.layer === "hospital" ? "🏥" : p.layer === "pickup" ? "🚕" : "🚇"}</span>` }) }),
    });
    const pop = p.layer === "deployment" ? `<b>${esc(p.role)} × ${p.count}</b><br>${esc(p.place)}<br>${esc(p.why)}<br><i>${esc(p.when)}</i>`
      : p.layer === "hospital" ? `<b>${esc(p.name)}</b><br>${p.drive_min} min by road`
      : p.layer === "transit" ? `<b>${esc(p.name)}</b><br>${p.people.toLocaleString()} people (${esc(p.phase)}), ${p.peak_15min.toLocaleString()} in the busiest 15 min`
      : esc(p.street || p.name || p.hospital || "");
    if (p.layer === "crowd_departure" || p.layer === "crowd_arrival") layer.bindPopup(() => fixForm(p), { minWidth: 240 });
    else if (pop) layer.bindPopup(pop);
    layer.addTo(group(k));
  }
  toggle("crowd_arrival", false);
  const near = L.featureGroup(Object.entries(groups).filter(([k]) => k === "venue" || k.startsWith("ag:")).flatMap(([, g]) => g.getLayers()));
  try { map.fitBounds(near.getBounds(), { padding: [20, 20] }); } catch { map.setView(r.deployments[0]?.lat_lon || [0, 0], 15); }
}

function toggle(k, on) {
  const g = groups?.[k];
  if (!g || !map) return;
  if (on) g.addTo(map); else map.removeLayer(g);
}

function download(text, name, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Same columns as report.deployments_csv in Python.
function postsCsv(r) {
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const rows = [["agency", "role", "staff", "place", "latitude", "longitude", "why", "when", "priority"]];
  for (const d of r.deployments) rows.push([d.agency, d.role, d.count, d.place, d.lat_lon?.[0], d.lat_lon?.[1], d.why, d.when, d.priority]);
  return rows.map((row) => row.map(q).join(",")).join("\r\n") + "\r\n";
}

async function printable(agency) {
  if (!last) return;
  try {
    let html;
    if (usingServer()) {
      const r = await fetch(`api/overview/html?agency=${encodeURIComponent(agency)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(last) });
      if (!r.ok) throw new Error(r.statusText);
      html = await r.text();
    } else {
      html = await inBrowserEngine(null, last, "overview_html", { agency }, "#ov-status");
    }
    const url = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    const name = agency ? `briefing-${agency.toLowerCase().replace(/\s+/g, "-")}.html` : "event-plan.html";
    if (!window.open(url, "_blank")) download(html, name, "text/html");
  } catch (err) {
    status(`Could not make the printable plan: ${err.message}`);
  }
}

// The one-line summary of the assumptions, so they are visible without opening the form.
function summariseAssumptions() {
  const f = new FormData($("#ov-form"));
  const names = { metro: "metro", rail: "train", bus: "bus", ferry: "ferry", car: "car/taxi", walk: "on foot" };
  const modes = Object.entries(names).filter(([k]) => Number(f.get(k)) > 0).map(([k, n]) => `${n} ${f.get(k)}%`).join(", ");
  const dur = $('#ov-form [name="duration"]').selectedOptions[0]?.textContent || "";
  const foot = $('#ov-form [name="public_level"]').selectedOptions[0]?.textContent.toLowerCase() || "";
  $("#ov-assume-sum").textContent = `${modes} · ends after ${dur} · ${foot}${$("#ov-detailed")?.checked ? " · detailed map data" : ""}`;
}

export function initOverview() {
  $("#ov-form")?.addEventListener("submit", run);
  $("#ov-form")?.addEventListener("change", summariseAssumptions);
  if ($("#ov-form")) summariseAssumptions();
  $("#ov-file")?.addEventListener("change", async (e) => {
    const f = e.target.files[0];
    mapFile = f ? await f.text() : null;
    $("#ov-file-name").textContent = f ? `Using ${f.name} (${(f.size / 1e6).toFixed(1)} MB) instead of downloading.` : "";
  });
}
