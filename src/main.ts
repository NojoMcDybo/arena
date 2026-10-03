/**
 * Arena — Live-Sport, Spielplan, Ligen und Teams.
 *
 * - Live: alle Spiele von heute (im Fenster als Leiste oben, breit/Vollbild als Spalte links), daneben das
 *   gewaehlte Spiel gross mit Spielfeld (Ballverlauf), Ticker und Analyse (Statistik, Druckphasen, Aufstellung;
 *   vor dem Spiel Prognose, Form, direkter Vergleich — detail-ui.ts).
 * - Spielplan: eine Woche zurueck bis drei Wochen voraus, nach Tagen; je Tag die Wettbewerbe nebeneinander.
 * - Ligen: je Sportart und Wettbewerb Tabelle, Spielplan und Schlagzeilen (Transfers markiert) nebeneinander.
 * - Teams: naechstes Spiel und Form deiner Teams; das Blatt zeigt Spiele und Kader.
 * Einstellungen sind dieselben wie in der Notch und werden mit ihr abgeglichen. F11 = Vollbild.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { glassLight, ICONS, lightScroller, liquid, segments, svgIcon, windowControls } from "./nojo/nojo-ui";
import { bugEl, clockOf, crestEl, kickoff, Pitch, scoreOf, tickerEl, type SportMatch, type SportPlay, type SportState, type SportTeam } from "./sport-ui";
import { crestOf, DEFAULT_SPORT, renderSettings, type FavTeam, type LeagueInfo, type Snapshot } from "./settings-ui";
import { card, detailCards, type MatchDetail } from "./detail-ui";
import { classify, initLaya, installLaya, labelOf, layaStatus, layaWork, onLaya, retryLaya, uninstallLaya } from "./laya/client";
import { KIND_DE, MIN_P, TRANSFER_KINDS, type Kind } from "./laya/questions";

const q = <T extends Element = HTMLElement>(s: string, root: ParentNode = document) => root.querySelector(s) as T;
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const announce = (t: string) => { q(".sr").textContent = t; };
const faint = (text: string, cls = "faint pad") => el("p", cls, text);

type View = "live" | "plan" | "leagues" | "teams";
const VIEWS: View[] = ["live", "plan", "leagues", "teams"];
let view: View = "live";
let live: SportState = { matches: [] };
let focusKey = "";
let snap: Snapshot = { sport: { ...DEFAULT_SPORT }, notch: false, pending: false };
let leagues: LeagueInfo[] = [];
const pitch = new Pitch();

const DAY = 86_400_000;
const SPORT_ORDER = ["soccer", "football", "basketball", "hockey", "baseball"];
const SPORT_NAME: Record<string, string> = { soccer: "Fußball", football: "Football", basketball: "Basketball", hockey: "Eishockey", baseball: "Baseball" };
const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();
const timeOf = (t: number) => new Date(t).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
const norm = (n: string) => n.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\b(1|fc|sv|vfl|vfb|tsg|sc|fsv|spvgg|bsc)\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const isFavTeam = (t: SportTeam) => snap.sport.teams.some((f) => f.key === t.id || norm(f.name) === norm(t.name));
const leagueInfo = (id: string) => leagues.find((l) => l.id === id);
const leagueName = (id: string) => leagueInfo(id)?.name ?? id;
const sportOf = (id: string) => leagueInfo(id)?.sport ?? "soccer";
/** gewaehlte Wettbewerbe in der Reihenfolge der Einstellungen, nach Sportart sortiert */
const chosen = () => [...snap.sport.leagues].sort((a, b) => SPORT_ORDER.indexOf(sportOf(a)) - SPORT_ORDER.indexOf(sportOf(b)));

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

/** „vor 5 Min“, „vor 3 Std“, „vor 2 Tagen“ */
function ago(t: number) {
  const min = Math.max(1, Math.round((Date.now() - t) / 60_000));
  if (min < 60) return `vor ${min} Min`;
  const h = Math.round(min / 60);
  if (h < 24) return `vor ${h} Std`;
  const d = Math.round(h / 24);
  return d === 1 ? "gestern" : `vor ${d} Tagen`;
}

function dayLabel(t: number) {
  const now = Date.now();
  const date = new Date(t).toLocaleDateString("de-DE", { weekday: "short", day: "numeric", month: "short" }).replace(/\.,/, ",");
  if (sameDay(t, now)) return `Heute · ${date}`;
  if (sameDay(t, now + DAY)) return `Morgen · ${date}`;
  if (sameDay(t, now - DAY)) return `Gestern · ${date}`;
  return date;
}
const shortDay = (t: number) => dayLabel(t).replace(/^(Heute|Morgen|Gestern) · .*/, "$1");

/** Chips: Ein-/Ausschalter (aria-pressed) */
function chip(text: string, on: boolean, click: () => void, title = "") {
  const b = el("button", "", text);
  b.setAttribute("aria-pressed", String(on));
  if (title) b.title = title;
  b.addEventListener("click", click);
  return b;
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
  if (v === "live") { focusSig = ""; renderLive(); }
  if (v === "plan") void loadPlan();
  if (v === "leagues") renderLeagues();
  if (v === "teams") void renderTeams();
}

// ---------- Live ----------

let focusSig = "";
let detailSig = "";

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

/** Spiele von heute, nach Wettbewerb gruppiert (die Wettbewerbsnamen zeigt nur die breite Spalte) */
function renderStrip(f: SportMatch | undefined) {
  const strip = q(".strip");
  const ms = live.matches;
  const groups = new Map<string, SportMatch[]>();
  for (const m of ms) groups.set(m.league_name, [...(groups.get(m.league_name) ?? []), m]);
  const out: HTMLElement[] = [];
  for (const [name, list] of groups) {
    out.push(el("div", "strip-league n-eyebrow", name));
    out.push(...list.map((m) => tile(m, m.key === f?.key)));
  }
  strip.replaceChildren(...out);
  const solo = ms.length < 2;
  strip.hidden = solo;
  q(".view[data-view=live]").classList.toggle("solo", solo);
}

function renderLive() {
  if (view !== "live") return;
  const f = focusMatch();
  renderStrip(f);
  const box = q(".focus");
  if (!f) {
    focusSig = "";
    renderEmpty(box);
    return;
  }
  const sig = JSON.stringify([f.key, f.home.score, f.away.score, f.clock, f.state, f.events.map((e) => e.id)]);
  if (sig !== focusSig) {
    focusSig = sig;
    detailSig = "";
    box.replaceChildren(focusEl(f));
  }
  renderDetail(f);
}

const openIcon = svgIcon('<path d="M9 6h9v9"/><path d="M18 6 6 18"/>');

function focusEl(f: SportMatch) {
  const wrap = el("article", `big ${f.state}`);
  wrap.style.setProperty("--hc", f.home.color);
  wrap.style.setProperty("--ac", f.away.color);
  const head = el("div", "big-head");
  head.append(el("span", "n-eyebrow", f.league_name), el("span", `big-clock ${f.state}`, f.state === "pre" ? `${kickoff(f)} · ${countdown(f.start)}` : clockOf(f)));
  if (f.link) {
    const open = el("button", "n-ico sm n-glass n-liquid");
    open.innerHTML = openIcon;
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
  const name = (t: SportTeam) => el("span", "big-name", t.short || t.name);
  const side = (t: SportTeam) => { const s = el("div", "big-side"); s.append(crestEl(t, "crest big-crest"), name(t)); return s; };
  score.append(side(f.home), num, side(f.away));

  // zwei Spalten: links Spielfeld und Analyse, rechts Ticker, Aufstellung, Spielort
  const body = el("div", "big-body");
  const main = el("div", "col col-main");
  const aside = el("div", "col col-side");
  if (f.pitch && f.source === "espn" && f.state !== "pre") {
    pitch.setMatch(f);
    const pw = card("Ballverlauf", "", "pitch-card");
    pw.append(pitch.el);
    main.append(pw);
  }
  main.append(el("div", "slot slot-main"));
  if (f.state !== "pre") {
    const tk = card("Ticker", f.events.length ? `${f.events.length} Meldungen` : "", "ticker-card");
    tk.append(tickerEl(f, 24));
    aside.append(tk);
  }
  aside.append(el("div", "slot slot-side"));
  body.append(main, aside);
  wrap.append(head, score, body);
  return wrap;
}

// Analyse zum gewaehlten Spiel (info.rs); laufend alle 30 s, sonst selten
const details = new Map<string, { at: number; d?: MatchDetail; err?: string; loading?: boolean }>();

function renderDetail(f: SportMatch) {
  const main = q(".slot-main"), side = q(".slot-side");
  if (!main || !side) return;
  if (f.key.startsWith("oldb/")) {
    if (detailSig !== "oldb") { detailSig = "oldb"; main.replaceChildren(); side.replaceChildren(); }
    return;
  }
  const c = details.get(f.key);
  const maxAge = f.state === "in" ? 30_000 : f.state === "pre" ? 600_000 : 3_600_000;
  if ((!c || Date.now() - c.at > maxAge) && !c?.loading) {
    details.set(f.key, { ...(c ?? { at: 0 }), loading: true });
    const key = f.key;
    invoke<MatchDetail>("match_detail", { key, state: f.state })
      .then((d) => details.set(key, { at: Date.now(), d }))
      .catch((e) => details.set(key, { at: Date.now(), err: String(e), d: c?.d }))
      .finally(() => { const now = focusMatch(); if (view === "live" && now?.key === key) renderDetail(now); });
  }
  const cur = details.get(f.key);
  const sig = JSON.stringify([f.key, cur?.at, !!cur?.d, f.state, f.state === "in" ? f.clock : ""]);
  if (sig === detailSig) return;
  detailSig = sig;
  if (!cur?.d) {
    main.replaceChildren(...(cur?.err ? [] : [faint("Analyse wird geladen …", "faint slot-wait")]));
    side.replaceChildren();
    return;
  }
  const { main: a, side: b } = detailCards(f, cur.d);
  main.replaceChildren(...a);
  side.replaceChildren(...b);
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
      el("span", "next-when", `${shortDay(next.start)} · ${timeOf(next.start)} · ${countdown(next.start)}`));
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
const sportOff = new Set<string>();
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
  if (view === "leagues") renderLeaguePlan();
  if (view === "live" && !live.matches.length) renderLive();
}

/** Zeile im Spielplan: Zeit · Wappen Stand Wappen (· Wettbewerb) */
function prow(m: SportMatch, opts: { league?: boolean; when?: string } = {}) {
  const lv = live.matches.find((x) => x.key === m.key) ?? m;
  const r = el("button", `prow ${lv.state}` + (lv.fav ? " fav" : "") + (opts.league ? " with-league" : ""));
  r.title = `${lv.home.name} – ${lv.away.name} · ${lv.league_name}`;
  const when = el("span", "p-when");
  if (opts.when) when.textContent = opts.when;
  else if (lv.state === "pre") when.textContent = timeOf(lv.start);
  else if (lv.state === "in") when.append(el("i", "live-dot"), clockOf(lv));
  else when.textContent = clockOf(lv) === "Ende" ? timeOf(lv.start) : clockOf(lv);
  const mid = el("span", "p-match");
  mid.append(crestEl(lv.home), el("b", "", lv.state === "pre" ? "–" : scoreOf(lv)), crestEl(lv.away));
  r.append(when, mid);
  if (opts.league) r.append(el("span", "p-league", lv.league_name));
  r.addEventListener("click", () => {
    if (live.matches.some((x) => x.key === lv.key)) { focusKey = lv.key; setView("live"); }
    else if (lv.link) void invoke("open_link", { url: lv.link }).catch(() => {});
  });
  return r;
}

function renderPlan() {
  const ids = chosen();
  const sports = [...new Set(ids.map(sportOf))];
  const sportChips = q(".plan-sports");
  sportChips.hidden = sports.length < 2;
  sportChips.replaceChildren(...sports.map((s) => chip(SPORT_NAME[s] ?? s, !sportOff.has(s), () => {
    if (sportOff.has(s)) sportOff.delete(s); else sportOff.add(s);
    renderPlan();
  })));
  q(".plan-leagues").replaceChildren(...ids.filter((id) => !sportOff.has(sportOf(id))).map((id) => chip(leagueName(id), !planOff.has(id), () => {
    if (planOff.has(id)) planOff.delete(id); else planOff.add(id);
    renderPlan();
  })));
  document.querySelectorAll<HTMLButtonElement>(".plan-scope button").forEach((b) => b.classList.toggle("active", b.dataset.scope === planScope));
  const box = q(".plan");
  if (!plan) {
    box.replaceChildren(faint(planLoading ? "Spielplan wird geladen …" : planErr || "Noch nichts geladen"));
    return;
  }
  const list = plan.filter((m) => !planOff.has(m.league) && !sportOff.has(m.sport) && (planScope === "all" || m.fav));
  if (!list.length) {
    box.replaceChildren(faint(planScope === "fav" ? "Keine Spiele deiner Teams in diesen drei Wochen." : "Keine Spiele in diesem Zeitraum."));
    return;
  }
  // Tag -> Wettbewerb -> Spiele; die Wettbewerbe eines Tages stehen nebeneinander
  const days = new Map<string, Map<string, SportMatch[]>>();
  for (const m of list) {
    const d = new Date(m.start).toDateString();
    const day = days.get(d) ?? new Map<string, SportMatch[]>();
    day.set(m.league, [...(day.get(m.league) ?? []), m]);
    days.set(d, day);
  }
  const order = (id: string) => { const i = ids.indexOf(id); return i < 0 ? 99 : i; };
  const out: HTMLElement[] = [];
  let today: HTMLElement | null = null;
  const start = new Date().setHours(0, 0, 0, 0);
  for (const day of days.values()) {
    const first = [...day.values()][0][0];
    const sec = el("section", "day");
    sec.append(el("h3", "day-head n-liquid", dayLabel(first.start)));
    const grid = el("div", "day-grid");
    for (const [id, ms] of [...day.entries()].sort((a, b) => order(a[0]) - order(b[0]))) {
      const c = card(leagueName(id), `${SPORT_NAME[ms[0].sport] ?? ""} · ${ms.length} ${ms.length === 1 ? "Spiel" : "Spiele"}`, "plan-card");
      c.append(...ms.map((m) => prow(m)));
      grid.append(c);
    }
    sec.append(grid);
    out.push(sec);
    if (!today && first.start >= start) today = sec;
  }
  box.replaceChildren(...out);
  if (!planScrolled && today) {
    planScrolled = true;
    requestAnimationFrame(() => { q("main").scrollTop = Math.max(0, today!.offsetTop - 120); });
  }
}

// ---------- Ligen: Tabelle | Spielplan | Schlagzeilen ----------

type Row = { rank: number; team: SportTeam; played: string; won: string; draw: string; lost: string; goals: string; diff: string; points: string; pct: string; behind: string; note: string; color: string; fav: boolean };
type Group = { name: string; rows: Row[] };
const NO_TABLE = new Set(["dfb", "dfbteam", "turnier"]);
let leagueSport = "";
let leagueId = "";
const tables = new Map<string, { at: number; groups?: Group[]; err?: string }>();
type Article = { headline: string; text: string; at: number; link: string; image: string; transfer: boolean };
type Move = { at: number; text: string; team: SportTeam };
const news = new Map<string, { at: number; v?: { news: Article[]; moves: Move[] }; err?: string }>();
let newsFilter: "all" | "transfer" | "injury" = "all";

/** Einordnung einer Schlagzeile: mit Laya dessen Etikett (ab MIN_P), sonst die Stichwortsuche aus info.rs */
function newsKind(a: Article): { kind: Kind | ""; p: number; ai: boolean; pending: boolean } {
  if (layaStatus().state === "ready") {
    const l = labelOf(a.headline);
    if (l) return { kind: l.p >= MIN_P ? l.kind : "", p: l.p, ai: true, pending: false };
    if (layaWork().busy) return { kind: "", p: 0, ai: true, pending: true };
  }
  return { kind: a.transfer ? "signed" : "", p: 0, ai: false, pending: false };
}
const isTransferKind = (k: Kind | "") => !!k && TRANSFER_KINDS.includes(k);

function renderLeagues() {
  const ids = chosen();
  const sports = [...new Set(ids.map(sportOf))];
  if (!sports.includes(leagueSport)) leagueSport = sports[0] ?? "";
  const seg = q(".league-sports");
  seg.hidden = sports.length < 2;
  seg.replaceChildren(...sports.map((s) => {
    const b = el("button", s === leagueSport ? "active" : "", SPORT_NAME[s] ?? s);
    b.addEventListener("click", () => { leagueSport = s; leagueId = ""; renderLeagues(); });
    return b;
  }));
  const mine = ids.filter((id) => sportOf(id) === leagueSport);
  if (!mine.includes(leagueId)) leagueId = mine.find((id) => !NO_TABLE.has(id)) ?? mine[0] ?? "";
  q(".league-chips").replaceChildren(...mine.map((id) => chip(leagueName(id), id === leagueId, () => { leagueId = id; renderLeagues(); })));
  const grid = q(".league-grid");
  if (!leagueId) {
    grid.hidden = true;
    q(".league-chips").replaceChildren(faint("Wähle Wettbewerbe in den Einstellungen.", "faint"));
    return;
  }
  grid.hidden = false;
  renderTable();
  renderLeaguePlan();
  renderNews();
}

function renderTable() {
  const box = q(".lg-table");
  const id = leagueId;
  if (NO_TABLE.has(id)) {
    const c = card("Tabelle");
    c.append(faint("K.-o.-Wettbewerb – hier gibt es keine Tabelle.", "faint c-empty"));
    box.replaceChildren(c);
    return;
  }
  const c = tables.get(id);
  if (!c || Date.now() - c.at > 10 * 60_000) {
    if (!c) { const w = card("Tabelle"); w.append(faint("Tabelle wird geladen …", "faint c-empty")); box.replaceChildren(w); }
    tables.set(id, { ...(c ?? {}), at: Date.now() });
    invoke<Group[]>("standings", { league: id })
      .then((g) => tables.set(id, { at: Date.now(), groups: g }))
      .catch((e) => tables.set(id, { at: Date.now(), err: String(e) }))
      .finally(() => { if (view === "leagues" && leagueId === id) renderTable(); });
    if (!c) return;
  }
  if (c?.err) { const w = card("Tabelle"); w.append(faint(c.err, "faint c-empty")); box.replaceChildren(w); return; }
  if (!c?.groups) return;
  const sport = sportOf(id);
  const us = sport !== "soccer";
  const out: HTMLElement[] = [];
  const notes = new Map<string, string>();
  for (const g of c.groups) {
    const t = card(c.groups.length > 1 ? g.name || "Tabelle" : "Tabelle", c.groups.length > 1 ? "" : `${g.rows.length} Teams`, "table");
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

/** Spielplan des gewaehlten Wettbewerbs, eigene Bildlaufflaeche, „Heute“ steht oben */
function renderLeaguePlan() {
  if (view !== "leagues") return;
  const box = q(".lg-plan");
  const c = card("Spielplan", "", "lg-plan-card");
  const list = el("div", "lg-scroll");
  if (!plan) {
    list.append(faint(planLoading ? "Spielplan wird geladen …" : planErr || "Noch nichts geladen", "faint c-empty"));
    if (!planLoading) void loadPlan(false, true);
  } else {
    const ms = plan.filter((m) => m.league === leagueId);
    c.querySelector(".c-head")!.append(el("span", "c-meta", `${ms.length} Spiele · 4 Wochen`));
    if (!ms.length) list.append(faint("Keine Spiele in diesem Zeitraum.", "faint c-empty"));
    let day = "";
    let today: HTMLElement | null = null;
    const start = new Date().setHours(0, 0, 0, 0);
    for (const m of ms) {
      const d = new Date(m.start).toDateString();
      if (d !== day) {
        day = d;
        const h = el("div", "lg-day", dayLabel(m.start));
        list.append(h);
        if (!today && m.start >= start) today = h;
      }
      list.append(prow(m));
    }
    // gleicher Wettbewerb: Position behalten (Live-Updates zeichnen neu), neuer: zu „Heute“ springen
    const prev = box.querySelector<HTMLElement>(".lg-scroll");
    const keep = lgPlanFor === leagueId && prev ? prev.scrollTop : -1;
    lgPlanFor = leagueId;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (keep >= 0) list.scrollTop = keep;
      else if (today) list.scrollTop = Math.max(0, today.getBoundingClientRect().top - list.getBoundingClientRect().top - 4);
    }));
  }
  c.append(list);
  box.replaceChildren(c);
}
let lgPlanFor = "";

function renderNews() {
  const box = q(".lg-news");
  const id = leagueId;
  if (leagueInfo(id)?.source === "OpenLigaDB") {
    const c = card("Schlagzeilen");
    c.append(faint("Für diesen Wettbewerb gibt es keine Schlagzeilen (OpenLigaDB).", "faint c-empty"));
    box.replaceChildren(c);
    return;
  }
  const n = news.get(id);
  if (!n || Date.now() - n.at > 15 * 60_000) {
    news.set(id, { ...(n ?? {}), at: Date.now() });
    invoke<{ news: Article[]; moves: Move[] }>("league_news", { league: id })
      .then((v) => news.set(id, { at: Date.now(), v }))
      .catch((e) => news.set(id, { at: Date.now(), err: String(e) }))
      .finally(() => { if (view === "leagues" && leagueId === id) renderNews(); });
  }
  const parts: HTMLElement[] = [];
  const cur = news.get(id);
  const ls = layaStatus();
  if (cur?.v && ls.state === "ready") classify(cur.v.news.map((a) => a.headline));
  const work = layaWork();
  const meta = ls.state === "ready"
    ? work.busy && work.total ? `Laya ordnet ein … ${work.done}/${work.total}` : work.error ? "ESPN · Laya: Fehler" : "ESPN · eingeordnet von Laya"
    : "ESPN · englisch";
  const c = card("Schlagzeilen", meta, "news-card");
  if (!cur?.v) c.append(faint(cur?.err ?? "Wird geladen …", "faint c-empty"));
  else {
    const kinds = cur.v.news.map((a) => newsKind(a));
    const transfers = kinds.filter((k) => isTransferKind(k.kind)).length;
    const injuries = kinds.filter((k) => k.kind === "injury").length;
    const filters: [typeof newsFilter, string][] = [["all", "Alle"]];
    if (transfers) filters.push(["transfer", `Transfers · ${transfers}`]);
    if (injuries && kinds.some((k) => k.ai)) filters.push(["injury", `Verletzungen · ${injuries}`]);
    if (!filters.some(([k]) => k === newsFilter)) newsFilter = "all";
    if (filters.length > 1) {
      const seg = el("div", "n-seg news-seg");
      for (const [k, label] of filters) {
        const b = el("button", k === newsFilter ? "active" : "", label);
        b.addEventListener("click", () => { newsFilter = k; renderNews(); });
        seg.append(b);
      }
      c.append(seg);
    }
    const list = cur.v.news.map((a, i) => ({ a, k: kinds[i] }))
      .filter(({ k }) => newsFilter === "all" || (newsFilter === "transfer" ? isTransferKind(k.kind) : k.kind === "injury"));
    if (!list.length) c.append(faint("Gerade keine Meldungen.", "faint c-empty"));
    for (const { a, k } of list.slice(0, 18)) {
      const r = el("button", "article" + (isTransferKind(k.kind) ? " transfer" : "") + (k.kind ? ` k-${k.kind}` : ""));
      r.title = a.text || a.headline;
      if (a.image) {
        const img = new Image();
        img.alt = "";
        img.loading = "lazy";
        img.src = a.image;
        img.onerror = () => img.remove();
        r.append(img);
      }
      const t = el("span", "a-text");
      const sub = el("small", "");
      const label = k.kind ? KIND_DE[k.kind] : "";
      if (label) {
        const tag = el("span", "a-tag", label);
        if (k.ai) tag.title = `Laya: ${Math.round(k.p * 100)} % sicher`;
        sub.append(tag);
      } else if (k.pending) sub.append(el("span", "a-tag wait", "…"));
      if (a.at) sub.append(el("span", "", ago(a.at)));
      t.append(el("b", "", a.headline), sub);
      r.append(t);
      if (a.link) r.addEventListener("click", () => void invoke("open_link", { url: a.link }).catch(() => {}));
      c.append(r);
    }
  }
  parts.push(c);
  if (cur?.v?.moves.length) {
    const m = card("Kaderbewegungen", `${cur.v.moves.length} zuletzt`, "moves-card");
    for (const x of cur.v.moves.slice(0, 20)) {
      const r = el("div", "move");
      r.append(crestEl(x.team), el("span", "mv-text", x.text), el("small", "mv-at", new Date(x.at).toLocaleDateString("de-DE", { day: "numeric", month: "short" })));
      m.append(r);
    }
    parts.push(m);
  }
  box.replaceChildren(...parts);
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
    el("span", "t-when", lv.state === "in" ? `live · ${scoreOf(lv)} · ${clockOf(lv)}` : `${shortDay(lv.start).replace(/ · .*$/, "")} ${timeOf(lv.start)}`));
  n.title = `${lv.home.name} – ${lv.away.name} · ${lv.league_name} · ${countdown(lv.start)}`;
  return n;
}

async function renderTeams() {
  const grid = q(".team-grid");
  const teams = snap.sport.teams;
  const cards: HTMLElement[] = teams.map((t) => {
    const c = el("article", "team n-card");
    const head = el("div", "team-head");
    head.append(crestOf(t, "crest team-crest"), el("h3", "", t.name));
    c.append(head);
    const v = teamViews.get(t.key);
    if (v?.v) {
      c.append(el("span", "n-eyebrow", "Als Nächstes"), nextEl(t, v.v.next[0]), el("span", "n-eyebrow", "Form"), formEl(t, v.v.last));
    } else c.append(el("p", "faint", v?.err ?? "Wird geladen …"));
    c.addEventListener("click", () => openTeam(t));
    return c;
  });
  const add = el("button", "team add");
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
let sheetTab: "games" | "squad" = "games";

function openSheet(kind: "settings" | "team", title: string | HTMLElement) {
  sheetKind = kind;
  q(".sheet-title").replaceChildren(title);
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
  q(".sheet-body").append(layaCard(), appCard());
}

// ---------- Laya (laya.rs, src/laya) ----------

const mb = (b: number) => `${Math.round(b / 1_000_000)} MB`;

function layaCard() {
  const s = layaStatus();
  const w = layaWork();
  const c = el("section", "s-card n-card laya-card");
  const h = el("div", "s-head");
  const badge = { off: "aus", missing: "nicht geladen", downloading: "wird geladen", ready: "installiert", error: "Fehler" }[s.state];
  h.append(el("span", "n-eyebrow", "KI-Einordnung · Laya"), el("span", "faint", badge));
  c.append(h, el("p", "s-hint", "Ordnet Schlagzeilen ein: Transfer fix, Gerücht, Verlängerung, Verletzung. Läuft lokal auf diesem Rechner, ohne Konto; nur das Modell wird einmal geladen."));
  if (s.state === "downloading" || (s.state === "missing" && s.want)) {
    const bar = el("div", "dl-bar");
    const fill = el("i", "");
    fill.style.width = `${s.total ? (s.done / s.total) * 100 : 0}%`;
    bar.append(fill);
    c.append(bar, el("p", "faint dl-text", s.done ? `${mb(s.done)} von ${mb(s.total)}` : "Startet gleich …"));
  }
  if (s.state === "error") c.append(el("p", "faint err", s.message || "Laden fehlgeschlagen."));
  if (s.state === "ready" && w.error) c.append(el("p", "faint err", `Einordnung fehlgeschlagen: ${w.error}`));
  const row = el("div", "app-row");
  row.append(el("span", "faint", s.state === "ready" ? `${mb(s.total)} auf diesem Rechner` : `Download ca. ${mb(s.total || 307_000_000)}`));
  const btns = el("div", "btn-row");
  const btn = (text: string, primary: boolean, fn: () => void) => {
    const b = el("button", "n-btn" + (primary ? " primary" : ""), text);
    b.addEventListener("click", fn);
    btns.append(b);
  };
  if (s.state === "off") btn("Installieren", true, () => void installLaya());
  if (s.state === "error") btn("Erneut versuchen", true, () => void installLaya());
  if (s.state === "ready" && w.error) btn("Erneut versuchen", false, () => { retryLaya(); if (view === "leagues") renderNews(); });
  if (s.state === "downloading" || s.state === "missing") btn("Abbrechen", false, () => void uninstallLaya());
  if (s.state === "ready" || s.state === "error") btn("Deinstallieren", false, () => { void uninstallLaya(); announce("Laya wird entfernt"); });
  row.append(btns);
  c.append(row);
  return c;
}

function renderLaya() {
  const box = q(".laya-card");
  if (box) box.replaceWith(layaCard());
  if (view === "leagues") renderNews();
}

async function openTeam(t: FavTeam) {
  sheetTeam = t;
  sheetTab = "games";
  const title = el("span", "sheet-team");
  title.append(crestOf(t, "crest"), t.name);
  openSheet("team", title);
  renderSheetTeam();
  await loadTeam(t.key);
  if (sheetTeam?.key === t.key) renderSheetTeam();
}

type RosterPlayer = { jersey: string; name: string; pos: string; pos_name: string; age: number; nation: string; flag: string; injury: string };
const rosters = new Map<string, { v?: RosterPlayer[]; err?: string; loading?: boolean }>();
const POS_DE: Record<string, string> = { G: "Tor", D: "Abwehr", M: "Mittelfeld", F: "Sturm" };

function squadEl(t: FavTeam): HTMLElement[] {
  const c = rosters.get(t.key);
  if (!c) {
    rosters.set(t.key, { loading: true });
    invoke<RosterPlayer[]>("team_roster", { key: t.key })
      .then((v) => rosters.set(t.key, { v }))
      .catch((e) => rosters.set(t.key, { err: String(e) }))
      .finally(() => { if (sheetTeam?.key === t.key && sheetTab === "squad") renderSheetTeam(); });
    return [faint("Kader wird geladen …", "faint")];
  }
  if (!c.v) return [faint(c.err ?? "Kader wird geladen …", "faint")];
  const groups = new Map<string, RosterPlayer[]>();
  const soccer = c.v.every((p) => !p.pos || p.pos in POS_DE);
  for (const p of c.v) {
    const g = soccer ? POS_DE[p.pos] ?? "Weitere" : p.pos_name || p.pos || "Weitere";
    groups.set(g, [...(groups.get(g) ?? []), p]);
  }
  const order = ["Tor", "Abwehr", "Mittelfeld", "Sturm"];
  const out: HTMLElement[] = [];
  for (const [g, ps] of [...groups.entries()].sort((a, b) => (order.indexOf(a[0]) + 1 || 9) - (order.indexOf(b[0]) + 1 || 9))) {
    out.push(el("div", "n-eyebrow", `${g} · ${ps.length}`));
    for (const p of ps.sort((a, b) => (Number(a.jersey) || 99) - (Number(b.jersey) || 99))) {
      const r = el("div", "player" + (p.injury ? " hurt" : ""));
      r.append(el("span", "pl-no", p.jersey || "–"), el("span", "pl-name", p.name));
      const meta = el("span", "pl-meta");
      if (p.flag) {
        const f = new Image();
        f.alt = p.nation;
        f.title = p.nation;
        f.src = p.flag;
        f.onerror = () => f.remove();
        meta.append(f);
      }
      if (p.age) meta.append(el("span", "", `${p.age}`));
      r.append(meta);
      if (p.injury) { const i = el("span", "pl-hurt", "verletzt"); i.title = p.injury; r.append(i); }
      out.push(r);
    }
  }
  out.push(faint("Kader: ESPN. Marktwerte und Transferhistorie gibt es nicht frei abrufbar.", "faint fine"));
  return out;
}

function renderSheetTeam() {
  const t = sheetTeam;
  if (sheetKind !== "team" || !t) return;
  const body = q(".sheet-body");
  const mine = snap.sport.teams.some((x) => x.key === t.key);
  const bar = el("div", "sheet-bar");
  const fav = el("button", "n-btn" + (mine ? "" : " primary"), mine ? "Aus meinen Teams" : "Zu meinen Teams");
  fav.addEventListener("click", () => {
    const teams = mine ? snap.sport.teams.filter((x) => x.key !== t.key) : [...snap.sport.teams, { key: t.key, name: t.name, ...(t.logo ? { logo: t.logo } : {}) }];
    const sport = { ...snap.sport, teams };
    snap = { ...snap, sport };
    invoke<Snapshot>("settings_set", { sport }).then((s) => { snap = s; onSettings(false); }).catch(() => {});
    announce(mine ? `${t.name} entfernt` : `${t.name} hinzugefügt`);
    renderSheetTeam();
    onSettings(false);
  });
  const parts: HTMLElement[] = [bar];
  bar.append(fav);
  // Kader nur fuer ESPN-Teams
  if (!t.key.startsWith("oldb:")) {
    const seg = el("div", "n-seg sheet-tabs");
    for (const [k, label] of [["games", "Spiele"], ["squad", "Kader"]] as const) {
      const b = el("button", k === sheetTab ? "active" : "", label);
      b.addEventListener("click", () => { sheetTab = k; renderSheetTeam(); });
      seg.append(b);
    }
    bar.append(seg);
  } else sheetTab = "games";
  if (sheetTab === "squad") {
    parts.push(...squadEl(t));
    body.replaceChildren(...parts);
    return;
  }
  const v = teamViews.get(t.key);
  if (!v?.v) parts.push(faint(v?.err ?? "Wird geladen …", "faint"));
  else {
    parts.push(el("div", "n-eyebrow", "Nächste Spiele"));
    if (!v.v.next.length) parts.push(faint("Kein Spiel angesetzt", "faint"));
    v.v.next.forEach((m) => parts.push(prow(m, { when: `${shortDay(m.start)} ${timeOf(m.start)}` })));
    parts.push(el("div", "n-eyebrow", "Letzte Ergebnisse"));
    if (!v.v.last.length) parts.push(faint("Noch keine", "faint"));
    v.v.last.forEach((m) => {
      const r = prow(m, { when: new Date(m.start).toLocaleDateString("de-DE", { day: "numeric", month: "short" }) });
      r.classList.add(`res-${result(m, t).r}`);
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
    if (view === "plan" || view === "leagues") void loadPlan(true);
  }
  if (view === "live") { focusSig = ""; renderLive(); }
  if (view === "plan") renderPlan();
  if (view === "leagues") renderLeagues();
  if (view === "teams") void renderTeams();
  if (rerenderSheet && sheetKind === "settings" && !document.activeElement?.closest(".sheet-body input")) renderSheetSettings();
  if (sheetKind === "team") renderSheetTeam();
}
let lastLeagues = "";

// ---------- Fenster: Vollbild und maximiert ----------

/** Fenster erst beim Start holen (vorher gibt es die Tauri-Bruecke evtl. noch nicht) */
let win: ReturnType<typeof getCurrentWindow>;
const FULL_ON = svgIcon('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>');
const FULL_OFF = svgIcon('<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>');
let isFull = false;

async function syncWindow() {
  const [full, max] = await Promise.all([win.isFullscreen().catch(() => false), win.isMaximized().catch(() => false)]);
  isFull = !!full;
  document.body.classList.toggle("full", isFull);
  document.body.classList.toggle("max", !!max);
  const b = q(".full-btn");
  b.innerHTML = isFull ? FULL_OFF : FULL_ON;
  b.title = isFull ? "Vollbild verlassen (F11)" : "Vollbild (F11)";
  b.setAttribute("aria-label", b.title);
}

async function setFull(on: boolean) {
  await win.setFullscreen(on).catch(() => {});
  await syncWindow();
}

// ---------- Start ----------

async function main() {
  win = getCurrentWindow();
  windowControls({
    minimize: () => void win.minimize().catch(() => {}),
    toggleMaximize: () => void (isFull ? setFull(false) : win.toggleMaximize().catch(() => {})),
    close: () => void win.close().catch(() => {}),
  });
  q(".gear").innerHTML = ICONS.settings;
  q(".sheet-x").innerHTML = ICONS.close;
  glassLight();
  liquid();
  segments(document, ".n-seg");
  lightScroller(q("main"), { insetTop: 74 });
  void syncWindow();
  void win.onResized(() => void syncWindow()).catch(() => {});

  document.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view as View)));
  document.querySelectorAll<HTMLButtonElement>(".plan-scope button").forEach((b) =>
    b.addEventListener("click", () => { planScope = b.dataset.scope === "fav" ? "fav" : "all"; renderPlan(); }));
  q(".gear").addEventListener("click", openSettings);
  q(".full-btn").addEventListener("click", () => void setFull(!isFull));
  q(".sheet-x").addEventListener("click", closeSheet);
  q(".backdrop").addEventListener("mousedown", (e) => { if (e.target === e.currentTarget) closeSheet(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { if (sheetKind) closeSheet(); else if (isFull) void setFull(false); }
    if (e.key === "F11") { e.preventDefault(); void setFull(!isFull); }
    if (e.ctrlKey && /^[1-4]$/.test(e.key)) setView(VIEWS[Number(e.key) - 1]);
  });

  snap = (await invoke<Snapshot | null>("settings_get").catch(() => null)) ?? snap;
  lastLeagues = snap.sport.leagues.join(",");
  leagues = (await invoke<LeagueInfo[] | null>("sport_leagues").catch(() => null)) ?? [];
  await listen<Snapshot>("settings", (e) => { snap = e.payload; onSettings(); });
  await listen<Upd>("update", (e) => { upd = e.payload; renderUpd(); });
  onLaya(renderLaya);
  await initLaya();
  upd = (await invoke<Upd | null>("update_state").catch(() => null)) ?? upd;
  renderUpd();
  await listen<SportState>("sport", (e) => {
    live = e.payload;
    if (view === "live") renderLive();
    if (view === "plan" && plan) renderPlan();
    if (view === "leagues" && plan) renderLeaguePlan();
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
  let start = "live";
  try { start = localStorage.getItem("arena-view") || "live"; } catch { /* egal */ }
  if (start === "table") start = "leagues"; // frueher „Tabelle“
  setView(pending ? "live" : VIEWS.includes(start as View) ? (start as View) : "live");
  // Spielplan im Hintergrund vorbereiten (fuer „Als Nächstes“, Spielplan und Ligen)
  if (view !== "plan") void loadPlan(false, true);
  setInterval(tickWatch, 1000);
  setInterval(() => { if (view === "live") { focusSig = ""; renderLive(); } }, 30_000);
}

main();
