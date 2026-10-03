/**
 * Arena — Live-Sport, Spielplan, Tabellen und Teams.
 *
 * - Live: alle Spiele von heute als Leiste (Wappen 2:1 Wappen; laufende Spiele tragen ihre Spielzeit als
 *   Lichtstrich), darunter das gewaehlte Spiel gross mit Spielfeld (Ballverlauf) und Ticker.
 * - Spielplan: eine Woche zurueck bis drei Wochen voraus, nach Tagen; „Heute“ steht oben.
 * - Tabelle: Zonen als Lichtstrich in ihrer Farbe; eine Zeile antippen zeigt das Team.
 * - Teams: naechstes Spiel und Form (letzte fuenf als Lichtpunkte) deiner Teams.
 * Einstellungen sind dieselben wie in der Notch und werden mit ihr abgeglichen.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { glassLight, ICONS, lightScroller, liquid, segments, windowControls } from "./nojo/nojo-ui";
import { bugEl, clockOf, crestEl, kickoff, Pitch, scoreOf, tickerEl, type SportMatch, type SportPlay, type SportState, type SportTeam } from "./sport-ui";
import { crestOf, DEFAULT_SPORT, renderSettings, type FavTeam, type LeagueInfo, type Snapshot } from "./settings-ui";

const q = <T extends Element = HTMLElement>(s: string, root: ParentNode = document) => root.querySelector(s) as T;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const announce = (t: string) => { q(".sr").textContent = t; };

type View = "live" | "plan" | "table" | "teams";
let view: View = "live";
let live: SportState = { matches: [] };
let focusKey = "";
let snap: Snapshot = { sport: { ...DEFAULT_SPORT }, notch: false, pending: false };
let leagues: LeagueInfo[] = [];
const pitch = new Pitch();

const DAY = 86_400_000;
const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();
const timeOf = (t: number) => new Date(t).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
const norm = (n: string) => n.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\b(1|fc|sv|vfl|vfb|tsg|sc|fsv|spvgg|bsc)\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const isFavTeam = (t: SportTeam) => snap.sport.teams.some((f) => f.key === t.id || norm(f.name) === norm(t.name));

/** Spielzeit 0..1 (Fussball 90 Min, sonst nach Abschnitt) — der Lichtstrich unter laufenden Spielen */
function progress(m: SportMatch) {
  if (m.state === "post") return 1;
  if (m.state !== "in") return 0;
  if (m.clock === "Halbzeit") return 0.5;
  const min = /^(\d+)(?:\+(\d+))?'/.exec(m.clock);
  if (m.sport === "soccer" && min) return Math.min(1, (Number(min[1]) + Number(min[2] ?? 0)) / 90);
  const per = /^(\d+)\./.exec(m.clock);
  const parts = m.sport === "hockey" ? 3 : m.sport === "baseball" ? 9 : 4;
  return per ? Math.min(1, Number(per[1]) / parts) : 0.5;
}

/** „in 2 Tagen“, „in 3 Std 20 Min“, „in 12 Min“ */
function countdown(t: number) {
  const d = t - Date.now();
  if (d <= 0) return "jetzt";
  const min = Math.round(d / 60_000);
  if (min < 60) return `in ${min} Min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `in ${h} Std${min % 60 ? ` ${min % 60} Min` : ""}`;
  const days = Math.round(d / DAY);
  return days === 1 ? "morgen" : `in ${days} Tagen`;
}

function dayLabel(t: number) {
  const now = Date.now();
  const d = new Date(t);
  const date = d.toLocaleDateString("de-DE", { weekday: "short", day: "numeric", month: "short" }).replace(/\.,/, ",");
  if (sameDay(t, now)) return `Heute · ${date}`;
  if (sameDay(t, now + DAY)) return `Morgen · ${date}`;
  if (sameDay(t, now - DAY)) return `Gestern · ${date}`;
  return date;
}

// ---------- Ansichten ----------

function setView(v: View) {
  view = v;
  document.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((b) => {
    const on = b.dataset.view === v;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", String(on));
  });
  document.querySelectorAll<HTMLElement>(".view").forEach((s) => { s.hidden = s.dataset.view !== v; });
  try { localStorage.setItem("arena-view", v); } catch { /* egal */ }
  q("main").scrollTop = 0;
  if (v === "live") renderLive();
  if (v === "plan") void loadPlan();
  if (v === "table") renderTables();
  if (v === "teams") void renderTeams();
}

// ---------- Live ----------

let focusSig = "";

function focusMatch(): SportMatch | undefined {
  const ms = live.matches;
  return ms.find((m) => m.key === focusKey)
    ?? ms.find((m) => m.state === "in" && m.fav)
    ?? ms.find((m) => m.state === "in")
    ?? ms.find((m) => m.fav)
    ?? ms[0];
}

function tile(m: SportMatch, on: boolean) {
  const b = el("button", `tile n-card ${m.state}` + (on ? " on" : "") + (m.fav ? " fav" : ""));
  b.title = `${m.home.name} – ${m.away.name} · ${m.league_name}`;
  b.style.setProperty("--hc", m.home.color);
  b.style.setProperty("--ac", m.away.color);
  b.append(bugEl(m, scoreOf(m), "bug"), el("small", "t-clock", clockOf(m)));
  // Lichtstrich: so weit ist das Spiel (nur laufende)
  if (m.state === "in") {
    const p = el("i", "prog");
    p.style.setProperty("--p", String(progress(m)));
    b.append(p);
  }
  b.addEventListener("click", () => { focusKey = m.key; renderLive(); });
  return b;
}

function renderLive() {
  if (view !== "live") return;
  const strip = q(".strip");
  const f = focusMatch();
  const ms = live.matches;
  strip.replaceChildren(...ms.map((m) => tile(m, m.key === f?.key)));
  strip.hidden = ms.length < 2;
  const box = q(".focus");
  if (!f) {
    focusSig = "";
    renderEmpty(box);
    return;
  }
  const sig = JSON.stringify([f.key, f.home.score, f.away.score, f.clock, f.state, f.events.map((e) => e.id)]);
  if (sig === focusSig) return;
  focusSig = sig;
  box.replaceChildren(focusEl(f));
}

function focusEl(f: SportMatch) {
  const wrap = el("article", `big ${f.state}`);
  wrap.style.setProperty("--hc", f.home.color);
  wrap.style.setProperty("--ac", f.away.color);
  const head = el("div", "big-head");
  head.append(el("span", "n-eyebrow", f.league_name), el("span", `big-clock ${f.state}`, f.state === "pre" ? `${kickoff(f)} · ${countdown(f.start)}` : clockOf(f)));
  if (f.link) {
    const open = el("button", "n-ico sm n-glass n-liquid");
    open.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6h9v9"/><path d="M18 6 6 18"/></svg>`;
    open.title = "Spielseite im Browser öffnen";
    open.setAttribute("aria-label", open.title);
    open.addEventListener("click", () => void invoke("open_link", { url: f.link }).catch(() => {}));
    head.append(open);
  }
  const score = el("div", "big-score");
  score.title = `${f.home.name} – ${f.away.name}`;
  const num = el("div", "big-num");
  if (f.state === "pre") num.append(el("span", "big-ko", timeOf(f.start)));
  else num.append(el("b", "", f.home.score || "0"), el("i", "", ":"), el("b", "", f.away.score || "0"));
  score.append(crestEl(f.home, "crest big-crest"), num, crestEl(f.away, "crest big-crest"));
  const usePitch = f.pitch && f.source === "espn" && f.state !== "pre";
  const body = el("div", "big-body" + (usePitch ? " with-pitch" : ""));
  if (usePitch) {
    pitch.setMatch(f);
    const pw = el("div", "pitch-card n-card");
    pw.append(pitch.el);
    body.append(pw);
  }
  const tk = el("div", "ticker-card n-card");
  tk.append(el("div", "n-eyebrow", "Ticker"), tickerEl(f, 14));
  body.append(tk);
  wrap.append(head, score, body);
  return wrap;
}

/** Kein Spiel heute: das naechste (deine Teams zuerst) mit Countdown */
function renderEmpty(box: HTMLElement) {
  const next = (plan ?? []).filter((m) => m.start > Date.now()).sort((a, b) => Number(b.fav) - Number(a.fav) || a.start - b.start)[0];
  const e = el("div", "empty");
  e.append(el("p", "empty-title", live.error ? live.error : "Gerade kein Spiel"));
  if (next) {
    const c = el("button", "next n-card");
    c.title = `${next.home.name} – ${next.away.name}`;
    c.append(el("span", "n-eyebrow", `Als Nächstes · ${next.league_name}`), bugEl(next, "–", "next-bug"),
      el("span", "next-when", `${dayLabel(next.start).replace(/^Heute · .*/, "Heute")} · ${timeOf(next.start)} · ${countdown(next.start)}`));
    c.addEventListener("click", () => setView("plan"));
    e.append(c);
  } else if (!plan) void loadPlan(false, true);
  box.replaceChildren(e);
}

// Ballverlauf: nur holen, solange das Spielfeld zu sehen ist
let watching = "";
let watchAt = 0;
function tickWatch() {
  const f = focusMatch();
  const visible = view === "live" && !document.hidden && !!f && pitch.el.isConnected && f.pitch && f.source === "espn" && f.state !== "pre";
  const key = visible ? f!.key : "";
  if (key !== watching || (key && Date.now() - watchAt > 8000)) {
    watching = key;
    watchAt = Date.now();
    invoke("sport_watch", { key: key || null }).catch(() => {});
  }
  pitch.run(!!key);
}

// ---------- Spielplan ----------

let plan: SportMatch[] | null = null;
let planAt = 0;
let planLoading = false;
let planErr = "";
let planScope: "all" | "fav" = "all";
const planOff = new Set<string>();
let planScrolled = false;

async function loadPlan(force = false, quiet = false) {
  if (planLoading) return;
  if (!force && plan && Date.now() - planAt < 5 * 60_000) { if (!quiet) renderPlan(); return; }
  planLoading = true;
  if (!quiet) renderPlan();
  try {
    plan = await invoke<SportMatch[]>("schedule");
    planAt = Date.now();
    planErr = "";
  } catch (e) {
    planErr = String(e);
  }
  planLoading = false;
  if (view === "plan") renderPlan();
  if (view === "live" && !live.matches.length) renderLive();
}

function prow(m: SportMatch) {
  const lv = live.matches.find((x) => x.key === m.key) ?? m;
  const r = el("button", `prow ${lv.state}` + (lv.fav ? " fav" : ""));
  r.title = `${lv.home.name} – ${lv.away.name} · ${lv.league_name}`;
  const when = el("span", "p-when");
  if (lv.state === "pre") when.textContent = timeOf(lv.start);
  else if (lv.state === "in") when.append(el("i", "live-dot"), clockOf(lv));
  else when.textContent = clockOf(lv) === "Ende" ? timeOf(lv.start) : clockOf(lv);
  const mid = el("span", "p-match");
  mid.append(crestEl(lv.home), el("b", "", lv.state === "pre" ? "–" : scoreOf(lv)), crestEl(lv.away));
  r.append(when, mid, el("span", "p-league", lv.league_name));
  r.addEventListener("click", () => {
    if (live.matches.some((x) => x.key === lv.key)) { focusKey = lv.key; setView("live"); }
    else if (lv.link) void invoke("open_link", { url: lv.link }).catch(() => {});
  });
  return r;
}

function renderPlan() {
  const chips = q(".plan-leagues");
  chips.replaceChildren(...snap.sport.leagues.map((id) => {
    const b = el("button", "", leagues.find((l) => l.id === id)?.name ?? id);
    b.setAttribute("aria-pressed", String(!planOff.has(id)));
    b.addEventListener("click", () => { if (planOff.has(id)) planOff.delete(id); else planOff.add(id); renderPlan(); });
    return b;
  }));
  document.querySelectorAll<HTMLButtonElement>(".plan-scope button").forEach((b) => b.classList.toggle("active", b.dataset.scope === planScope));
  const box = q(".plan");
  if (!plan) {
    box.replaceChildren(el("p", "faint pad", planLoading ? "Spielplan wird geladen …" : planErr || "Noch nichts geladen"));
    return;
  }
  const list = plan.filter((m) => !planOff.has(m.league) && (planScope === "all" || m.fav));
  if (!list.length) {
    box.replaceChildren(el("p", "faint pad", planScope === "fav" ? "Keine Spiele deiner Teams in diesen drei Wochen." : "Keine Spiele in diesem Zeitraum."));
    return;
  }
  const out: HTMLElement[] = [];
  let day = "";
  let today: HTMLElement | null = null;
  let group: HTMLElement | null = null;
  for (const m of list) {
    const d = new Date(m.start).toDateString();
    if (d !== day) {
      day = d;
      group = el("section", "day");
      const h = el("h3", "day-head n-liquid", dayLabel(m.start));
      group.append(h);
      out.push(group);
      if (!today && m.start >= new Date().setHours(0, 0, 0, 0)) today = group;
    }
    group!.append(prow(m));
  }
  box.replaceChildren(...out);
  if (!planScrolled && today) {
    planScrolled = true;
    requestAnimationFrame(() => { q("main").scrollTop = Math.max(0, today!.offsetTop - 120); });
  }
}

// ---------- Tabelle ----------

type Row = { rank: number; team: SportTeam; played: string; won: string; draw: string; lost: string; goals: string; diff: string; points: string; pct: string; behind: string; note: string; color: string; fav: boolean };
type Group = { name: string; rows: Row[] };
const NO_TABLE = new Set(["dfb", "dfbteam"]);
let tableLeague = "";
const tables = new Map<string, { at: number; groups?: Group[]; err?: string }>();

function renderTables() {
  const ids = snap.sport.leagues.filter((id) => !NO_TABLE.has(id));
  if (!ids.includes(tableLeague)) tableLeague = ids[0] ?? "";
  const chips = q(".table-leagues");
  chips.replaceChildren(...ids.map((id) => {
    const b = el("button", "", leagues.find((l) => l.id === id)?.name ?? id);
    b.setAttribute("aria-pressed", String(id === tableLeague));
    b.addEventListener("click", () => { tableLeague = id; renderTables(); });
    return b;
  }));
  const box = q(".tables");
  if (!tableLeague) { box.replaceChildren(el("p", "faint pad", "Wähle Wettbewerbe mit Tabelle in den Einstellungen.")); return; }
  const c = tables.get(tableLeague);
  if (!c || Date.now() - c.at > 10 * 60_000) {
    if (!c) box.replaceChildren(el("p", "faint pad", "Tabelle wird geladen …"));
    const want = tableLeague;
    tables.set(want, { ...(c ?? {}), at: Date.now() });
    invoke<Group[]>("standings", { league: want })
      .then((g) => tables.set(want, { at: Date.now(), groups: g }))
      .catch((e) => tables.set(want, { at: Date.now(), err: String(e) }))
      .finally(() => { if (view === "table" && tableLeague === want) renderTables(); });
    if (!c) return;
  }
  if (c?.err) { box.replaceChildren(el("p", "faint pad", c.err)); return; }
  if (!c?.groups) return;
  const sport = leagues.find((l) => l.id === tableLeague)?.sport ?? "soccer";
  const us = sport !== "soccer";
  const out: HTMLElement[] = [];
  const notes = new Map<string, string>();
  for (const g of c.groups) {
    const t = el("section", "table n-card");
    if (c.groups.length > 1 || g.name) t.append(el("div", "n-eyebrow t-name", g.name));
    const head = el("div", "trow thead" + (us ? " us" : ""));
    const cols = us ? ["#", "", "S", "N", "Quote", sport === "hockey" ? "Pkt" : "Rückst."] : ["#", "", "Sp", "S", "U", "N", "Tore", "+/–", "Pkt"];
    head.append(...cols.map((x) => el("span", "", x)));
    t.append(head);
    for (const r of g.rows) {
      const row = el("button", "trow" + (us ? " us" : "") + (r.fav || isFavTeam(r.team) ? " fav" : ""));
      row.title = r.note ? `${r.team.name} · ${r.note}` : r.team.name;
      if (r.color) { row.style.setProperty("--z", r.color); row.classList.add("zone"); notes.set(r.note, r.color); }
      const team = el("span", "t-team");
      team.append(crestEl(r.team), el("span", "t-short", r.team.short || r.team.name));
      const cells = us
        ? [String(r.rank), team, r.won, r.lost, r.pct, sport === "hockey" ? r.points : r.behind]
        : [String(r.rank), team, r.played, r.won, r.draw, r.lost, r.goals, r.diff, r.points];
      row.append(...cells.map((x, i) => (typeof x === "string" ? el("span", i === cells.length - 1 ? "t-pts" : "", x) : x)));
      row.addEventListener("click", () => openTeam({ key: r.team.id, name: r.team.name, logo: r.team.logo }));
      t.append(row);
    }
    out.push(t);
  }
  if (notes.size) {
    const legend = el("div", "legend");
    for (const [n, color] of notes) {
      const i = el("span", "", n);
      i.style.setProperty("--z", color);
      legend.append(i);
    }
    out.push(legend);
  }
  box.replaceChildren(...out);
}

// ---------- Teams ----------

type TeamView = { next: SportMatch[]; last: SportMatch[] };
const teamViews = new Map<string, { at: number; v?: TeamView; err?: string; p?: Promise<void> }>();

function loadTeam(key: string): Promise<void> {
  const c = teamViews.get(key);
  if (c?.p) return c.p;
  if (c && Date.now() - c.at < 10 * 60_000) return Promise.resolve();
  const p = invoke<TeamView>("team_view", { key })
    .then((v) => { teamViews.set(key, { at: Date.now(), v }); })
    .catch((e) => { teamViews.set(key, { at: Date.now(), err: String(e) }); });
  teamViews.set(key, { ...(c ?? { at: 0 }), p });
  return p;
}

/** Ergebnis aus Sicht des Teams: s(ieg) u(nentschieden) n(iederlage) */
function result(m: SportMatch, t: FavTeam) {
  const home = m.home.id === t.key || norm(m.home.name) === norm(t.name);
  const a = Number(home ? m.home.score : m.away.score), b = Number(home ? m.away.score : m.home.score);
  return { r: a > b ? "s" : a < b ? "n" : "u", home, text: `${m.home.score}:${m.away.score}` };
}

/** Form: die letzten Ergebnisse als Lichtpunkte (aeltestes links), Tooltip mit Gegner und Ergebnis */
function formEl(t: FavTeam, last: SportMatch[]) {
  const f = el("div", "form");
  for (const m of [...last].reverse()) {
    const { r, home, text } = result(m, t);
    const opp = home ? m.away : m.home;
    const d = el("i", `f-${r}`);
    d.title = `${text} ${home ? "gegen" : "bei"} ${opp.name} · ${new Date(m.start).toLocaleDateString("de-DE")}`;
    f.append(d);
  }
  return f;
}

function nextEl(t: FavTeam, m: SportMatch | undefined) {
  const n = el("div", "t-next");
  if (!m) { n.append(el("span", "faint", "Kein Spiel angesetzt")); return n; }
  const lv = live.matches.find((x) => x.key === m.key) ?? m;
  const home = lv.home.id === t.key || norm(lv.home.name) === norm(t.name);
  const opp = home ? lv.away : lv.home;
  n.append(el("span", "t-vs", home ? "gegen" : "bei"), crestEl(opp, "crest"),
    el("span", "t-when", lv.state === "in" ? `live · ${scoreOf(lv)} · ${clockOf(lv)}` : `${dayLabel(lv.start).replace(/ · .*$/, "")} ${timeOf(lv.start)}`));
  n.title = `${lv.home.name} – ${lv.away.name} · ${lv.league_name} · ${countdown(lv.start)}`;
  return n;
}

async function renderTeams() {
  const grid = q(".team-grid");
  const teams = snap.sport.teams;
  const cards: HTMLElement[] = teams.map((t) => {
    const c = el("article", "team n-card");
    c.append(crestOf(t, "crest team-crest"), el("h3", "", t.name));
    const v = teamViews.get(t.key);
    if (v?.v) {
      c.append(el("span", "n-eyebrow", "Als Nächstes"), nextEl(t, v.v.next[0]), el("span", "n-eyebrow", "Form"), formEl(t, v.v.last));
    } else c.append(el("p", "faint", v?.err ?? "Wird geladen …"));
    c.addEventListener("click", () => openTeam(t));
    return c;
  });
  const add = el("button", "team add n-card");
  add.append(el("span", "plus", "+"), el("span", "", teams.length ? "Team hinzufügen" : "Wähle deine Teams"));
  add.addEventListener("click", () => openSettings());
  grid.replaceChildren(...cards, add);
  const missing = teams.filter((t) => !teamViews.get(t.key)?.v && !teamViews.get(t.key)?.err);
  if (missing.length) {
    await Promise.all(missing.map((t) => loadTeam(t.key)));
    if (view === "teams") void renderTeams();
  }
}

// ---------- Seitenblatt ----------

let sheetKind: "" | "settings" | "team" = "";
let sheetTeam: FavTeam | null = null;

function openSheet(kind: "settings" | "team", title: string | HTMLElement) {
  sheetKind = kind;
  const t = q(".sheet-title");
  t.replaceChildren(title);
  q(".backdrop").hidden = false;
  requestAnimationFrame(() => q(".backdrop").classList.add("show"));
}

function closeSheet() {
  sheetKind = "";
  sheetTeam = null;
  const b = q(".backdrop");
  b.classList.remove("show");
  window.setTimeout(() => { if (!sheetKind) b.hidden = true; }, 260);
}

function openSettings() {
  openSheet("settings", "Einstellungen");
  renderSheetSettings();
}

// ---------- Updates (update.rs) ----------

type Upd = { status: "idle" | "checking" | "current" | "available" | "downloading" | "error"; version?: string; current: string; message?: string };
let upd: Upd = { status: "idle", current: "" };

/** Punkt am Zahnrad: es gibt eine neue Version */
function renderUpd() {
  const g = q(".gear");
  g.querySelector(".n-dot")?.remove();
  if (upd.status === "available") g.append(el("i", "n-dot"));
  g.title = upd.status === "available" ? `Einstellungen · Arena ${upd.version} verfügbar` : "Einstellungen";
  const box = q(".app-card");
  if (box) box.replaceWith(appCard());
}

function appCard() {
  const c = el("section", "s-card n-card app-card");
  const h = el("div", "s-head");
  h.append(el("span", "n-eyebrow", "App"), el("span", "faint", upd.current ? `Arena ${upd.current}` : "Arena"));
  const text = {
    idle: "Sucht beim Start und alle 6 Stunden nach Updates.",
    checking: "Sucht …",
    current: "Aktuell.",
    available: `Version ${upd.version} ist da.`,
    downloading: "Wird geladen – Arena startet gleich neu …",
    error: upd.message ?? "Update-Prüfung fehlgeschlagen.",
  }[upd.status];
  const row = el("div", "app-row");
  row.append(el("span", upd.status === "error" ? "faint err" : "faint", text));
  const b = el("button", "n-btn" + (upd.status === "available" ? " primary" : ""), upd.status === "available" ? "Installieren" : "Nach Updates suchen");
  b.disabled = upd.status === "checking" || upd.status === "downloading";
  b.addEventListener("click", () => {
    if (upd.status === "available") void invoke("update_install").catch(() => {});
    else void invoke<Upd>("update_check").then((u) => { upd = u; renderUpd(); }).catch(() => {});
  });
  row.append(b);
  c.append(h, row);
  return c;
}

function renderSheetSettings() {
  if (sheetKind !== "settings") return;
  renderSettings(q(".sheet-body"), {
    leagues,
    snap,
    announce,
    commit: (sport) => {
      snap = { ...snap, sport };
      invoke<Snapshot>("settings_set", { sport }).then((s) => { snap = s; onSettings(false); }).catch(() => {});
      onSettings(false);
    },
  });
  q(".sheet-body").append(appCard());
}

async function openTeam(t: FavTeam) {
  sheetTeam = t;
  const title = el("span", "sheet-team");
  title.append(crestOf(t, "crest"), t.name);
  openSheet("team", title);
  renderSheetTeam();
  await loadTeam(t.key);
  if (sheetTeam?.key === t.key) renderSheetTeam();
}

function renderSheetTeam() {
  const t = sheetTeam;
  if (sheetKind !== "team" || !t) return;
  const body = q(".sheet-body");
  const mine = snap.sport.teams.some((x) => x.key === t.key);
  const fav = el("button", "n-btn" + (mine ? "" : " primary"), mine ? "Aus meinen Teams entfernen" : "Zu meinen Teams");
  fav.addEventListener("click", () => {
    const teams = mine ? snap.sport.teams.filter((x) => x.key !== t.key) : [...snap.sport.teams, { key: t.key, name: t.name, ...(t.logo ? { logo: t.logo } : {}) }];
    const sport = { ...snap.sport, teams };
    snap = { ...snap, sport };
    invoke<Snapshot>("settings_set", { sport }).then((s) => { snap = s; onSettings(false); }).catch(() => {});
    announce(mine ? `${t.name} entfernt` : `${t.name} hinzugefügt`);
    renderSheetTeam();
    onSettings(false);
  });
  const v = teamViews.get(t.key);
  const parts: HTMLElement[] = [fav];
  if (!v?.v) parts.push(el("p", "faint", v?.err ?? "Wird geladen …"));
  else {
    parts.push(el("div", "n-eyebrow", "Nächste Spiele"));
    if (!v.v.next.length) parts.push(el("p", "faint", "Kein Spiel angesetzt"));
    v.v.next.forEach((m) => { const r = prow(m); r.querySelector(".p-when")!.textContent = `${dayLabel(m.start).replace(/^(Heute|Morgen|Gestern) · .*/, "$1")} ${timeOf(m.start)}`; parts.push(r); });
    parts.push(el("div", "n-eyebrow", "Letzte Ergebnisse"));
    if (!v.v.last.length) parts.push(el("p", "faint", "Noch keine"));
    v.v.last.forEach((m) => {
      const r = prow(m);
      const { r: res } = result(m, t);
      r.classList.add(`res-${res}`);
      r.querySelector(".p-when")!.textContent = new Date(m.start).toLocaleDateString("de-DE", { day: "numeric", month: "short" });
      parts.push(r);
    });
    parts.push(el("div", "n-eyebrow", "Form"), formEl(t, v.v.last));
  }
  body.replaceChildren(...parts);
}

// ---------- Einstellungen / Abgleich ----------

function renderSync() {
  const s = q(".sync");
  s.classList.toggle("ok", snap.notch);
  s.classList.toggle("wait", !snap.notch && snap.pending);
  s.title = snap.notch ? "Mit der Notch abgeglichen: Teams und Wettbewerbe gelten in beiden"
    : snap.pending ? "Notch läuft nicht – Änderungen gehen beim nächsten Start hin" : "Notch läuft nicht";
}

/** Einstellungen haben sich geaendert (hier, in der Notch oder Verbindung) */
function onSettings(rerenderSheet = true) {
  renderSync();
  for (const m of live.matches) m.fav = isFavTeam(m.home) || isFavTeam(m.away);
  if (plan) for (const m of plan) m.fav = isFavTeam(m.home) || isFavTeam(m.away);
  const leagueKey = snap.sport.leagues.join(",");
  if (leagueKey !== lastLeagues) {
    lastLeagues = leagueKey;
    planAt = 0;
    if (view === "plan") void loadPlan(true);
  }
  if (view === "live") { focusSig = ""; renderLive(); }
  if (view === "plan") renderPlan();
  if (view === "table") renderTables();
  if (view === "teams") void renderTeams();
  if (rerenderSheet && sheetKind === "settings" && !document.activeElement?.closest(".sheet-body input")) renderSheetSettings();
  if (sheetKind === "team") renderSheetTeam();
}
let lastLeagues = "";

// ---------- Start ----------

async function main() {
  const win = getCurrentWindow();
  windowControls({
    minimize: () => void win.minimize().catch(() => {}),
    toggleMaximize: () => void win.toggleMaximize().catch(() => {}),
    close: () => void win.close().catch(() => {}),
  });
  q(".gear").innerHTML = ICONS.settings;
  q(".sheet-x").innerHTML = ICONS.close;
  glassLight();
  liquid();
  segments(document, ".n-seg");
  lightScroller(q("main"), { insetTop: 74 });

  document.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view as View)));
  document.querySelectorAll<HTMLButtonElement>(".plan-scope button").forEach((b) =>
    b.addEventListener("click", () => { planScope = b.dataset.scope === "fav" ? "fav" : "all"; renderPlan(); }));
  q(".gear").addEventListener("click", openSettings);
  q(".sheet-x").addEventListener("click", closeSheet);
  q(".backdrop").addEventListener("mousedown", (e) => { if (e.target === e.currentTarget) closeSheet(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && sheetKind) closeSheet();
    if (e.ctrlKey && /^[1-4]$/.test(e.key)) setView((["live", "plan", "table", "teams"] as View[])[Number(e.key) - 1]);
  });

  snap = await invoke<Snapshot>("settings_get").catch(() => snap);
  lastLeagues = snap.sport.leagues.join(",");
  leagues = await invoke<LeagueInfo[]>("sport_leagues").catch(() => []);
  await listen<Snapshot>("settings", (e) => { snap = e.payload; onSettings(); });
  await listen<Upd>("update", (e) => { upd = e.payload; renderUpd(); });
  upd = await invoke<Upd>("update_state").catch(() => upd);
  renderUpd();
  await listen<SportState>("sport", (e) => {
    live = e.payload;
    if (view === "live") renderLive();
    if (view === "plan" && plan) renderPlan();
  });
  await listen<{ key: string; reset: boolean; plays: SportPlay[] }>("sport-plays", (e) => {
    if (e.payload.key !== pitch.matchKey) return;
    if (e.payload.reset) pitch.reset(e.payload.plays); else pitch.add(e.payload.plays);
  });
  // Spiel aus der Notch (arena://spiel/…)
  await listen<string>("open-match", (e) => { focusKey = e.payload; void invoke("take_pending"); setView("live"); });
  const pending = await invoke<string | null>("take_pending").catch(() => null);
  if (pending) focusKey = pending;

  renderSync();
  let start: View = "live";
  try { start = (localStorage.getItem("arena-view") as View) || "live"; } catch { /* egal */ }
  setView(pending ? "live" : ["live", "plan", "table", "teams"].includes(start) ? start : "live");
  // Spielplan im Hintergrund vorbereiten (fuer „Als Nächstes“ und den Reiter)
  if (view !== "plan") void loadPlan(false, true);
  setInterval(tickWatch, 1000);
  setInterval(() => { if (view === "live") { focusSig = ""; renderLive(); } }, 30_000);
}

main();
