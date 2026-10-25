import { computeCapacity, assessRisk } from "./planning.js";
import { initPhoto } from "./photo.js";
import { initOverview } from "./overview.js";
import { initWhatIf } from "./whatif.js";

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem("rtb:" + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("rtb:" + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

// ---------------------------------------------------------------- tabs
for (const b of document.querySelectorAll(".tabs button")) {
  b.addEventListener("click", () => showTab(b.dataset.tab));
}
function showTab(name) {
  for (const b of document.querySelectorAll(".tabs button")) b.setAttribute("aria-selected", String(b.dataset.tab === name));
  for (const t of document.querySelectorAll(".tab")) t.classList.toggle("active", t.id === "tab-" + name);
  store.set("tab", name);
}
const firstVisit = store.get("tab", null) === null;
const isStatic = Boolean(document.querySelector('meta[name="rtb-static"]'));
// The public web app has no live tab: open straight on planning so the page never flashes the wrong tab.
showTab(isStatic && store.get("tab", "live") === "live" ? "whatif" : store.get("tab", "live"));
if (isStatic) document.querySelector('.tabs [data-tab="live"]').hidden = true;
document.addEventListener("click", (e) => {
  const a = e.target.closest("[data-goto]");
  if (a) { e.preventDefault(); showTab(a.dataset.goto); }
});
initPhoto();

// ---------------------------------------------------------------- server
let venue = null;
let online = false;
const history = {}; // zone -> [density]
const executed = new Set(); // alertId:actionIndex

// Operator identity: the name goes into the action log, the access code is the server's RTB_TOKEN.
const auth = { name: store.get("operator", ""), token: store.get("token", "") };
function showWho() {
  $("#who").textContent = auth.name ? `Operator: ${auth.name}` : "Sign in";
  if (auth.token) $("#who").classList.remove("primary");
}
showWho();
function signIn(why) {
  const dlg = $("#signin");
  if (dlg.open) return Promise.resolve(false);
  $("#signin-why").textContent = why || "Your name goes in the action log next to every action you approve.";
  $("#signin-name").value = auth.name;
  $("#signin-token").value = auth.token;
  return new Promise((resolve) => {
    dlg.addEventListener("close", () => {
      if (dlg.returnValue === "ok") {
        auth.name = $("#signin-name").value.trim();
        auth.token = $("#signin-token").value.trim();
      } else if (dlg.returnValue === "signout") {
        auth.name = ""; auth.token = "";
      }
      store.set("operator", auth.name); store.set("token", auth.token); showWho();
      resolve(dlg.returnValue === "ok");
    }, { once: true });
    dlg.showModal();
  });
}
$("#who").addEventListener("click", () => signIn());

async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json" };
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
  const r = await fetch(path, { ...opts, headers });
  if (r.status === 401 && opts.method === "POST" && !opts.retried
      && await signIn("The server needs the access code before it accepts this. Ask the control-room lead.")) {
    return api(path, { ...opts, retried: true });
  }
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.headers.get("content-type")?.includes("json") ? r.json() : r.text();
}
const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body) });

async function boot() {
  try {
    // A static copy (the public web app) has no control-room server: do not ask for one, so the
    // browser shows no failed requests. The build marks such copies (scripts/build_site.py).
    if (isStatic) throw new Error("static site");
    venue = await api("/api/venue");
    online = true;
  } catch {
    setConn(false);
    $("#venue-name").textContent = "No control-room server on this page.";
    $("#live-offline").hidden = false;
    for (const el of document.querySelectorAll("#tab-live > :not(#live-offline)")) el.style.display = "none";
    $("#who").style.display = "none"; // nothing to sign in to without a control-room server
    $("#conn").hidden = true;
    $('.tabs [data-tab="live"]').hidden = true; // live monitoring needs the venue's own computer
    $("#cnt-zone-row").hidden = true; // no control room to report a count to
    $("#cnt-sent").hidden = true;
    if (firstVisit || store.get("tab", "") === "live") showTab("whatif");
    initWhatIf({ online: false });
    initOverview();
    return;
  }
  initWhatIf({ online: true });
  initOverview();
  $("#venue-name").textContent = venue.name;
  const health = await api("/api/health").catch(() => ({}));
  if (health.auth_required && !auth.token) $("#who").classList.add("primary");
  if (health.demo_allowed === false) $(".demo-controls").style.display = "none"; // live server: no simulator
  drawMap();
  const zsel = $("#cnt-zone");
  for (const z of venue.zones) zsel.insertAdjacentHTML("beforeend", `<option value="${esc(z.id)}">${esc(z.name)}</option>`);
  zsel.value = store.get("cnt-zone", "");
  if (venue.permitted_capacity && !store.get("cnt-permit", null)) $("#cnt-permit").value = venue.permitted_capacity;

  const sc = await api("/api/scenarios");
  for (const [k, d] of Object.entries(sc)) $("#scenario").insertAdjacentHTML("beforeend", `<option value="${esc(k)}" title="${esc(d)}">${esc(k)}</option>`);
  const trig = await api("/api/triggers");
  const tbox = $("#triggers");
  for (const [k, label] of Object.entries(trig)) {
    tbox.insertAdjacentHTML("beforeend", `<button data-trigger="${esc(k)}" aria-pressed="false" title="${esc(label)}">${esc(k.replace(/_/g, " "))}</button>`);
  }
  tbox.addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-trigger]");
    if (!b) return;
    const active = b.getAttribute("aria-pressed") !== "true";
    await post("/api/triggers", { name: b.dataset.trigger, active, zone_id: "*", by: auth.name || null });
    b.setAttribute("aria-pressed", String(active));
  });
  connect();
}

function setConn(ok) {
  const c = $("#conn");
  c.textContent = ok ? "live" : "offline";
  c.classList.toggle("ok", ok);
}

function connect() {
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/live`);
  ws.onopen = () => setConn(true);
  ws.onmessage = (e) => render(JSON.parse(e.data));
  ws.onclose = () => { setConn(false); setTimeout(connect, 2000); };
  const ping = setInterval(() => ws.readyState === 1 ? ws.send("ping") : clearInterval(ping), 15000);
}

$("#demo-start").addEventListener("click", async () => {
  executed.clear();
  alertsKey = "";
  for (const k in history) delete history[k];
  await post("/api/demo/start", { scenario: $("#scenario").value || "pandal_surge", speed: Number($("#speed").value) });
});
$("#demo-stop").addEventListener("click", () => post("/api/demo/stop", {}));

// ---------------------------------------------------------------- map
let mapBounds = null;
// A venue described by areas only (roomtobreathe venue new) gets a schematic: one square per zone, area to
// scale, placed in the order people walk in from outside. Positions are not real.
function schematic(v) {
  const order = [], seen = new Set(["outside"]);
  let frontier = ["outside"];
  while (frontier.length) {
    const next = [];
    for (const g of v.gates) {
      for (const [a, b] of [[g.from, g.to], [g.to, g.from]]) {
        if (frontier.includes(a) && !seen.has(b)) { seen.add(b); order.push(b); next.push(b); }
      }
    }
    frontier = next;
  }
  for (const z of v.zones) if (!seen.has(z.id)) order.push(z.id);
  let x = 0;
  for (const id of order) {
    const z = v.zones.find((q) => q.id === id);
    const side = Math.sqrt(Math.max(1, z.area_m2));
    z.polygon = [[x, 0], [x + side, 0], [x + side, side], [x, side]];
    x += side;
  }
  v.schematic = true;
}

function drawMap() {
  const svg = $("#map");
  if (!venue.zones.some((z) => z.polygon.length)) schematic(venue);
  const pts = venue.zones.flatMap((z) => z.polygon);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const pad = 6;
  mapBounds = { minx: Math.min(...xs) - pad, maxx: Math.max(...xs) + pad, miny: Math.min(...ys) - pad, maxy: Math.max(...ys) + pad };
  const w = mapBounds.maxx - mapBounds.minx, h = mapBounds.maxy - mapBounds.miny;
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  const P = ([x, y]) => [x - mapBounds.minx, mapBounds.maxy - y]; // flip y: north up
  const centroid = (poly) => P([poly.reduce((s, p) => s + p[0], 0) / poly.length, poly.reduce((s, p) => s + p[1], 0) / poly.length]);
  let html = "";
  for (const z of venue.zones) {
    const d = z.polygon.map(P).map((p) => p.join(",")).join(" ");
    const [cx, cy] = centroid(z.polygon);
    const zb = bbox(z.polygon);
    const fs = Math.min(3.2, (zb.x1 - zb.x0) * 0.92 / (z.name.length * 0.56)); // shrink to fit
    html += `<polygon class="zone" data-zone="${esc(z.id)}" points="${d}" style="fill:var(--unknown)"><title>${esc(z.name)}</title></polygon>`;
    html += `<text class="zlabel" x="${cx}" y="${cy - 1}" text-anchor="middle" style="font-size:${fs}px">${esc(z.name)}</text>`;
    html += `<text class="zsub" data-zsub="${esc(z.id)}" x="${cx}" y="${cy + 3}" text-anchor="middle">-</text>`;
  }
  // Gates are drawn on the shared edge of the two zones they connect, or on
  // the zone edge for exits to the outside.
  for (const g of venue.gates) {
    const seg = gateSegment(g);
    if (!seg) continue;
    const [a, b] = seg.map(P);
    html += `<line class="gate ${g.open ? "open" : "closed"}" data-gate="${esc(g.id)}" x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}"><title>${esc(g.name)} (${g.width_m} m)</title></line>`;
    html += `<text class="glabel" x="${(a[0] + b[0]) / 2 + 1.2}" y="${(a[1] + b[1]) / 2 - 1}">${esc(g.id)}</text>`;
  }
  if (venue.schematic) {
    html += `<text class="glabel" x="1" y="${h - 1}" style="font-size:${(w / 40).toFixed(2)}px">`
      + "Schematic: areas to scale, positions not real</text>";
  }
  svg.innerHTML = html;
}

function zoneById(id) { return venue.zones.find((z) => z.id === id); }
function bbox(poly) {
  const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}
function gateSegment(g) {
  const a = g.from !== "outside" ? zoneById(g.from) : null;
  const b = g.to !== "outside" ? zoneById(g.to) : null;
  const half = g.width_m / 2;
  if (a && b) {
    const A = bbox(a.polygon), B = bbox(b.polygon);
    const ov = (lo1, hi1, lo2, hi2) => [Math.max(lo1, lo2), Math.min(hi1, hi2)];
    if (Math.abs(A.x1 - B.x0) < 0.5 || Math.abs(B.x1 - A.x0) < 0.5) {
      const x = Math.abs(A.x1 - B.x0) < 0.5 ? A.x1 : A.x0;
      const [y0, y1] = ov(A.y0, A.y1, B.y0, B.y1), cy = (y0 + y1) / 2;
      return [[x, cy - half], [x, cy + half]];
    }
    const y = Math.abs(A.y1 - B.y0) < 0.5 ? A.y1 : A.y0;
    const [x0, x1] = ov(A.x0, A.x1, B.x0, B.x1), cx = (x0 + x1) / 2;
    return [[cx - half, y], [cx + half, y]];
  }
  const z = a || b;
  if (!z) return null;
  const Z = bbox(z.polygon);
  const all = bbox(venue.zones.flatMap((q) => q.polygon));
  const cy = (Z.y0 + Z.y1) / 2, cx = (Z.x0 + Z.x1) / 2;
  if (Z.x0 <= all.x0 + 0.5) return [[Z.x0, cy - half], [Z.x0, cy + half]];
  if (Z.x1 >= all.x1 - 0.5) return [[Z.x1, cy - half], [Z.x1, cy + half]];
  return [[cx - half, Z.y1], [cx + half, Z.y1]];
}

// ---------------------------------------------------------------- render
const COLORS = { GREEN: "var(--green)", YELLOW: "var(--yellow)", ORANGE: "var(--orange)", RED: "var(--red)", UNKNOWN: "var(--unknown)" };
const fmt1 = (v, d = 1) => (v === null || v === undefined ? "-" : Number(v).toFixed(d));
function fmtTtc(s) {
  if (s === null || s === undefined) return "not filling";
  if (s <= 0) return "CRITICAL NOW";
  if (s < 90) return `${Math.round(s)} s`;
  if (s > 3600) return "> 1 h";
  return `${Math.round(s / 60)} min`;
}
function fmtClock(sec) {
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function render(st) {
  const badge = $("#mode-badge");
  badge.textContent = st.mode.toUpperCase();
  badge.classList.toggle("demo", st.mode === "demo");
  $("#clock").textContent = st.mode === "demo" ? `scenario “${st.scenario}” · t = ${fmtClock(st.sim_t)}` : new Date(st.ts * 1000).toLocaleTimeString();

  const permit = st.permitted_capacity;
  const pct = permit ? st.occupancy_total / permit : 0;
  $("#occ-fill").style.width = `${Math.min(100, pct * 100)}%`;
  $("#occ-fill").style.background = pct >= 1 ? "var(--red)" : pct >= 0.85 ? "var(--orange)" : pct >= 0.6 ? "var(--yellow)" : "var(--green)";
  $("#occ-text").textContent = permit ? `${st.occupancy_total.toLocaleString()} / ${permit.toLocaleString()} (${Math.round(pct * 100)}%)` : `${st.occupancy_total.toLocaleString()} people`;

  for (const z of st.zones) {
    const h = (history[z.zone_id] ??= []);
    if (z.density !== null) h.push(z.density);
    if (h.length > 240) h.shift();
    const poly = document.querySelector(`polygon[data-zone="${CSS.escape(z.zone_id)}"]`);
    if (poly) poly.style.fill = `color-mix(in srgb, ${COLORS[z.level]} 70%, var(--panel))`;
    const sub = document.querySelector(`text[data-zsub="${CSS.escape(z.zone_id)}"]`);
    if (sub) sub.textContent = z.density === null ? "no data" : `${fmt1(z.density)} p/m²`;
  }
  for (const g of st.gates) {
    const line = document.querySelector(`line[data-gate="${CSS.escape(g.id)}"]`);
    if (line) line.setAttribute("class", `gate ${g.open && g.factor > 0 ? "open" : "closed"}`);
  }
  renderZones(st);
  renderAlerts(st);
  $("#log").innerHTML = [...st.actions.map((a) => `<li>${esc(a.by)}: ${esc(a.action.type)} ${esc(a.action.gate || a.action.message || a.action.role || "")} → ${esc(a.result)}</li>`),
    ...st.sim_log.map((l) => `<li class="muted">${esc(l)}</li>`)].join("") || `<li class="muted">Nothing yet.</li>`;
  for (const b of document.querySelectorAll("#triggers button")) {
    const on = st.zones.some((z) => z.triggers.includes(b.dataset.trigger));
    b.setAttribute("aria-pressed", String(on));
  }
}

function spark(values, crit) {
  if (values.length < 2) return "";
  const max = Math.max(crit * 1.1, ...values);
  const w = 200, h = 34;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - (v / max) * h}`).join(" ");
  const cy = h - (crit / max) * h;
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><line class="crit" x1="0" x2="${w}" y1="${cy}" y2="${cy}"/><polyline class="spark" points="${pts}"/></svg>`;
}

function renderZones(st) {
  $("#zones").innerHTML = st.zones.map((z) => {
    const crit = zoneById(z.zone_id)?.thresholds?.critical ?? 6.5;
    const ttcCls = z.ttc_s !== null && z.ttc_s < 600 ? "ttc-warn" : "";
    return `<div class="zcard ${z.level}">
      <div class="small muted">${esc(z.name)} · <span class="lvl">${z.level}</span></div>
      <div class="big">${fmt1(z.density)} <span class="small muted">p/m² ±${fmt1(z.density_sigma)}</span></div>
      <dl>
        <dt>People</dt><dd>${z.occupancy?.toLocaleString() ?? "-"}</dd>
        <dt>Trend</dt><dd>${z.trend_per_min === null ? "-" : (z.trend_per_min >= 0 ? "+" : "") + fmt1(z.trend_per_min, 2) + " /min"}</dd>
        <dt>Critical in</dt><dd class="${ttcCls}">${fmtTtc(z.ttc_s)}</dd>
        <dt>In / out</dt><dd>${fmt1(z.inflow_pps)} / ${fmt1(z.outflow_pps)} per s</dd>
        <dt>Speed</dt><dd>${fmt1(z.mean_speed, 2)} m/s</dd>
        <dt>Pressure</dt><dd>${fmt1(z.pressure, 3)} /s²</dd>
        ${z.stop_go_strength >= 0.4 && z.density >= 3 ? `<dt>Waves</dt><dd class="ttc-warn">stop-go ~${Math.round(z.stop_go_period_s)}s</dd>` : ""}
      </dl>
      ${spark(history[z.zone_id] || [], crit)}
    </div>`;
  }).join("");
}

function describe(a) {
  const tgt = a.gate_name ? `${a.gate_name} (${a.gate})` : "";
  switch (a.type) {
    case "close_gate": return `Close ${tgt}`;
    case "open_gate": return `Open ${tgt}`;
    case "meter_gate": return `Meter ${tgt} to ${Math.round((a.factor ?? 0.5) * 100)}%`;
    case "announce": return `Announce “${a.message}”`;
    case "dispatch": return `Dispatch ${a.count ?? ""} ${a.role}`;
    case "stop_programme": return "Pause the programme";
    case "notify": return `Notify ${a.role}`;
    case "cell_broadcast": return "Send cell broadcast";
    default: return a.type;
  }
}

let alertsKey = "";
function renderAlerts(st) {
  const box = $("#alerts");
  // Re-render only when something changed, so buttons are not replaced under the cursor.
  const key = st.alerts.map((a) => a.id).join() + "|" + executed.size;
  if (key === alertsKey) return;
  alertsKey = key;
  if (!st.alerts.length) { box.innerHTML = `<p class="muted">No alerts yet.</p>`; return; }
  // Active alerts (latest per zone, not GREEN) first, most severe on top; then history.
  const rank = { RED: 4, ORANGE: 3, UNKNOWN: 3, YELLOW: 2, GREEN: 0 };
  const seen = new Set(), active = [], past = [];
  for (const al of st.alerts) {
    if (!seen.has(al.zone_id) && al.level !== "GREEN") active.push(al);
    else past.push(al);
    seen.add(al.zone_id);
  }
  active.sort((a, b) => rank[b.level] - rank[a.level] || b.ts - a.ts);
  const activeIds = new Set(active.map((a) => a.id));
  const ordered = [...active, ...past.slice(0, 12)];
  box.innerHTML = (active.length ? "" : `<p class="muted small">No active alerts. All zones normal.</p>`) + ordered.map((al, idx) => {
    const isLatest = activeIds.has(al.id);
    const sep = idx === active.length && past.length ? `<h2 style="margin-top:6px">Earlier</h2>` : "";
    const t = st.mode === "demo" ? `t=${fmtClock(al.ts - (st.ts - st.sim_t))}` : new Date(al.ts * 1000).toLocaleTimeString();
    const acts = isLatest ? al.actions.map((a, i) => {
      const key = `${al.id}:${i}`;
      const done = executed.has(key);
      const txt = a.text ? Object.entries(a.text).map(([l, s]) => `<div class="announce"><b>${esc(l)}</b> ${esc(s)}</div>`).join("") : "";
      return `<div class="action ${done ? "done" : ""}"><div class="txt">${esc(describe(a))}${a.note ? ` <span class="muted small">· ${esc(a.note)}</span>` : ""}${txt}</div>
        <button data-exec="${esc(key)}" ${done ? "disabled" : ""}>${done ? "Done" : "Execute"}</button></div>`;
    }).join("") : "";
    const execAll = isLatest && al.actions.length > 1 && !al.actions.every((_, i) => executed.has(`${al.id}:${i}`))
      ? `<button class="primary" data-exec-all="${esc(al.id)}">Execute all ${al.actions.length}</button>` : "";
    return `${sep}<div class="alert ${al.level} ${isLatest ? "" : "past"}">
      <div class="alert-head"><span>${esc(al.zone_name)}: <span class="lvl">${al.previous} → ${al.level}</span></span>
      <span class="small muted">${t} · <a href="/api/alerts/${encodeURIComponent(al.id)}/cap" target="_blank" rel="noopener">CAP</a></span></div>
      ${al.reasons.length ? `<ul class="small">${al.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
      ${acts ? `<div class="actions">${acts}${execAll}</div>` : ""}
    </div>`;
  }).join("");
  box.dataset.alerts = JSON.stringify(st.alerts.map((a) => [a.id, a.actions]));
}

$("#alerts").addEventListener("click", async (e) => {
  const all = JSON.parse($("#alerts").dataset.alerts || "[]");
  const one = e.target.closest("button[data-exec]");
  const many = e.target.closest("button[data-exec-all]");
  if ((one || many) && !auth.name && !(await signIn("Enter your name first: the action log records who approved each action."))) return;
  const run = async (alertId, i) => {
    const entry = all.find(([id]) => id === alertId);
    if (!entry || executed.has(`${alertId}:${i}`)) return true;
    try {
      await post("/api/actions", { action: entry[1][i], by: auth.name || "operator" });
    } catch (err) {
      // Never show an action as done when the server did not record it.
      alert(`This action was NOT recorded (${err.message}). Carry it out by radio and try again.`);
      return false;
    }
    executed.add(`${alertId}:${i}`);
    return true;
  };
  if (one) {
    const [id, i] = one.dataset.exec.split(/:(?=\d+$)/);
    one.disabled = true;
    if (!(await run(id, Number(i)))) one.disabled = false;
  } else if (many) {
    many.disabled = true;
    const entry = all.find(([id]) => id === many.dataset.execAll);
    let ok = true;
    for (let i = 0; i < (entry?.[1].length || 0) && ok; i++) ok = await run(many.dataset.execAll, i);
    if (!ok) many.disabled = false;
  }
});

// ---------------------------------------------------------------- planner
const exitsBox = $("#exits");
function exitRow(w = 3, stairs = false) {
  const row = document.createElement("div");
  row.className = "exit-row";
  row.innerHTML = `<input type="number" step="0.1" min="0.5" value="${w}" aria-label="Exit width in metres"> m
    <label class="small"><input type="checkbox" ${stairs ? "checked" : ""}> stairs</label>
    <button type="button" aria-label="Remove exit">×</button>`;
  row.querySelector("button").onclick = () => { row.remove(); plan(); };
  exitsBox.append(row);
}
for (const [w, s] of store.get("plan-exits", [[4, false], [3, false], [2.5, false]])) exitRow(w, s);
$("#add-exit").onclick = () => { exitRow(); plan(); };

function readExits() {
  return [...exitsBox.querySelectorAll(".exit-row")].map((r) => ({
    width_m: Number(r.querySelector("input[type=number]").value) || 0,
    stairs: r.querySelector("input[type=checkbox]").checked,
  }));
}

let lastPlan = null;
function plan() {
  const f = new FormData($("#cap-form"));
  const exits = readExits();
  store.set("plan-exits", exits.map((e) => [e.width_m, e.stairs]));
  const usable = Number(f.get("area")) * Number(f.get("usable"));
  const cap = computeCapacity(usable, exits, Number(f.get("density")), Number(f.get("evac")) * 60);
  $("#cap-out").innerHTML = `<div class="kpis">
      <div class="kpi"><div class="small muted">Ground holds</div><div class="v">${cap.area_capacity.toLocaleString()}</div></div>
      <div class="kpi"><div class="small muted">Exits drain (1 blocked)</div><div class="v">${cap.egress_capacity_largest_blocked.toLocaleString()}</div></div>
      <div class="kpi hl"><div class="small muted">Safe capacity</div><div class="v">${cap.safe_capacity.toLocaleString()}</div></div>
      <div class="kpi"><div class="small muted">Evacuation time</div><div class="v">${cap.evac_time_at_safe_capacity_s ? (cap.evac_time_at_safe_capacity_s / 60).toFixed(1) + " min" : "-"}</div></div>
    </div>
    <p class="small muted">Limited by: ${esc(cap.limiting_factor)}</p>
    ${cap.findings.map((x) => `<p class="small">⚠ ${esc(x)}</p>`).join("")}`;

  const r = new FormData($("#risk-form"));
  const num = (k) => Number(r.get(k)) || 0;
  const profile = {
    event_type: r.get("event_type"),
    expected_attendance: num("expected_attendance"),
    safe_capacity: cap.safe_capacity,
    police: num("police"), marshals: num("marshals"), medical_posts: num("medical_posts"),
    ambulances: num("ambulances"), exits: exits.length,
    past_incidents_at_site: num("past_incidents_at_site"),
    elderly_or_children_share: num("elderly_or_children_share"),
    weather: r.get("weather"),
    terrain: r.getAll("terrain"),
    free_distribution: r.has("free_distribution"), vip_or_celebrity: r.has("vip_or_celebrity"),
    fixed_start_or_end: r.has("fixed_start_or_end"), night: r.has("night"), live_monitoring: r.has("live_monitoring"),
  };
  const risk = assessRisk(profile);
  lastPlan = { cap, risk, profile };
  const lv = { LOW: "GREEN", MODERATE: "YELLOW", HIGH: "ORANGE", SEVERE: "RED" }[risk.tier];
  const verdict = { approve: "Can be approved", approve_with_conditions: "Approve only with the conditions below", do_not_approve: "Do NOT approve at this size" }[risk.approve];
  $("#risk-out").innerHTML = `<div class="verdict ${risk.approve === "do_not_approve" ? "RED" : lv}">
      Risk ${risk.tier} (${risk.score}/100) · ${verdict}</div>
    <ul class="factors">${risk.factors.map((x) => `<li><span class="pts">+${x.points}</span><b>${esc(x.finding)}</b><div class="rec">→ ${esc(x.recommendation)}</div></li>`).join("")}</ul>`;
}
$("#cap-form").addEventListener("input", plan);
// These forms update as you type; Enter must not submit them (that reloads the page and loses the answers).
for (const id of ["#cap-form", "#risk-form"]) $(id).addEventListener("submit", (e) => { e.preventDefault(); plan(); });
$("#risk-form").addEventListener("input", plan);
$("#risk-form").addEventListener("change", plan);
$("#print-plan").onclick = () => window.print();
plan();

// ---------------------------------------------------------------- counter
let count = store.get("cnt", 0);
const permitEl = $("#cnt-permit");
permitEl.value = store.get("cnt-permit", permitEl.value);
function renderCount() {
  const permit = Number(permitEl.value) || 1;
  const pct = count / permit;
  $("#cnt-display").textContent = count.toLocaleString();
  $("#cnt-pct").textContent = `${Math.round(pct * 100)}% of permit` + (pct >= 1 ? ": STOP ENTRY" : pct >= 0.85 ? ": slow entry down" : "");
  $("#cnt-fill").style.width = `${Math.min(100, pct * 100)}%`;
  $("#cnt-fill").style.background = pct >= 1 ? "var(--red)" : pct >= 0.85 ? "var(--orange)" : pct >= 0.6 ? "var(--yellow)" : "var(--green)";
}
const deviceId = store.get("device", null) || (() => { const d = Math.random().toString(36).slice(2, 8); store.set("device", d); return d; })();
let sendTimer = null;
function queueSend() {
  const zone = $("#cnt-zone").value;
  if (!online || !zone) return;
  clearTimeout(sendTimer);
  sendTimer = setTimeout(() => post("/api/observations", [{ zone_id: zone, source: `counter-${deviceId}`, count, density_sigma: 0.3 }]).catch(() => {}), 400);
}
$(".cnt-buttons").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-d]");
  if (!b) return;
  count = Math.max(0, count + Number(b.dataset.d));
  store.set("cnt", count);
  navigator.vibrate?.(15);
  renderCount();
  queueSend();
});
$("#cnt-reset").onclick = () => { if (confirm("Reset the counter to 0?")) { count = 0; store.set("cnt", 0); renderCount(); queueSend(); } };
permitEl.addEventListener("input", () => { store.set("cnt-permit", permitEl.value); renderCount(); });
$("#cnt-zone").addEventListener("change", (e) => store.set("cnt-zone", e.target.value));
renderCount();

boot();
