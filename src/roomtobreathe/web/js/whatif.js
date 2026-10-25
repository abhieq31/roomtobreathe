import { round2, toLocal } from "./geo.js";
import { polygonArea } from "./geometry.js";
import { parsePeople } from "./numbers.js";
import { openMap, refreshMap, searchPlace } from "./venuemap.js";

// What-if studies in the browser. The computation is the Python engine itself (roomtobreathe.whatif):
// on a control-room server it runs there (POST /api/whatif); on a plain web host it runs in this browser
// through Pyodide in a background worker. One source of truth, no JavaScript re-implementation to drift.

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem("rtb:" + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("rtb:" + k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const LEVEL_COLORS = { GREEN: "var(--green)", YELLOW: "var(--yellow)", ORANGE: "var(--orange)", RED: "var(--red)", UNKNOWN: "var(--unknown)" };
const SERIES = ["#2456d6", "#e36b0a", "#2f9e5b", "#9b3fd1", "#d42a2a", "#0e8c8c", "#a8730a", "#5d6673"];

let demoVenue = null;
let serverVenue = null;
let useServer = false;
let worker = null;
let pending = null;
let last = null;
let statusEl = "#wi-status"; // where engine progress messages go

const slug = (name, taken) => {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "zone";
  let s = base, i = 2;
  while (taken.has(s) || s === "outside") s = `${base}_${i++}`;
  return s;
};
export function parseArea(t) {
  const m = String(t).toLowerCase().replace(/m2|m²|m/g, "").trim().match(/^([\d.]+)\s*[x*×]\s*([\d.]+)$/);
  const v = m ? Number(m[1]) * Number(m[2]) : Number(t);
  return Number.isFinite(v) && v > 0 ? v : null;
}

// ------------------------------------------------------------------ venue builder
const blankVenue = () => ({ name: "", zones: [], gates: [] });
// "Type the sizes" starts from a filled-in example row so people see what to write.
const sizesTemplate = () => ({
  zones: [{ name: "Main ground", area: "60 x 40", usable: 80 }],
  gates: [{ name: "Main gate", from: "outside", to: 0, width: 6, stairs: false, closed: false },
          { name: "Exit", from: 0, to: "outside", width: 4, stairs: false, closed: false }],
});
let draft = store.get("wi-draft", blankVenue());

function zoneOptions(sel) {
  const opts = [`<option value="outside"${sel === "outside" ? " selected" : ""}>Outside</option>`];
  draft.zones.forEach((z, i) => opts.push(`<option value="${i}"${String(sel) === String(i) ? " selected" : ""}>${esc(z.name || `Zone ${i + 1}`)}</option>`));
  return opts.join("");
}
function renderBuilder() {
  refreshMap();
  $("#wi-name").value = draft.name;
  $("#wi-zones").innerHTML = draft.zones.map((z, i) => `
    <div class="vrow" data-i="${i}">
      <input data-k="name" value="${esc(z.name)}" placeholder="Zone name" aria-label="Zone name">
      <input data-k="area" value="${esc(z.area)}" placeholder="Area: 960 or 40 x 24" aria-label="Area in square metres"${z.ll?.length ? ' readonly title="Measured from the map"' : ""}>${z.ll?.length ? '<span class="small muted">m² from map</span>' : ""}
      <label class="small">usable % <input data-k="usable" type="number" min="10" max="100" value="${esc(z.usable)}"></label>
      <button type="button" class="link" data-del-zone="${i}" aria-label="Remove zone">✕</button>
    </div>`).join("");
  $("#wi-gates").innerHTML = draft.gates.map((g, i) => `
    <div class="vrow gate" data-i="${i}">
      <input data-k="name" value="${esc(g.name)}" placeholder="Gate name" aria-label="Gate name">
      <select data-k="from" aria-label="From">${zoneOptions(g.from)}</select>
      <span aria-hidden="true">→</span>
      <select data-k="to" aria-label="To">${zoneOptions(g.to)}</select>
      <label class="small">width m <input data-k="width" type="number" min="0.5" step="0.5" value="${esc(g.width)}"></label>
      <label class="small"><input data-k="stairs" type="checkbox"${g.stairs ? " checked" : ""}> steps</label>
      <label class="small"><input data-k="closed" type="checkbox"${g.closed ? " checked" : ""}> normally closed</label>
      <button type="button" class="link" data-flip-gate="${i}" title="Swap the walking direction" aria-label="Swap direction">⇄</button>
      <button type="button" class="link" data-del-gate="${i}" aria-label="Remove gate">✕</button>
    </div>`).join("");
}
function draftToVenue() {
  const problems = [], ids = [], taken = new Set();
  const zones = draft.zones.map((z, i) => {
    const area = parseArea(z.area);
    if (!z.name.trim()) problems.push(`Zone ${i + 1} needs a name.`);
    if (!area) problems.push(`Zone "${z.name || i + 1}" needs an area, e.g. 960 or 40 x 24.`);
    const id = slug(z.name || `zone ${i + 1}`, taken); taken.add(id); ids.push(id);
    const usable_fraction = Math.min(1, Math.max(0.1, Number(z.usable || 100) / 100));
    if (draft.origin && z.ll?.length >= 3) { // drawn on the map: the engine measures the real outline
      return { id, name: z.name || id, polygon: z.ll.map((p) => round2(toLocal(draft.origin, p))), usable_fraction };
    }
    return { id, name: z.name || id, area_m2: area || 0, usable_fraction };
  });
  const ref = (v) => (v === "outside" ? "outside" : ids[Number(v)]);
  const gates = draft.gates.map((g, i) => {
    if (ref(g.from) === ref(g.to)) problems.push(`Gate "${g.name || i + 1}" must join two different places.`);
    if (!(Number(g.width) > 0)) problems.push(`Gate "${g.name || i + 1}" needs a width.`);
    const d = { id: `G${i + 1}`, name: g.name || `Gate ${i + 1}`, from: ref(g.from), to: ref(g.to), width_m: Number(g.width) || 0 };
    if (g.stairs) d.stairs = true;
    if (g.closed) d.open = false;
    if (draft.origin && g.ll?.length >= 2) d.line = [g.ll[0], g.ll[g.ll.length - 1]].map((p) => round2(toLocal(draft.origin, p)));
    return d;
  });
  if (!zones.length) problems.push("Add at least one zone.");
  const name = draft.name.trim() || "My venue";
  const venue = { id: slug(name, new Set()), name, zones, gates };
  if (draft.origin && draft.zones.some((z) => z.ll?.length)) venue.origin = draft.origin;
  return { venue, problems };
}
function onBuilderInput(e) {
  const row = e.target.closest(".vrow");
  if (!row) return;
  const list = row.classList.contains("gate") ? draft.gates : draft.zones;
  const item = list[Number(row.dataset.i)];
  const k = e.target.dataset.k;
  item[k] = e.target.type === "checkbox" ? e.target.checked : e.target.value;
  if (k === "width") { delete item.guessed; delete item.estimated; } // a typed width is a measured width
  store.set("wi-draft", draft);
  if (k === "name" && !row.classList.contains("gate")) renderBuilder(); // zone names appear in gate menus
  refreshVenue();
}

// ------------------------------------------------------------------ current venue
let fileVenue = store.get("wi-file-venue", null);
function currentVenue() {
  const src = $("#wi-src").value;
  if (src === "custom") return draftToVenue();
  if (src === "file") return { venue: fileVenue, problems: fileVenue ? [] : ["Choose a venue file."] };
  return { venue: serverVenue || demoVenue, problems: [] };
}
function refreshVenue() {
  queueMicrotask(updateGuide);
  // On the map path the editing lists appear once there is a venue to edit: no jargon before it is needed.
  const b = $("#wi-builder");
  const sizes = store.get("wi-mode", "map") === "sizes";
  if (b) b.classList.toggle("has-venue", draft.zones.length > 0 || draft.gates.length > 0 || sizes);
  const lists = $("#wi-lists");
  if (lists) {
    if (sizes) lists.open = true;
    $("#wi-lists-sum").textContent = `${plural(draft.zones.length, "area")}, ${plural(draft.gates.length, "way")} in or out`;
  }
  const { venue, problems } = currentVenue();
  const out = $("#wi-venue-out");
  const sel = $('#wi-form [name="blocked_gate"]');
  const keep = sel.value;
  sel.innerHTML = `<option value="">no gate blocked</option>` + (venue?.gates || []).map((g) => `<option value="${esc(g.id)}">${esc(g.id)} · ${esc(g.name)} (${g.width_m} m)</option>`).join("");
  sel.value = (venue?.gates || []).some((g) => g.id === keep) ? keep : "";
  if ($("#wi-src").value === "custom" && !draft.zones.length) {
    out.innerHTML = `<p class="muted">${store.get("wi-mode", "map") === "map"
      ? "Search for the place, then trace the area where people will stand."
      : "Add the areas where people will stand, and every way in and out."}</p>`;
    return;
  }
  if (!venue) { out.innerHTML = problems.map((p) => `<p class="err">${esc(p)}</p>`).join(""); return; }
  const zoneArea = (z) => z.usable_area_m2
    ?? (z.area_m2 ?? (z.polygon?.length ? polygonArea(z.polygon) : 0)) * (z.usable_fraction ?? 1);
  const area = venue.zones.reduce((s, z) => s + zoneArea(z), 0);
  out.innerHTML = problems.map((p) => `<p class="err">${esc(p)}</p>`).join("")
    + `<p><b>${esc(venue.name)}</b>: ${Math.round(area).toLocaleString()} m² where people can stand, ${plural(venue.gates.length, "way")} in or out.</p>`;
}

// ------------------------------------------------------------------ engine
function engineWorker() {
  if (!worker) {
    worker = new Worker(new URL("engine-worker.js", import.meta.url));
    worker.onmessage = (e) => {
      if (e.data.status) { if (pending) $(statusEl).textContent = e.data.status; return; } // silent while warming
      const p = pending; pending = null;
      if (!p) return;
      e.data.error ? p.reject(new Error(e.data.error)) : p.resolve(e.data.result);
    };
    worker.onerror = (e) => { if (pending) { pending.reject(new Error(e.message || "engine failed to start")); pending = null; } };
  }
  return worker;
}
// The browser engine (Pyodide worker); also used by overview.js. ``extra`` rides along to the worker.
export function inBrowserEngine(venue, params, kind, extra = {}, status = null) {
  if (pending) return Promise.reject(new Error("the engine is busy with another calculation"));
  if (status) statusEl = status;
  return new Promise((resolve, reject) => {
    pending = { resolve, reject };
    engineWorker().postMessage({ kind, venue, params, ...extra });
  });
}
export const usingServer = () => useServer;
export const venueForChecks = () => currentVenue();

async function runEngine(venue, params, kind = "whatif") {
  if (useServer) {
    const body = kind === "assess" ? { venue, ...params } : { venue, params };
    const r = await fetch(`api/${kind}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText);
    return r.json();
  }
  if (pending) throw new Error("a what-if is already running");
  return new Promise((resolve, reject) => {
    pending = { resolve, reject };
    engineWorker().postMessage({ kind, venue, params });
  });
}

function readParams() {
  const f = new FormData($("#wi-form"));
  const num = (k) => (f.get(k) === "" || f.get(k) === null ? null : Number(f.get(k)));
  return {
    attendance: num("attendance"), arrival_minutes: num("arrival_minutes"), minutes: num("minutes"),
    surge_at_min: num("surge_at_min"), surge_multiplier: num("surge_multiplier"),
    blocked_gate: f.get("blocked_gate") || null, blocked_at_min: num("blocked_at_min"),
    blocked_to: num("blocked_to_pct") === null ? null : num("blocked_to_pct") / 100,
    evacuate_at_min: num("evacuate_at_min"),
  };
}

// ------------------------------------------------------------------ results
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const fmt = (v, d = 1) => (v === null || v === undefined ? "–" : Number(v).toFixed(d).replace(/\.0+$/, ""));
function chart(run, venue, title) {
  const W = 640, H = 240, L = 34, B = 22, T = 10, R = 8;
  const t = run.series.t_min, tmax = Math.max(1, t[t.length - 1] || 1);
  const zones = venue.zones.map((z) => z.id);
  const ymax = Math.max(8, ...zones.flatMap((z) => run.series[z] || [0]));
  const X = (v) => L + (v / tmax) * (W - L - R), Y = (v) => T + (1 - v / ymax) * (H - T - B);
  const bands = [[2, 4, "var(--yellow)"], [4, 5.5, "var(--orange)"], [5.5, ymax, "var(--red)"]]
    .map(([a, b, c]) => `<rect x="${L}" y="${Y(b)}" width="${W - L - R}" height="${Y(a) - Y(b)}" fill="${c}" opacity=".10"/>`).join("");
  const crit = `<line x1="${L}" x2="${W - R}" y1="${Y(6.5)}" y2="${Y(6.5)}" stroke="var(--red)" stroke-dasharray="4 3"/><text x="${W - R - 2}" y="${Y(6.5) - 3}" text-anchor="end" class="ax">critical 6.5</text>`;
  const ticksY = [0, 2, 4, 6, 8].filter((v) => v <= ymax).map((v) => `<text x="${L - 4}" y="${Y(v) + 3}" text-anchor="end" class="ax">${v}</text>`).join("");
  const step = tmax > 120 ? 30 : tmax > 40 ? 10 : 5;
  const ticksX = Array.from({ length: Math.floor(tmax / step) + 1 }, (_, i) => i * step).map((v) => `<text x="${X(v)}" y="${H - 6}" text-anchor="middle" class="ax">${v}</text>`).join("");
  const lines = zones.map((z, i) => {
    const pts = (run.series[z] || []).map((v, k) => `${X(t[k]).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
    return `<polyline points="${pts}" fill="none" stroke="${SERIES[i % SERIES.length]}" stroke-width="2"/>`;
  }).join("");
  const marks = run.actions.length ? `<line x1="${X(run.actions[0].t_min)}" x2="${X(run.actions[0].t_min)}" y1="${T}" y2="${H - B}" stroke="var(--ink)" stroke-dasharray="2 3"/><text x="${X(run.actions[0].t_min) + 3}" y="${T + 9}" class="ax">response</text>` : "";
  const legend = zones.map((z, i) => `<span><i style="background:${SERIES[i % SERIES.length]}"></i>${esc(venue.zones[i].name)}</span>`).join("");
  return `<figure class="wi-chart"><figcaption>${esc(title)} <span class="muted small">people per m², by minute</span></figcaption>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}: density over time">${bands}${crit}${ticksY}${ticksX}${lines}${marks}</svg>
    <div class="legend small">${legend}</div></figure>`;
}
function table(r) {
  const row = (s, b) => `<tr><td>${esc(s.zone_name)}</td>
    <td class="num" style="color:${s.peak_density >= 6.5 ? "var(--red)" : "inherit"}">${fmt(s.peak_density, 1)}</td>
    <td class="num">${fmt(s.first_orange_min)}</td><td class="num">${fmt(s.first_red_min)}</td>
    <td class="num"><b>${fmt(s.critical_at_min)}</b></td><td class="num">${fmt(s.warning_lead_min)}</td>
    <td class="num">${fmt(b.peak_density, 1)}</td></tr>`;
  const rows = r.no_response.summary.map((s, i) => row(s, r.with_response.summary[i])).join("");
  return `<div class="scroll"><table class="wi-table"><thead><tr><th rowspan="2">Zone</th><th colspan="5">Nobody acts</th><th>With playbook</th></tr>
    <tr><th>peak p/m²</th><th>ORANGE at min</th><th>RED at min</th><th>critical at min</th><th>warning, min</th><th>peak p/m²</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}
function renderResults(r, venue) {
  last = { r, venue };
  const verdictLevel = r.with_response.reached_critical.length ? "RED" : r.no_response.reached_critical.length ? "ORANGE" : "GREEN";
  const cap = `Safe capacity ${r.safe_capacity.toLocaleString()} (limited by ${esc(r.limiting_factor)}); simulated ${Number(r.params.attendance).toLocaleString()} people.`;
  const zname = Object.fromEntries(venue.zones.map((z) => [z.id, z.name]));
  const actions = r.with_response.actions.map((a) => `<li>min ${fmt(a.t_min)} · ${esc(zname[a.zone] || a.zone)}: <b>${esc(a.result)}</b>${a.action.gate_name ? ` (${esc(a.action.gate_name)})` : ""}${a.action.note ? ` — ${esc(a.action.note)}` : ""}</li>`).join("");
  const alerts = r.no_response.alerts.filter((a) => a.level !== "GREEN" && a.level !== "UNKNOWN").slice(0, 12)
    .map((a) => `<li><span class="dot" style="background:${LEVEL_COLORS[a.level]}"></span>min ${fmt(a.t_min)} · <b>${esc(a.zone_name)}</b> → ${esc(a.level)}: ${esc(a.reasons.join("; "))}</li>`).join("");
  $("#wi-out").innerHTML = `
    <div class="verdict" style="--lv:${LEVEL_COLORS[verdictLevel]}">${r.conclusions.map(esc).join("<br>")}</div>
    <p class="small muted">${cap}</p>
    ${r.findings.length ? `<ul class="factors">${r.findings.map((f) => `<li>⚠ ${esc(f)}</li>`).join("")}</ul>` : ""}
    <div class="grid plan-grid">${chart(r.no_response, venue, "Nobody acts")}${chart(r.with_response, venue, "Operators approve the playbook at the first RED alert")}</div>
    ${table(r)}
    <div class="grid plan-grid">
      <div><h3>Alerts operators would see (nobody acts)</h3><ul class="log small">${alerts || "<li>No warnings.</li>"}</ul></div>
      <div><h3>Actions taken in the response run</h3><ul class="log small">${actions || "<li>None needed.</li>"}</ul></div>
    </div>
    <p class="small muted">A macroscopic model (people per zone, flow limited by gate width): it shows where and roughly when,
      not exactly. Rehearse your real response and time it.</p>`;
  $("#wi-results").hidden = false;
}

async function run(e) {
  e.preventDefault();
  const { venue, problems } = currentVenue();
  if (problems.length || !venue) { $("#wi-status").textContent = problems[0] || "Choose a venue."; return; }
  const params = readParams();
  $("#wi-run").disabled = true;
  statusEl = "#wi-status";
  const t0 = performance.now();
  $("#wi-status").textContent = useServer ? "Running on the control-room server…" : "Starting the engine in your browser (first time: about 10 MB)…";
  try {
    const r = await runEngine(venue, params);
    renderResults(r, venue);
    $("#wi-status").textContent = `Done in ${((performance.now() - t0) / 1000).toFixed(1)} s.`;
    $("#wi-results").scrollIntoView({ block: "start" });
  } catch (err) {
    $("#wi-status").textContent = `Could not run: ${err.message}`;
  } finally {
    $("#wi-run").disabled = false;
  }
}

// ------------------------------------------------------------------ the step guide
// Four steps shown at the top: what is done, what is next. Each one jumps to its place on the page.
function updateGuide() {
  const guide = $("#guide");
  if (!guide) return;
  const { venue, problems } = currentVenue();
  const custom = $("#wi-src").value === "custom";
  const done = {
    venue: Boolean(venue) && !problems.length && (!custom || draft.zones.length > 0),
    people: parsePeople($('#as-form [name="attendance"]')?.value) > 0,
    verdict: !$("#as-result").hidden,
    teams: !$("#ov-out").hidden,
  };
  let next = null;
  for (const li of guide.querySelectorAll("li[data-step]")) {
    const d = done[li.dataset.step];
    li.classList.toggle("done", d);
    li.classList.toggle("now", !d && !next);
    if (!d && !next) next = li.dataset.step;
  }
}
const GUIDE_TARGET = { venue: ".pl-venue", people: '#as-form [name="attendance"]', verdict: "#as-result", teams: "#ov-card" };
function initGuide() {
  const guide = $("#guide");
  if (!guide) return;
  guide.addEventListener("click", (e) => {
    const li = e.target.closest("li[data-step]");
    if (!li) return;
    let el = $(GUIDE_TARGET[li.dataset.step]);
    if (li.dataset.step === "verdict" && el.hidden) el = $('#as-form [name="attendance"]');
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    if (el?.matches("input")) setTimeout(() => el.focus({ preventScroll: true }), 300);
  });
  $("#as-form").addEventListener("input", updateGuide);
  const watch = new MutationObserver(updateGuide);
  for (const id of ["#as-result", "#ov-out"]) watch.observe($(id), { attributes: true, attributeFilter: ["hidden"] });
  updateGuide();
}

// ------------------------------------------------------------------ the verdict
const ICON = { pass: "✓", warn: "!", fail: "✕" };
async function shareVerdict(r, btn) {
  const text = `${r.headline}. ${r.venue}: safe capacity ${r.safe_capacity.toLocaleString()}, ` +
    `${r.attendance.toLocaleString()} people expected. Checked with Room to Breathe, free crowd-safety planning:`;
  const url = location.origin + location.pathname;
  const said = (t) => { const was = btn.textContent; btn.textContent = t; setTimeout(() => { btn.textContent = was; }, 2000); };
  try {
    if (navigator.share) { await navigator.share({ title: "Room to Breathe", text, url }); return; }
    await navigator.clipboard.writeText(`${text} ${url}`);
    said("Copied ✓");
  } catch (err) {
    if (err?.name !== "AbortError") said("Could not share");
  }
}

function renderVerdict(r, venue) {
  const box = $("#as-result");
  const n = r.numbers || {};
  const over = r.attendance > r.safe_capacity;
  const num = (value, label, cls = "") => `<div class="num ${cls}"><span class="n">${value}</span><span class="l">${esc(label)}</span></div>`;
  const evac = n.evacuation_minutes === null || n.evacuation_minutes === undefined ? "> 45 min" : `${fmt(n.evacuation_minutes, 0)} min`;
  const checks = r.checks.map((c) => `<li class="c-${c.level}"><span class="c-icon" aria-hidden="true">${ICON[c.level]}</span>
    <div><b>${esc(c.title)}</b><div class="small">${esc(c.detail)}</div></div></li>`).join("");
  const todo = r.fixes.length
    ? `<h3>What to do</h3><ol class="todo">${r.fixes.map((f) => `<li><span>${esc(f)}</span></li>`).join("")}</ol>`
    : `<p><b>Nothing to change.</b> Keep counting people at the gates on the day.</p>`;
  const located = Boolean(venue.origin);
  const surge = r.surge;
  // Never surprise: if the ways in were guessed from the map, the capacity is only as good as the guess.
  const custom = $("#wi-src").value === "custom";
  const guessed = custom && draft.gates.some((g) => g.guessed);
  const estimated = custom && draft.gates.some((g) => g.estimated);
  const caveat = guessed
    ? `<div class="caveat"><b>Based on guessed ways in.</b> The map has no gates for this venue, so ${draft.gates.length} were
        placed at the points nearest the streets, ${draft.gates[0]?.width || 4} m wide. Move them to the real gates and set their
        widths (on the map: Adjust shapes; or "Edit areas and ways in"), then check again.</div>`
    : estimated ? `<div class="caveat">Gate widths are estimated from the street type. Measure the real openings for a firm capacity.</div>` : "";
  box.innerHTML = `
    <div class="score v-${r.verdict}">
      <div class="score-head"><span class="v-icon" aria-hidden="true">${ICON[r.verdict]}</span>
        <div><div class="v-head">${esc(r.headline)}</div>
          <div class="v-sub">${esc(r.venue)} · arriving over ${fmt(r.arrival_minutes, 0)} min</div></div></div>
      <div class="score-nums">
        ${num(r.safe_capacity.toLocaleString(), "safe capacity", over ? "" : "good")}
        ${num(r.attendance.toLocaleString(), "people expected", over ? "bad" : "")}
        ${num(evac, "to get everyone out", n.evacuation_minutes > 15 || n.evacuation_minutes === null ? "bad" : "")}
        ${n.peak_density !== null && n.peak_density !== undefined ? num(`${fmt(n.peak_density, 1)}/m²`, "most crowded spot", n.peak_density >= 5.5 ? "bad" : "") : ""}
      </div>
    </div>
    ${caveat}
    ${todo}
    <div class="next-step">
      <p><b>Next: the area around the venue.</b><br><span class="small muted">Streets, stations, traffic, ambulances, and where to
        place police, traffic police and medical teams.</span></p>
      <button type="button" class="btn-next" id="as-next">${located ? "Plan police, traffic and medical teams →" : "Find the venue on the map first"}</button>
    </div>
    <details class="why"><summary>Why: the ${r.checks.length} checks behind this verdict</summary><ul class="checks">${checks}</ul></details>
    <details class="more"><summary>See a surge minute by minute</summary>
      <p class="small muted">Arrivals jump 2.5× a third of the way in. Left: nobody acts. Right: operators approve the
        response plan at the first RED alert.</p>
      <div class="grid plan-grid">${chart(surge.no_response, venue, "Nobody acts")}${chart(surge.with_response, venue, "With the response plan")}</div>
    </details>
    <div class="btns">
      <button type="button" id="as-save">Save this venue</button>
      <button type="button" id="as-share">Share this check</button>
      <button type="button" class="link" id="as-count" data-goto="count">On the day: count people at the gates →</button>
    </div>
    <p class="small muted">Decision support, not a guarantee: a model of people per area and flow through the ways in and out.
      Walk the site, rehearse your response, and recheck if anything changes.</p>`;
  box.hidden = false;
  $("#as-save").addEventListener("click", () => $("#wi-download").click());
  $("#as-share").addEventListener("click", () => shareVerdict(r, $("#as-share")));
  // On the day, the gate counter warns against the capacity this check found.
  $("#as-count").addEventListener("click", () => {
    const permit = $("#cnt-permit");
    if (permit) { permit.value = r.safe_capacity; permit.dispatchEvent(new Event("input")); }
  });
  $("#as-next").addEventListener("click", () => {
    if (!located) { document.querySelector('.choice-btn[data-src="map"]')?.click(); $("#wi-map-q")?.focus(); return; }
    $("#ov-card").scrollIntoView({ block: "start", behavior: "smooth" });
    $("#ov-form").requestSubmit();
  });
  const bb = $("#bb-summary");
  if (bb) {
    bb.innerHTML = `<div class="bb-v v-${r.verdict}">${ICON[r.verdict]} ${esc(r.headline)}</div>
      <div class="bb-n">${r.safe_capacity.toLocaleString()}</div><div class="small muted">safe capacity, with the largest exit blocked</div>
      ${guessed ? `<div class="small caveat-mini">Based on guessed ways in: set the real gates for a firm number.</div>` : ""}
      <button type="button" class="link" id="bb-see">See what to do ↓</button>`;
    bb.hidden = false;
    $("#bb-see").addEventListener("click", () => box.scrollIntoView({ block: "start", behavior: "smooth" }));
  }
}

async function check(e) {
  e.preventDefault();
  const { venue, problems } = currentVenue();
  const status = $("#as-status");
  if (problems.length || !venue) { status.textContent = problems[0] || "First tell us where the event is (step 1)."; return; }
  const f = new FormData($("#as-form"));
  const attendance = parsePeople(f.get("attendance")), arrival_minutes = Number(f.get("arrival_minutes"));
  if (!(attendance > 0)) { status.textContent = "Type how many people you expect, like 5000, 60,000 or 1 lakh."; return; }
  store.set("as-people", attendance);
  // the expert form starts from the same numbers
  $('#wi-form [name="attendance"]').value = attendance;
  $('#wi-form [name="arrival_minutes"]').value = arrival_minutes;
  const btn = $("#as-run"), label = btn.textContent;
  btn.disabled = true; btn.classList.add("busy"); btn.textContent = "Checking…";
  statusEl = "#as-status";
  status.textContent = useServer ? "Checking…" : "Checking in your browser. The first time takes a little longer…";
  try {
    const r = await runEngine(venue, { attendance, arrival_minutes }, "assess");
    renderVerdict(r, venue);
    status.textContent = "";
    $("#as-result").scrollIntoView({ block: "start", behavior: "smooth" });
  } catch (err) {
    status.textContent = `Could not check: ${err.message}`;
  } finally {
    btn.disabled = false; btn.classList.remove("busy"); btn.textContent = label;
  }
}

export async function initWhatIf({ online }) {
  useServer = online;
  // Load Python while the visitor reads and types, so the first check answers in seconds, not 25 s.
  // Skipped when the phone asks to save data; then it loads on the first check as before.
  if (!online && !navigator.connection?.saveData) {
    (window.requestIdleCallback || setTimeout)(() => engineWorker().postMessage({ kind: "warm" }), { timeout: 1500 });
  }
  if (online) serverVenue = await fetch("api/venue").then((r) => r.json()).catch(() => null);
  demoVenue = await fetch(new URL("../data/pandal.json", import.meta.url)).then((r) => r.json()).catch(() => null);
  if (serverVenue) {
    const b = $('.choice-btn[data-src="demo"]');
    b.querySelector("b").textContent = "This control room's venue";
    b.querySelector("span").textContent = serverVenue.name;
  }
  const setMode = (mode) => {
    $("#wi-src").value = mode === "demo" ? "demo" : mode === "file" ? "file" : "custom";
    store.set("wi-mode", mode);
    for (const b of document.querySelectorAll(".choice-btn")) b.setAttribute("aria-pressed", String(b.dataset.src === mode));
    $("#wi-builder").hidden = !(mode === "map" || mode === "sizes");
    if (mode === "sizes" && !draft.zones.length && !draft.gates.length) {
      Object.assign(draft, sizesTemplate());
      store.set("wi-draft", draft);
      renderBuilder();
    }
    $("#wi-map-panel").hidden = mode !== "map";
    if (mode === "map") {
      openMap(draft, () => { store.set("wi-draft", draft); renderBuilder(); refreshVenue(); })
        .catch((err) => { $("#wi-map-help").textContent = `The map could not load: ${err.message}`; });
    }
    refreshVenue();
  };
  const showSrc = () => setMode(store.get("wi-mode", "map"));
  for (const b of document.querySelectorAll(".choice-btn")) b.addEventListener("click", () => setMode(b.dataset.src));
  $("#wi-load").addEventListener("click", () => $("#wi-file").click());
  $("#wi-file").addEventListener("change", async () => {
    const f = $("#wi-file").files[0];
    if (!f) return;
    try { fileVenue = JSON.parse(await f.text()); store.set("wi-file-venue", fileVenue); } catch { fileVenue = null; $("#wi-venue-out").innerHTML = `<p class="err">That is not a venue file.</p>`; return; }
    setMode("file");
  });
  $("#wi-name").addEventListener("input", (e) => { draft.name = e.target.value; store.set("wi-draft", draft); refreshVenue(); });
  $("#wi-zones").addEventListener("change", onBuilderInput);
  $("#wi-gates").addEventListener("change", onBuilderInput);
  $("#wi-zones").addEventListener("click", (e) => {
    const b = e.target.closest("[data-del-zone]");
    if (!b) return;
    const i = Number(b.dataset.delZone);
    draft.zones.splice(i, 1);
    draft.gates = draft.gates.filter((g) => g.from !== i && g.to !== i && String(g.from) !== String(i) && String(g.to) !== String(i))
      .map((g) => ({ ...g, from: g.from !== "outside" && Number(g.from) > i ? Number(g.from) - 1 : g.from, to: g.to !== "outside" && Number(g.to) > i ? Number(g.to) - 1 : g.to }));
    store.set("wi-draft", draft); renderBuilder(); refreshVenue();
  });
  $("#wi-gates").addEventListener("click", (e) => {
    const f = e.target.closest("[data-flip-gate]");
    if (f) {
      const g = draft.gates[Number(f.dataset.flipGate)];
      [g.from, g.to] = [g.to, g.from];
      store.set("wi-draft", draft); renderBuilder(); refreshVenue();
      return;
    }
    const b = e.target.closest("[data-del-gate]");
    if (!b) return;
    draft.gates.splice(Number(b.dataset.delGate), 1);
    store.set("wi-draft", draft); renderBuilder(); refreshVenue();
  });
  $("#wi-add-zone").addEventListener("click", () => { draft.zones.push({ name: "", area: "", usable: 100 }); store.set("wi-draft", draft); renderBuilder(); });
  $("#wi-add-gate").addEventListener("click", () => { draft.gates.push({ name: "", from: "outside", to: 0, width: 3, stairs: false, closed: false }); store.set("wi-draft", draft); renderBuilder(); refreshVenue(); });
  $("#wi-download").addEventListener("click", () => {
    const { venue: base } = currentVenue();
    if (!base) return;
    // Street corrections made in step 3 travel with the venue file.
    let fixes = {};
    try { fixes = JSON.parse(localStorage.getItem(`rtb:ov-fix:${base.id}`) || "{}"); } catch { /* none */ }
    const venue = Object.keys(fixes).length
      ? { ...base, surroundings: { ...(base.surroundings || {}), overrides: { ...(base.surroundings?.overrides || {}), ...fixes } } }
      : base;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([JSON.stringify(venue, null, 2)], { type: "application/json" }));
    a.download = `${venue.id || "venue"}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $("#wi-form").addEventListener("submit", run);
  initGuide();
  // The header search: find the venue from anywhere in the app.
  $("#nav-search")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = $("#nav-q").value.trim();
    if (!q) { $("#nav-q").focus(); return; }
    document.querySelector('.tabs button[data-tab="whatif"]')?.click();
    setMode("map");
    searchPlace(q);
  });
  // A venue found and accepted in one click: the next thing to type is the number of people.
  document.addEventListener("rtb:venue-ready", () => {
    const people = $('#as-form [name="attendance"]');
    people.scrollIntoView({ block: "center", behavior: "smooth" });
    setTimeout(() => people.focus({ preventScroll: true }), 400);
  });
  $("#as-form").addEventListener("submit", check);
  const saved = store.get("as-people", null);
  const people = $('#as-form [name="attendance"]');
  if (saved) people.value = saved;
  // Say back how the number was read ("1.5 lakh" = 150,000 people), so a typo never goes unnoticed.
  const readBack = () => {
    const v = parsePeople(people.value), raw = people.value.trim();
    $("#as-read").textContent = !raw || String(v) === raw.replace(/[,\s]/g, "") ? "" : v ? `= ${v.toLocaleString()} people` : "Type a number, like 5000 or 1 lakh";
  };
  people.addEventListener("input", readBack);
  readBack();
  renderBuilder();
  showSrc();
}
