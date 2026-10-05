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
import { glassLight, icon, ICONS, lightScroller, liquid, segments, windowControls } from "./nojo/nojo-ui";
import { bugEl, clockOf, Court, crestEl, kickoff, Pitch, scoreOf, tickerEl, type SportMatch, type SportPlay, type SportState, type SportTeam } from "./sport-ui";
import { morph } from "./morph";
import { CrestDots } from "./halftone";
import { leagueColor, leagueIcon, loadLeagueMeta } from "./leagues";
import { Fog } from "./fog";
import { alignLive, refreshNotch } from "./notch-align";
import Sortable from "sortablejs";
import { arrange, CARD_NAME, move, PHASE_NAME, phaseOf, reset as resetLayout, save as saveLayout, type CardId, type Lanes } from "./layout";
import { RadarAnim, radarEl, scale } from "./radar";
import type { Venue } from "./stadium";
import { crestOf, DEFAULT_SPORT, renderSettings, type FavTeam, type LeagueInfo, type Snapshot } from "./settings-ui";
import { card, detailCards, hooks, type MatchDetail, type Player } from "./detail-ui";
import { FormationPitch } from "./formation";
import { LineupHistory, type LineupGame } from "./history";
import { MatchReplay } from "./replay";
import { classifyClips, clipForScorer, type Clip } from "./clips";
import { group, roleFor, roleName, similar, type Pool, type Similar } from "./similar";
import type { Role } from "./laya/questions";
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
/** Basketball: Wurfbild (Treffer und Fehlwuerfe) */
const court = new Court();

const DAY = 86_400_000;
const SPORT_ORDER = ["soccer", "football", "basketball", "hockey", "baseball"];
const SPORT_NAME: Record<string, string> = { soccer: "Fußball", football: "Football", basketball: "Basketball", hockey: "Eishockey", baseball: "Baseball" };
const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();
const timeOf = (t: number) => new Date(t).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
const norm = (n: string) => n.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\b(1|fc|sv|vfl|vfb|tsg|sc|fsv|spvgg|bsc)\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const isFavTeam = (t: SportTeam) => snap.sport.teams.some((f) => f.key === t.id || norm(f.name) === norm(t.name));
/** Teamfarben aus allen gesehenen Spielen (Tabellen liefern keine) — Lieblingsteams leuchten in Vereinsfarbe */
const teamColors = new Map<string, string>();
function rememberColors(ms: SportMatch[]) {
  for (const m of ms) for (const t of [m.home, m.away]) rememberColor(t.id, t.name, t.color);
}
/** Vereinsfarbe merken (Spiele, Teamlisten, Ligapool); die erste bekannte bleibt */
function rememberColor(id: string, name: string, color: string) {
  if (!color) return;
  if (!teamColors.has(id)) teamColors.set(id, color);
  if (!teamColors.has(norm(name))) teamColors.set(norm(name), color);
}
const colorOfTeam = (id: string, name: string) => teamColors.get(id) ?? teamColors.get(norm(name)) ?? "";
/** Farbe des Lieblingsteams in einem Spiel (leer, wenn keins mitspielt) */
const favColor = (m: SportMatch) => (isFavTeam(m.home) ? m.home.color : isFavTeam(m.away) ? m.away.color : "");
const leagueInfo = (id: string) => leagues.find((l) => l.id === id);
const leagueName = (id: string) => leagueInfo(id)?.name ?? id;
const sportOf = (id: string) => leagueInfo(id)?.sport ?? "soccer";
/** gewaehlte Wettbewerbe in der Reihenfolge der Einstellungen, nach Sportart sortiert */
const chosen = () => {
  // automatische Wettbewerbe (Testspiele) stehen da, sobald sie Spiele haben
  const auto = leagues.filter((l) => l.auto && !snap.sport.leagues.includes(l.id) && [...live.matches, ...(plan ?? [])].some((m) => m.league === l.id)).map((l) => l.id);
  return [...snap.sport.leagues, ...auto].sort((a, b) => SPORT_ORDER.indexOf(sportOf(a)) - SPORT_ORDER.indexOf(sportOf(b)));
};

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
/** Anstoss vorbei, ESPN meldet aber noch nichts (manche Testspiele ueberträgt ESPN gar nicht live) */
const noLive = (m: SportMatch) => m.state === "pre" && m.source === "espn" && Date.now() - m.start > 15 * 60_000;

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
function chip(text: string, on: boolean, click: () => void, title = "", lead?: HTMLElement) {
  const b = el("button", "", text);
  b.dataset.key = text;
  if (lead) b.prepend(lead);
  b.setAttribute("aria-pressed", String(on));
  if (title) b.title = title;
  b.onclick = click;
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
  q("main").classList.toggle("snap-days", v === "plan");
  q(".today-btn").hidden = !(v === "plan" || v === "leagues");
  if (v === "live") { focusSig = ""; renderLive(); }
  if (v === "plan") void loadPlan();
  if (v === "leagues") renderLeagues();
  if (v === "teams") void renderTeams();
}

// ---------- Live ----------

let focusSig = "";
let detailSig = "";

/** aus Spielplan oder Teams geoeffnet, aber (noch / nicht mehr) im Live-Fenster */
let opened: SportMatch | null = null;

function openMatch(m: SportMatch) {
  focusKey = m.key;
  opened = live.matches.some((x) => x.key === m.key) ? null : m;
  if (view === "live") renderLive(); else setView("live");
}

function focusMatch(): SportMatch | undefined {
  const ms = live.matches;
  return ms.find((m) => m.key === focusKey)
    ?? (opened?.key === focusKey ? opened : undefined)
    ?? ms.find((m) => m.state === "in" && m.fav)
    ?? ms.find((m) => m.state === "in")
    ?? ms.find((m) => m.fav)
    ?? ms[0];
}

function tile(m: SportMatch, on: boolean) {
  const b = el("button", `tile n-card ${m.state}` + (on ? " on" : "") + (m.fav ? " fav" : ""));
  b.dataset.key = m.key;
  b.title = `${m.home.name} – ${m.away.name} · ${m.league_name}`;
  b.style.setProperty("--hc", m.home.color);
  b.style.setProperty("--ac", m.away.color);
  if (m.fav) b.style.setProperty("--fav", favColor(m) || "var(--n-accent)");
  b.append(bugEl(m, scoreOf(m), "bug"), el("small", "t-clock", clockOf(m)));
  // Lichtstrich: so weit ist das Spiel (nur laufende)
  if (m.state === "in") {
    const p = el("i", "prog");
    p.style.setProperty("--p", String(progress(m)));
    b.append(p);
  }
  b.onclick = () => { focusKey = m.key; renderLive(); };
  return b;
}

/** Spiele von heute, nach Wettbewerb gruppiert (die Wettbewerbsnamen zeigt nur die breite Spalte) */
function renderStrip(f: SportMatch | undefined) {
  const strip = q(".strip");
  const extra = opened && !live.matches.some((m) => m.key === opened!.key) ? [opened] : [];
  const ms = [...extra, ...live.matches];
  const groups = new Map<string, SportMatch[]>();
  for (const m of ms) groups.set(m.league_name, [...(groups.get(m.league_name) ?? []), m]);
  const out: HTMLElement[] = [];
  for (const [name, list] of groups) {
    const lg = el("div", "strip-league n-eyebrow");
    lg.append(leagueIcon(list[0].league, name, "lg-ico sm"), name);
    lg.dataset.key = `lg:${name}`;
    out.push(lg);
    out.push(...list.map((m) => tile(m, m.key === f?.key)));
  }
  morph(strip, out);
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
  const sig = JSON.stringify([f.key, f.home.score, f.away.score, f.clock, f.state, noLive(f), f.events.map((e) => e.id)]);
  if (sig !== focusSig) {
    focusSig = sig;
    // anderes Spiel: frische Analyse-Plaetze; gleiches Spiel: nur Geaendertes (Stand, Minute, neue Tickerzeilen)
    if (box.querySelector<HTMLElement>(".big")?.dataset.key !== f.key) detailSig = "";
    morph(box, [focusEl(f)]);
  }
  renderDetail(f);
  alignLive();
}

/** Wappen beider Teams als Punkteraster im Hintergrund */
const crestDots = new CrestDots();

function focusEl(f: SportMatch) {
  const wrap = el("article", `big ${f.state}` + (arranging ? " arranging" : ""));
  wrap.dataset.key = f.key;
  wrap.style.setProperty("--hc", f.home.color);
  wrap.style.setProperty("--ac", f.away.color);
  const head = el("div", "big-head");
  const lg = el("span", "n-eyebrow big-league");
  lg.append(leagueIcon(f.league, f.league_name, "lg-ico"), f.league_name);
  head.append(lg, el("span", `big-clock ${f.state}`, f.state === "pre" ? `${kickoff(f)} · ${noLive(f) ? "keine Live-Daten" : countdown(f.start)}` : clockOf(f)));
  if (f.link) {
    const open = el("button", "n-ico sm n-glass n-liquid");
    open.innerHTML = icon("open");
    open.title = "Spielseite im Browser öffnen";
    open.setAttribute("aria-label", open.title);
    open.onclick = () => void invoke("open_link", { url: f.link }).catch(() => {});
    head.append(open);
  }
  const ar = el("button", "n-ico sm n-glass n-liquid arrange-btn" + (arranging ? " on" : ""));
  ar.dataset.key = "arrange";
  ar.innerHTML = icon(arranging ? "check" : "layout");
  ar.title = arranging ? "Anordnung fertig" : "Karten anordnen";
  ar.setAttribute("aria-label", ar.title);
  ar.setAttribute("aria-pressed", String(arranging));
  ar.onclick = () => setArranging(!arranging);
  head.append(ar);
  const score = el("div", "big-score");
  score.title = `${f.home.name} – ${f.away.name}`;
  const num = el("div", "big-num");
  if (f.state === "pre") num.append(el("span", "big-ko", timeOf(f.start)));
  else num.append(el("b", "", f.home.score || "0"), el("i", "", ":"), el("b", "", f.away.score || "0"));
  const name = (t: SportTeam) => el("span", "big-name", t.short || t.name);
  const side = (t: SportTeam) => { const s = el("div", "big-side"); s.append(crestEl(t, "crest big-crest"), name(t)); return s; };
  score.append(side(f.home), num, side(f.away));

  // zwei Spalten, jede stapelt ihre Karten ohne Luecken; was wohin kommt, entscheidet layout.ts (renderDetail)
  const body = el("div", "big-body");
  const lane = (cls: string) => { const e = el("div", `col lane ${cls}`); e.dataset.key = cls; e.dataset.keep = ""; return e; };
  const bar = el("div", "arrange-slot");
  bar.dataset.key = "arrange-slot";
  bar.dataset.keep = "";
  body.append(lane("lane-main"), lane("lane-side"));
  const hero = lane("lane-hero");
  crestDots.set(f.home, f.away);
  wrap.append(crestDots.el, head, score, bar, hero, body);
  return wrap;
}

// ---------- Karten: Spielfeld, Ticker, Analyse — angeordnet nach layout.ts, anpassbar ----------

let arranging = false;
let dragging = false;
let layoutRev = 0;
let lastLanes: Lanes | null = null;
const sortables = new WeakMap<HTMLElement, Sortable>();

function setArranging(on: boolean) {
  arranging = on;
  focusSig = "";
  detailSig = "";
  renderLive();
}

/** Aufstellung auf dem Spielfeld (vor dem Spiel, sobald ESPN sie kennt) */
const lineupPitch = new FormationPitch("fp-match");
lineupPitch.pick((p, t) => openPlayerSheet(p, t));

/** Spielverlauf zum Nachscrollen mit allen Abschluessen (more.rs match_plays) */
const replay = new MatchReplay();
const fieldMode = new Map<string, "live" | "replay">();
const playsAt = new Map<string, { at: number; loading?: boolean }>();

function loadPlays(f: SportMatch) {
  const c = playsAt.get(f.key);
  const ttl = f.state === "in" ? 30_000 : 6 * 3_600_000;
  if (c && (c.loading || Date.now() - c.at < ttl)) return;
  playsAt.set(f.key, { at: Date.now(), loading: true });
  invoke<SportPlay[]>("match_plays", { key: f.key, home: f.home.id, live: f.state === "in" })
    .then((v) => { if (replay.matchKey === f.key) replay.setPlays(v); })
    .catch(() => { if (replay.matchKey === f.key) replay.setPlays([]); })
    .finally(() => playsAt.set(f.key, { at: Date.now() }));
}

/** Spielfeld: Ballverlauf (Fussball) bzw. Wurfbild (Basketball); vor dem Spiel die Aufstellungen darauf */
function fieldCard(f: SportMatch, d: MatchDetail | null): HTMLElement | null {
  if (f.sport === "soccer" && f.state === "pre" && (d?.lineup_home?.players.length || d?.lineup_away?.players.length)) {
    lineupPitch.match(f.home, d.lineup_home, f.away, d.lineup_away);
    const c = card("Aufstellung", "voraussichtlich · Spieler antippen: Profil", "pitch-card lineup-pitch-card");
    c.append(lineupPitch.el);
    return c;
  }
  if (f.sport === "soccer") {
    // laeuft oder vorbei: Umschalten zwischen Live-Ballverlauf und dem ganzen Spiel (Leiste + Abschluesse)
    const canReplay = f.source === "espn" && f.state !== "pre" && !noLive(f);
    const mode = canReplay ? fieldMode.get(f.key) ?? (f.state === "post" ? "replay" : "live") : "live";
    const c = card(mode === "replay" ? "Spielverlauf" : "Ballverlauf", "", "pitch-card");
    if (canReplay) {
      const tg = el("div", "fm-toggle");
      tg.dataset.key = "fm";
      for (const [k, label] of [["live", f.state === "in" ? "Live" : "Letzte Szenen"], ["replay", "Ganzes Spiel · Abschlüsse"]] as const) {
        const b = el("button", k === mode ? "on" : "", label);
        b.setAttribute("aria-pressed", String(k === mode));
        b.onclick = () => { fieldMode.set(f.key, k); detailSig = ""; renderDetail(f); };
        tg.append(b);
      }
      c.querySelector(".c-head")!.append(tg);
    }
    if (mode === "replay") {
      replay.setMatch(f);
      loadPlays(f);
      c.append(replay.el);
      return c;
    }
    pitch.setMatch(f);
    if (f.source !== "espn") pitch.idle("Ballverlauf gibt es nur für ESPN-Wettbewerbe");
    else if (noLive(f)) pitch.idle("ESPN überträgt dieses Spiel nicht live");
    c.append(pitch.el);
    return c;
  }
  if (f.sport === "basketball") {
    court.setMatch(f);
    const c = card("Wurfbild", "Treffer ● · Fehlwürfe ×", "court-card");
    c.append(court.el);
    return c;
  }
  return null;
}

const lineupGames = new Map<string, Promise<LineupGame[]>>();
const history = new LineupHistory(
  (team) => {
    let p = lineupGames.get(team);
    if (!p) { p = invoke<LineupGame[]>("recent_lineups", { team }); lineupGames.set(team, p); p.catch(() => lineupGames.delete(team)); }
    return p;
  },
  (p, t) => openPlayerSheet(p, t),
);

function historyCard(f: SportMatch) {
  history.setMatch(f, !isFavTeam(f.home) && isFavTeam(f.away) ? "away" : "home");
  const c = card("Letzte Aufstellungen", "Startelf · ‹ › blättern", "history-card");
  c.append(history.el);
  return c;
}

function tickerCard(f: SportMatch, clips: Clip[]) {
  const c = card("Ticker", f.events.length ? `${f.events.length} Meldungen` : "", "ticker-card");
  const list = tickerEl(f, 24);
  // Tor mit Clip: Knopf an der Tickerzeile (Clip des Schuetzen)
  if (clips.length) {
    for (const e of f.events.filter((x) => x.kind === "goal")) {
      const clip = clipForScorer(clips, e.text);
      const li = list.querySelector<HTMLElement>(`li[data-key="${CSS.escape(e.id)}"]`);
      if (!clip || !li) continue;
      const b = el("button", "tk-clip");
      b.innerHTML = icon("play");
      b.title = `Clip: ${clip.headline}`;
      b.setAttribute("aria-label", b.title);
      b.onclick = () => void invoke("open_link", { url: clip.url }).catch(() => {});
      li.append(b);
    }
  }
  c.append(list);
  return c;
}

function applyLayout(f: SportMatch, l: Lanes) {
  saveLayout(f.sport, f.state, l);
  layoutRev++;
  detailSig = "";
  renderDetail(f);
}

/** Werkzeuge einer Karte beim Anordnen: Griff, hoch, runter, andere Spalte, ausblenden */
function cardTools(f: SportMatch, l: Lanes, id: CardId, lane: "hero" | "main" | "side") {
  const t = el("div", "c-tools");
  t.dataset.key = "tools";
  const grip = el("span", "c-grip");
  grip.innerHTML = icon("grip");
  grip.title = "Ziehen zum Verschieben";
  const b = (name: Parameters<typeof icon>[0], title: string, how: Parameters<typeof move>[2]) => {
    const x = el("button", "c-tool");
    x.dataset.key = how;
    x.innerHTML = icon(name);
    x.title = title;
    x.setAttribute("aria-label", `${CARD_NAME[id]}: ${title}`);
    x.onclick = (e) => { e.stopPropagation(); applyLayout(f, move(l, id, how)); };
    return x;
  };
  t.append(grip, b("up", "Nach oben", "up"), b("down", "Nach unten", "down"));
  if (lane !== "hero") t.append(b(lane === "main" ? "next" : "prev", lane === "main" ? "In die rechte Spalte" : "In die linke Spalte", "swap"));
  t.append(lane === "hero" ? b("fullscreen-exit", "Zurück in die Spalte", "wide") : b("fullscreen", "Volle Breite", "wide"), b("eye-off", "Ausblenden", "hide"));
  return t;
}

/** Leiste beim Anordnen: wofuer die Anordnung gilt, ausgeblendete Karten zurueckholen, Standard, Fertig */
function arrangeBar(f: SportMatch, l: Lanes & { custom: boolean }) {
  const bar = el("div", "arrange-bar n-glass n-liquid");
  bar.dataset.key = "arrange-bar";
  const t = el("div", "ab-text");
  t.append(el("b", "", `Anordnung · ${SPORT_NAME[f.sport] ?? f.sport} ${PHASE_NAME[phaseOf(f.state)]}`),
    el("span", "", "Karten am Griff ziehen oder mit den Pfeilen verschieben"));
  bar.append(t);
  if (l.hidden.length) {
    const chips = el("div", "chips ab-hidden");
    chips.append(el("span", "ab-label", "Ausgeblendet"));
    for (const id of l.hidden) {
      const lead = el("span", "ab-eye");
      lead.innerHTML = icon("eye");
      chips.append(chip(CARD_NAME[id], false, () => applyLayout(f, move(l, id, "show")), "Wieder anzeigen", lead));
    }
    bar.append(chips);
  }
  const acts = el("div", "ab-acts");
  const std = el("button", "n-btn ghost", "Standard");
  std.dataset.key = "std";
  std.disabled = !l.custom;
  std.title = "Standard-Anordnung für diese Sportart und Phase";
  std.onclick = () => { resetLayout(f.sport, f.state); layoutRev++; detailSig = ""; renderDetail(f); };
  const done = el("button", "n-btn", "Fertig");
  done.dataset.key = "done";
  done.onclick = () => setArranging(false);
  acts.append(std, done);
  bar.append(acts);
  return bar;
}

/** Ziehen zwischen den Spalten (SortableJS); nur beim Anordnen aktiv */
function sortableFor(lane: HTMLElement) {
  let s = sortables.get(lane);
  if (!s) {
    s = Sortable.create(lane, {
      group: "arena-cards",
      handle: ".c-grip",
      draggable: "[data-card]",
      animation: matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180,
      ghostClass: "drag-ghost",
      chosenClass: "drag-chosen",
      onStart: () => { dragging = true; },
      onEnd: () => {
        dragging = false;
        const f = focusMatch();
        if (!f) return;
        const ids = (sel: string) => Array.from(document.querySelectorAll<HTMLElement>(`${sel} > [data-card]`)).map((c) => c.dataset.card as CardId);
        applyLayout(f, { hero: ids(".lane-hero"), main: ids(".lane-main"), side: ids(".lane-side"), hidden: lastLanes?.hidden ?? [] });
      },
    });
    sortables.set(lane, s);
  }
  s.option("disabled", !arranging);
}

// Analyse zum gewaehlten Spiel (info.rs); laufend alle 30 s, sonst selten
const details = new Map<string, { at: number; d?: MatchDetail; err?: string; loading?: boolean }>();

// Stadion (more.rs: Wikidata + OpenStreetMap), je Name einmal
const venues = new Map<string, { v?: Venue; loading?: boolean }>();
function venueFor(d: MatchDetail | undefined): { v: Venue | null; loading: boolean } {
  if (!d?.venue) return { v: null, loading: !d };
  const k = `${d.venue}|${d.city}`;
  let c = venues.get(k);
  if (!c) {
    c = { loading: true };
    venues.set(k, c);
    invoke<Venue>("venue_info", { name: d.venue, city: d.city })
      .then((v) => venues.set(k, { v }))
      .catch(() => venues.set(k, {}))
      .finally(() => { const now = focusMatch(); if (view === "live" && now) { detailSig = ""; renderDetail(now); } });
  }
  return { v: c.v ?? null, loading: !!c.loading };
}

function renderDetail(f: SportMatch) {
  const lh = q(".lane-hero"), lm = q(".lane-main"), ls = q(".lane-side"), slot = q(".arrange-slot");
  if (!lh || !lm || !ls || !slot || dragging) return;
  // OpenLigaDB: keine Analyse — die Karten stehen trotzdem da, leer
  const espn = !f.key.startsWith("oldb/");
  if (espn) {
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
  }
  const cur = espn ? details.get(f.key) : undefined;
  const ven = espn ? venueFor(cur?.d) : { v: null, loading: false };
  const sig = JSON.stringify([f.key, cur?.at, !!cur?.d, f.state, f.clock, f.home.score, f.away.score, f.events.map((e) => e.id),
    ven.loading, !!ven.v, noLive(f), arranging, layoutRev]);
  if (sig === detailSig) return;
  detailSig = sig;
  const cards = detailCards(f, cur?.d ?? null, ven.v, ven.loading);
  const field = fieldCard(f, cur?.d ?? null);
  if (field) cards.set("field", field);
  if (f.sport === "soccer" && espn) cards.set("history", historyCard(f));
  // Basketball hat keinen Ticker (die Wuerfe stehen im Wurfbild)
  const clips = cur?.d?.clips ?? [];
  if (f.sport !== "basketball") cards.set("ticker", tickerCard(f, clips));
  // Laya ordnet neue Clips ein (Tor, Zusammenfassung, Stimmen), danach neu zeichnen
  classifyClips(clips, () => { detailSig = ""; const now = focusMatch(); if (view === "live" && now?.key === f.key) renderDetail(now); });
  const l = arrange(f.sport, f.state, [...cards.keys()]);
  lastLanes = l;
  const put = (ids: CardId[], lane: "hero" | "main" | "side") => ids.map((id) => {
    const c = cards.get(id)!;
    c.dataset.key = `c:${id}`;
    c.dataset.card = id;
    if (arranging) c.querySelector(".c-head")?.append(cardTools(f, l, id, lane));
    return c;
  });
  morph(lh, put(l.hero, "hero"));
  morph(lm, put(l.main, "main"));
  morph(ls, put(l.side, "side"));
  morph(slot, arranging ? [arrangeBar(f, l)] : []);
  sortableFor(lh);
  sortableFor(lm);
  sortableFor(ls);
  alignLive();
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
    c.onclick = () => setView("plan");
    e.append(c);
  } else if (!plan) void loadPlan(false, true);
  morph(box, [e]);
}

// Ballverlauf: nur holen, solange das Spielfeld zu sehen ist
let watching = "";
let watchAt = 0;
function tickWatch() {
  const f = focusMatch();
  const visible = view === "live" && !document.hidden && !!f && f.source === "espn" && f.state !== "pre" &&
    ((pitch.el.isConnected && f.pitch) || (court.el.isConnected && !!f.court));
  const key = visible ? f!.key : "";
  if (key !== watching || (key && Date.now() - watchAt > 8000)) {
    watching = key;
    watchAt = Date.now();
    invoke("sport_watch", { key: key || null, home: key ? f!.home.id : null }).catch(() => {});
  }
  pitch.run(!!key && pitch.el.isConnected);
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
    rememberColors(plan);
    planAt = Date.now();
    planErr = "";
  } catch (e) {
    planErr = String(e);
  }
  planLoading = false;
  if (view === "plan") renderPlan();
  if (view === "leagues") renderLeaguePlan();
  if (view === "teams") void renderTeams();
  if (view === "live" && !live.matches.length) renderLive();
}

/** Zeile im Spielplan: Zeit · Wappen Stand Wappen (· Wettbewerb) */
/** Tabellenplatz eines Teams in seinem Wettbewerb (0 = unbekannt); laedt die Tabelle einmal nach */
function rankOf(league: string, t: SportTeam): number {
  if (NO_TABLE.has(league) || !leagueInfo(league)) return 0;
  const c = tables.get(league);
  if (!c) {
    tables.set(league, { at: Date.now() });
    invoke<Group[]>("standings", { league })
      .then((g) => tables.set(league, { at: Date.now(), groups: g }))
      .catch((e) => tables.set(league, { at: Date.now(), err: String(e) }))
      .finally(() => { if (view === "plan") renderPlan(); });
    return 0;
  }
  for (const g of c.groups ?? []) {
    const r = g.rows.find((x) => x.team.id === t.id || norm(x.team.name) === norm(t.name));
    if (r) return r.rank;
  }
  return 0;
}

function prow(m: SportMatch, opts: { league?: boolean; when?: string; context?: boolean } = {}) {
  const lv = live.matches.find((x) => x.key === m.key) ?? m;
  const r = el("button", `prow ${lv.state}` + (lv.fav ? " fav" : "") + (opts.league ? " with-league" : ""));
  r.dataset.key = lv.key;
  if (lv.fav) r.style.setProperty("--fav", favColor(lv) || "var(--n-accent)");
  r.title = `${lv.home.name} – ${lv.away.name} · ${lv.league_name}`;
  const when = el("span", "p-when");
  if (opts.when) when.textContent = opts.when;
  else if (lv.state === "pre") when.textContent = timeOf(lv.start);
  else if (lv.state === "in") when.append(el("i", "live-dot"), clockOf(lv));
  else when.textContent = clockOf(lv) === "Ende" ? timeOf(lv.start) : clockOf(lv);
  const mid = el("span", "p-match");
  // Vereinsnamen stehen nur in breiten Spalten (Containerabfrage in styles.css), sonst reichen die Wappen
  mid.append(el("span", "p-name h", lv.home.short || lv.home.name), crestEl(lv.home), el("b", "", lv.state === "pre" ? "–" : scoreOf(lv)), crestEl(lv.away), el("span", "p-name a", lv.away.short || lv.away.name));
  r.append(when, mid);
  if (opts.league) r.append(el("span", "p-league", lv.league_name));
  else if (opts.context) {
    // Kontext rechts: Tabellenplaetze (Spitzenspiel?) und bei Spielen von heute der Countdown
    const ctx = el("span", "p-ctx");
    const a = rankOf(lv.league, lv.home), b = rankOf(lv.league, lv.away);
    if (a && b) {
      const rk = el("span", "p-rank" + (a <= 4 && b <= 4 ? " top" : ""), `${a}. – ${b}.`);
      rk.title = `Tabellenplätze: ${lv.home.name} ${a}., ${lv.away.name} ${b}.` + (a <= 4 && b <= 4 ? " · Spitzenspiel" : "");
      ctx.append(rk);
    }
    if (lv.state === "pre" && sameDay(lv.start, Date.now()) && lv.start > Date.now()) ctx.append(el("span", "p-soon", countdown(lv.start)));
    if (lv.state === "in") { const p = el("i", "p-prog"); p.style.setProperty("--p", String(progress(lv))); ctx.append(p); }
    r.append(ctx);
    r.classList.add("with-ctx");
  }
  r.onclick = () => openMatch(lv);
  return r;
}

function renderPlan() {
  const ids = chosen();
  const sports = [...new Set(ids.map(sportOf))];
  const sportChips = q(".plan-sports");
  sportChips.hidden = sports.length < 2;
  morph(sportChips, sports.map((s) => chip(SPORT_NAME[s] ?? s, !sportOff.has(s), () => {
    if (sportOff.has(s)) sportOff.delete(s); else sportOff.add(s);
    renderPlan();
  })));
  morph(q(".plan-leagues"), ids.filter((id) => !sportOff.has(sportOf(id))).map((id) => chip(leagueName(id), !planOff.has(id), () => {
    if (planOff.has(id)) planOff.delete(id); else planOff.add(id);
    renderPlan();
  }, "", leagueIcon(id, leagueName(id), "lg-ico sm"))));
  document.querySelectorAll<HTMLButtonElement>(".plan-scope button").forEach((b) => b.classList.toggle("active", b.dataset.scope === planScope));
  const box = q(".plan");
  if (!plan) {
    morph(box, [faint(planLoading ? "Spielplan wird geladen …" : planErr || "Noch nichts geladen")]);
    return;
  }
  const list = plan.filter((m) => !planOff.has(m.league) && !sportOff.has(m.sport) && (planScope === "all" || m.fav));
  if (!list.length) {
    morph(box, [faint(planScope === "fav" ? "Keine Spiele deiner Teams in diesen drei Wochen." : "Keine Spiele in diesem Zeitraum.")]);
    return;
  }
  // Tag -> Wettbewerb -> Spiele; jeder Tag des Zeitraums steht da (auch spielfreie), die Ligen nebeneinander
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
  for (const t of calendarDays(plan)) {
    const key = new Date(t).toDateString();
    const day = days.get(key);
    const sec = el("section", "day" + (day ? "" : " free"));
    sec.dataset.key = key;
    sec.append(el("h3", "day-head n-liquid", dayLabel(t)));
    if (!day) {
      sec.append(el("p", "day-free", "spielfrei"));
    } else {
      const grid = el("div", "day-grid");
      for (const [id, ms] of [...day.entries()].sort((a, b) => order(a[0]) - order(b[0]))) {
        const col = el("section", "plan-col");
        col.dataset.key = id;
        col.style.setProperty("--lc", leagueColor(id));
        const head = el("header", "pc-head");
        head.append(leagueIcon(id, leagueName(id)), el("span", "pc-name", leagueName(id)), el("span", "c-meta", `${ms.length} ${ms.length === 1 ? "Spiel" : "Spiele"}`));
        col.append(head, ...ms.map((m) => prow(m, { context: true })));
        grid.append(col);
      }
      sec.append(grid);
      if (!today && t >= start) today = sec;
    }
    out.push(sec);
  }
  morph(box, out);
  flowColumns(box);
  if (!planScrolled && today) {
    planScrolled = true;
    // der naechste Spieltag (heute oder spaeter) steht in der Mitte
    requestAnimationFrame(() => today!.scrollIntoView({ block: "center" }));
  }
}

/** Jeder Tag zwischen erstem und letztem Spiel des Zeitraums (Mitternacht, lokal) */
function calendarDays(ms: SportMatch[]): number[] {
  if (!ms.length) return [];
  const d = new Date(Math.min(...ms.map((m) => m.start)));
  d.setHours(0, 0, 0, 0);
  const end = Math.max(...ms.map((m) => m.start));
  const out: number[] = [];
  while (d.getTime() <= end && out.length < 60) { out.push(d.getTime()); d.setDate(d.getDate() + 1); }
  return out;
}

/**
 * Farbverlauf ueber die Ligen eines Tages: jede Spalte traegt ihre Ligafarbe, an der Grenze zur Nachbarspalte
 * (in derselben Zeile) fliesst sie in deren Farbe ueber (CSS-Verlauf in OKLCH). Bricht das Raster um, beginnt
 * jede Zeile in ihrer eigenen Farbe und bekommt runde Enden.
 */
function flowColumns(root: HTMLElement) {
  for (const grid of root.querySelectorAll<HTMLElement>(".day-grid")) {
    const cols = Array.from(grid.children) as HTMLElement[];
    const rows = new Map<number, HTMLElement[]>();
    for (const c of cols) rows.set(c.offsetTop, [...(rows.get(c.offsetTop) ?? []), c]);
    for (const row of rows.values()) {
      row.forEach((c, i) => {
        const own = c.style.getPropertyValue("--lc");
        c.style.setProperty("--l", i > 0 ? row[i - 1].style.getPropertyValue("--lc") : own);
        c.style.setProperty("--r", i < row.length - 1 ? row[i + 1].style.getPropertyValue("--lc") : own);
        c.classList.toggle("row-first", i === 0);
        c.classList.toggle("row-last", i === row.length - 1);
      });
    }
  }
}

// ---------- Ligen: Tabelle | Spielplan | Schlagzeilen ----------

type Row = { rank: number; team: SportTeam; played: string; won: string; draw: string; lost: string; goals: string; diff: string; points: string; pct: string; behind: string; note: string; color: string; fav: boolean };
type Group = { name: string; rows: Row[] };
const NO_TABLE = new Set(["dfb", "dfbteam", "turnier", "test"]);
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
  morph(seg, sports.map((s) => {
    const b = el("button", s === leagueSport ? "active" : "", SPORT_NAME[s] ?? s);
    b.onclick = () => { leagueSport = s; leagueId = ""; renderLeagues(); };
    return b;
  }));
  const mine = ids.filter((id) => sportOf(id) === leagueSport);
  if (!mine.includes(leagueId)) leagueId = mine.find((id) => !NO_TABLE.has(id)) ?? mine[0] ?? "";
  morph(q(".league-chips"), mine.map((id) => chip(leagueName(id), id === leagueId, () => { leagueId = id; renderLeagues(); }, "", leagueIcon(id, leagueName(id), "lg-ico sm"))));
  const grid = q(".league-grid");
  if (!leagueId) {
    grid.hidden = true;
    morph(q(".league-chips"), [faint("Wähle Wettbewerbe in den Einstellungen.", "faint")]);
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
    morph(box, [c]);
    return;
  }
  const c = tables.get(id);
  if (!c || Date.now() - c.at > 10 * 60_000) {
    if (!c) { const w = card("Tabelle"); w.append(faint("Tabelle wird geladen …", "faint c-empty")); morph(box, [w]); }
    tables.set(id, { ...(c ?? {}), at: Date.now() });
    invoke<Group[]>("standings", { league: id })
      .then((g) => tables.set(id, { at: Date.now(), groups: g }))
      .catch((e) => tables.set(id, { at: Date.now(), err: String(e) }))
      .finally(() => { if (view === "leagues" && leagueId === id) renderTable(); });
    if (!c) return;
  }
  if (c?.err) { const w = card("Tabelle"); w.append(faint(c.err, "faint c-empty")); morph(box, [w]); return; }
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
      row.dataset.key = r.team.id || r.team.name;
      if (r.fav || isFavTeam(r.team)) row.style.setProperty("--fav", colorOfTeam(r.team.id, r.team.name) || "var(--n-accent)");
      row.title = r.note ? `${r.team.name} · ${r.note}` : r.team.name;
      if (r.color) { row.style.setProperty("--z", r.color); row.classList.add("zone"); notes.set(r.note, r.color); }
      const team = el("span", "t-team");
      team.append(crestEl(r.team), el("span", "t-short", r.team.short || r.team.name));
      const cells = us
        ? [String(r.rank), team, r.won, r.lost, r.pct, sport === "hockey" ? r.points : r.behind]
        : [String(r.rank), team, r.played, r.won, r.draw, r.lost, r.goals, r.diff, r.points];
      row.append(...cells.map((x, i) => (typeof x === "string" ? el("span", i === cells.length - 1 ? "t-pts" : "", x) : x)));
      row.onclick = () => openTeam({ key: r.team.id, name: r.team.name, logo: r.team.logo });
      t.append(row);
    }
    out.push(t);
  }
  if (notes.size) {
    const legend = el("div", "legend");
    legend.dataset.key = "legend";
    for (const [n, color] of notes) {
      const i = el("span", "", n);
      i.style.setProperty("--z", color);
      legend.append(i);
    }
    out.push(legend);
  }
  morph(box, out);
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
    c.style.setProperty("--lc", leagueColor(leagueId));
    c.querySelector(".c-head")!.append(el("span", "c-meta", `${ms.length} Spiele · 4 Wochen`));
    if (!ms.length) list.append(faint("Keine Spiele in diesem Zeitraum.", "faint c-empty"));
    // jeder Tag des Zeitraums: Spieltage mit ihren Spielen (rasten beim Scrollen in der Mitte ein), freie Tage schmal
    let today: HTMLElement | null = null;
    const start = new Date().setHours(0, 0, 0, 0);
    for (const t of ms.length ? calendarDays(plan) : []) {
      const key = new Date(t).toDateString();
      const games = ms.filter((m) => new Date(m.start).toDateString() === key);
      const block = el("div", "lg-block" + (games.length ? "" : " free"));
      block.dataset.key = key;
      block.append(el("div", "lg-day", dayLabel(t)));
      if (games.length) block.append(...games.map((m) => prow(m)));
      else block.append(el("span", "lg-free", "spielfrei"));
      list.append(block);
      if (!today && games.length && t >= start) today = block;
    }
    // gleicher Wettbewerb: Position behalten (Live-Updates zeichnen neu), neuer: zu „Heute“ springen
    const prev = box.querySelector<HTMLElement>(".lg-scroll");
    const keep = lgPlanFor === leagueId && prev ? prev.scrollTop : -1;
    lgPlanFor = leagueId;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (keep >= 0) list.scrollTop = keep;
      else if (today) list.scrollTop = Math.max(0, list.scrollTop + today.getBoundingClientRect().top - list.getBoundingClientRect().top - (list.clientHeight - today.offsetHeight) / 2);
    }));
  }
  c.append(list);
  morph(box, [c]);
}
let lgPlanFor = "";

/** Zeitfenster je Filter: Meldungen allgemein eine Woche, Verletzungen zwei, Transfers (Geruechte ziehen sich) ein Monat */
const NEWS_DAYS = { all: 7, transfer: 30, injury: 14 } as const;
const fresh = (at: number, days: number) => !at || Date.now() - at < days * 86_400_000;

function renderNews() {
  const box = q(".lg-news");
  const id = leagueId;
  if (leagueInfo(id)?.source === "OpenLigaDB") {
    const c = card("Schlagzeilen");
    c.append(faint("Für diesen Wettbewerb gibt es keine Schlagzeilen (OpenLigaDB).", "faint c-empty"));
    morph(box, [c]);
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
  // nur einordnen, was ueberhaupt angezeigt werden kann (hoechstens 30 Tage alt)
  if (cur?.v && ls.state === "ready") classify(cur.v.news.filter((a) => fresh(a.at, NEWS_DAYS.transfer)).map((a) => a.headline));
  const work = layaWork();
  const meta = ls.state === "ready"
    ? work.busy && work.total ? `Laya ordnet ein … ${work.done}/${work.total}` : work.error ? "ESPN · Laya: Fehler" : "ESPN · eingeordnet von Laya"
    : "ESPN · englisch";
  const c = card("Schlagzeilen", meta, "news-card");
  if (!cur?.v) c.append(faint(cur?.err ?? "Wird geladen …", "faint c-empty"));
  else {
    const kinds = cur.v.news.map((a) => newsKind(a));
    const ats = cur.v.news.map((a) => a.at);
    const transfers = kinds.filter((k, i) => isTransferKind(k.kind) && fresh(ats[i], NEWS_DAYS.transfer)).length;
    const injuries = kinds.filter((k, i) => k.kind === "injury" && fresh(ats[i], NEWS_DAYS.injury)).length;
    const filters: [typeof newsFilter, string][] = [["all", "Alle"]];
    if (transfers) filters.push(["transfer", `Transfers · ${transfers}`]);
    if (injuries && kinds.some((k) => k.ai)) filters.push(["injury", `Verletzungen · ${injuries}`]);
    if (!filters.some(([k]) => k === newsFilter)) newsFilter = "all";
    if (filters.length > 1) {
      const seg = el("div", "n-seg news-seg");
      for (const [k, label] of filters) {
        const b = el("button", k === newsFilter ? "active" : "", label);
        b.onclick = () => { newsFilter = k; renderNews(); };
        seg.append(b);
      }
      c.append(seg);
    }
    const days = NEWS_DAYS[newsFilter];
    const list = cur.v.news.map((a, i) => ({ a, k: kinds[i] }))
      .filter(({ a, k }) => fresh(a.at, days) && (newsFilter === "all" || (newsFilter === "transfer" ? isTransferKind(k.kind) : k.kind === "injury")));
    c.append(el("p", "c-foot news-window", `Letzte ${days === 7 ? "7 Tage" : days === 14 ? "14 Tage" : "30 Tage"}`));
    if (!list.length) c.append(faint(`Keine Meldungen in den letzten ${days} Tagen.`, "faint c-empty"));
    for (const { a, k } of list.slice(0, 18)) {
      const r = el("button", "article" + (isTransferKind(k.kind) ? " transfer" : "") + (k.kind ? ` k-${k.kind}` : ""));
      r.dataset.key = a.headline;
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
      if (a.link) r.onclick = () => void invoke("open_link", { url: a.link }).catch(() => {});
      c.append(r);
    }
  }
  parts.push(c);
  if (cur?.v?.moves.length) {
    const m = card("Kaderbewegungen", `${cur.v.moves.length} zuletzt`, "moves-card");
    for (const x of cur.v.moves.slice(0, 20)) {
      const r = el("div", "move");
      r.dataset.key = `${x.at}:${x.text}`;
      r.append(crestEl(x.team), el("span", "mv-text", x.text), el("small", "mv-at", new Date(x.at).toLocaleDateString("de-DE", { day: "numeric", month: "short" })));
      m.append(r);
    }
    parts.push(m);
  }
  morph(box, parts);
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
  f.style.setProperty("--tc", colorOfTeam(t.key, t.name) || "var(--n-accent)");
  for (const m of [...last].reverse()) {
    const { r, home, text } = result(m, t);
    const opp = home ? m.away : m.home;
    const d = el("i", `f-${r}`);
    d.title = `${text} ${home ? "gegen" : "bei"} ${opp.name} · ${new Date(m.start).toLocaleDateString("de-DE")}`;
    f.append(d);
  }
  return f;
}


// ---------- Teams: links die Auswahl, rechts die Analyse (Team- bzw. Spielerkarte) ----------

type TeamPick = { key: string; name: string; logo: string; color?: string };
let teamSel: FavTeam | null = null;
let playerSel: { id: string; name: string; team: SportTeam; path: string } | null = null;
const leagueTeams = new Map<string, { v?: TeamPick[]; err?: string; loading?: boolean }>();
const teamOpen = new Set<string>();
let teamFilter = "";

function loadLeagueTeams(id: string) {
  if (leagueTeams.has(id)) return leagueTeams.get(id)!;
  const c = { loading: true } as { v?: TeamPick[]; err?: string; loading?: boolean };
  leagueTeams.set(id, c);
  invoke<TeamPick[]>("sport_teams", { league: id })
    .then((v) => { for (const t of v) rememberColor(t.key, t.name, t.color ?? ""); leagueTeams.set(id, { v }); })
    .catch((e) => leagueTeams.set(id, { err: String(e) }))
    .finally(() => { if (view === "teams") renderTeamSide(); });
  return c;
}

const sportTeamOf = (t: FavTeam): SportTeam => ({ id: t.key, name: t.name, short: t.name, abbr: "", logo: t.logo ?? "", color: colorOfTeam(t.key, t.name) || "#75b8ff", score: "" });

function selectTeam(t: FavTeam) {
  teamSel = t;
  playerSel = null;
  void renderTeams();
  q("main").scrollTop = 0;
}

/** Seitenleiste: deine Teams, darunter alle Teams der gewaehlten Wettbewerbe (aufklappbar, Suche) */
function renderTeamSide() {
  const box = q(".ts-list");
  const out: HTMLElement[] = [];
  const row = (t: FavTeam, sub?: HTMLElement, group = "fav") => {
    const b = el("button", "ts-row" + (teamSel?.key === t.key ? " on" : ""));
    b.dataset.key = `${group}:${t.key}`;
    const tc = colorOfTeam(t.key, t.name);
    if (tc) b.style.setProperty("--tc", tc);
    const txt = el("span", "ts-txt");
    txt.append(el("b", "", t.name));
    if (sub) txt.append(sub);
    b.append(crestOf(t, "crest"), txt);
    b.onclick = () => selectTeam(t);
    return b;
  };
  const f = norm(teamFilter);
  const hit = (n: string) => !f || norm(n).includes(f);
  const favs = snap.sport.teams.filter((t) => hit(t.name));
  out.push(el("div", "n-eyebrow ts-head", "Meine Teams"));
  for (const t of favs) {
    const v = teamViews.get(t.key)?.v;
    const sub = el("small", "ts-sub");
    const place = tablePlace(t);
    const nx = v?.next[0];
    sub.textContent = [place, nx ? `${shortDay(nx.start).replace(/ · .*$/, "")} ${timeOf(nx.start)}` : ""].filter(Boolean).join(" · ");
    out.push(row(t, sub));
  }
  if (!snap.sport.teams.length) out.push(faint("Noch keine Teams – unten auswählen oder in den Einstellungen.", "faint ts-hint"));
  // alle Teams je Wettbewerb (Laenderspiele haben keine Vereinsauswahl)
  for (const id of chosen().filter((x) => x !== "test" && x !== "turnier")) {
    const open = teamOpen.has(id) || !!f;
    const head = el("button", "ts-league" + (open ? " open" : ""));
    head.dataset.key = `l:${id}`;
    head.append(leagueIcon(id, leagueName(id), "lg-ico sm"), el("span", "", leagueName(id)), el("i", "ts-chev"));
    head.setAttribute("aria-expanded", String(open));
    head.onclick = () => { if (teamOpen.has(id)) teamOpen.delete(id); else teamOpen.add(id); renderTeamSide(); };
    out.push(head);
    if (!open) continue;
    const c = loadLeagueTeams(id);
    if (!c.v) { out.push(faint(c.err ?? "Wird geladen …", "faint ts-hint")); continue; }
    const list = c.v.filter((t) => hit(t.name));
    for (const t of list) out.push(row({ key: t.key, name: t.name, logo: t.logo }, undefined, id));
    if (!list.length) out.push(faint("Kein Treffer", "faint ts-hint"));
  }
  morph(box, out);
}

async function renderTeams() {
  if (!teamSel && snap.sport.teams[0]) teamSel = snap.sport.teams[0];
  renderTeamSide();
  renderTeamMain();
  const missing = snap.sport.teams.filter((t) => !teamViews.get(t.key)?.v && !teamViews.get(t.key)?.err);
  if (teamSel && !teamViews.get(teamSel.key)?.v && !teamViews.get(teamSel.key)?.err) missing.push(teamSel);
  if (missing.length) {
    await Promise.all(missing.map((t) => loadTeam(t.key)));
    if (view === "teams") { renderTeamSide(); renderTeamMain(); }
  }
}

function renderTeamMain() {
  const box = q(".teams-main");
  if (playerSel) return morph(box, playerPage(playerSel));
  const t = teamSel;
  if (!t) {
    const e = el("div", "empty");
    e.append(el("p", "empty-title", "Wähle links ein Team"));
    const add = el("button", "n-btn primary", "Teams auswählen");
    add.onclick = () => openSettings();
    e.append(add);
    return morph(box, [e]);
  }
  morph(box, teamPage(t));
}

/** Letzte Aufstellungen fuer die Teamseite (eigenes Exemplar, nur ein Team) */
const teamHistory = new LineupHistory(
  (team) => {
    let p = lineupGames.get(team);
    if (!p) { p = invoke<LineupGame[]>("recent_lineups", { team }); lineupGames.set(team, p); p.catch(() => lineupGames.delete(team)); }
    return p;
  },
  (p, t) => openPlayerPage(p, t),
);

function teamPage(t: FavTeam): HTMLElement[] {
  const st = sportTeamOf(t);
  const soccer = t.key.startsWith("soccer:");
  const v = teamViews.get(t.key);
  // Kopf: Wappen, Name, Platz, Knoepfe
  const hero = el("section", "tp-hero n-card");
  hero.dataset.key = `hero:${t.key}`;
  hero.style.setProperty("--tc", st.color);
  const title = el("div", "tp-title");
  title.append(el("h2", "", t.name));
  const place = tablePlace(t);
  const nx = v?.v?.next[0];
  title.append(el("span", "tp-sub", [place, nx?.league_name].filter(Boolean).join(" · ") || " "));
  const mine = snap.sport.teams.some((x) => x.key === t.key);
  const acts = el("div", "tp-acts");
  const fav = el("button", "n-btn" + (mine ? " ghost" : " primary"), mine ? "Aus meinen Teams" : "Zu meinen Teams");
  fav.dataset.key = "fav";
  fav.onclick = () => {
    const teams = mine ? snap.sport.teams.filter((x) => x.key !== t.key) : [...snap.sport.teams, { key: t.key, name: t.name, ...(t.logo ? { logo: t.logo } : {}) }];
    const sport = { ...snap.sport, teams };
    snap = { ...snap, sport };
    invoke<Snapshot>("settings_set", { sport }).then((s) => { snap = s; onSettings(false); }).catch(() => {});
    announce(mine ? `${t.name} entfernt` : `${t.name} hinzugefügt`);
    onSettings(false);
  };
  const cal = el("button", "n-btn ghost", "In den Kalender");
  cal.dataset.key = "cal";
  cal.title = "Kommende Spiele als .ics speichern und im Kalender öffnen";
  cal.onclick = () => void exportCalendar(t);
  acts.append(fav, cal);
  hero.append(crestOf(t, "crest tp-crest"), title, acts);
  // Spiele: als Naechstes, letzte Ergebnisse mit Form
  const games = card("Spiele", v?.v ? `Form ${v.v.last.length ? "" : "–"}` : "", "tp-games");
  if (!v?.v) games.append(faint(v?.err ?? "Wird geladen …", "faint c-empty"));
  else {
    games.querySelector(".c-meta")?.replaceChildren(formEl(t, v.v.last));
    games.append(el("div", "n-eyebrow tp-eb", "Als Nächstes"));
    if (!v.v.next.length) games.append(faint("Kein Spiel angesetzt", "faint"));
    v.v.next.slice(0, 3).forEach((m) => games.append(prow(m, { when: `${shortDay(m.start)} ${timeOf(m.start)}`, league: true })));
    games.append(el("div", "n-eyebrow tp-eb", "Letzte Ergebnisse"));
    if (!v.v.last.length) games.append(faint("Noch keine", "faint"));
    v.v.last.slice(0, 5).forEach((m) => {
      const r = prow(m, { when: new Date(m.start).toLocaleDateString("de-DE", { day: "numeric", month: "short" }), league: true });
      r.classList.add(`res-${result(m, t).r}`);
      games.append(r);
    });
  }
  const left: HTMLElement[] = [games];
  const right: HTMLElement[] = [];
  // Fussball: Kaderstaerken, Beste im Kader, letzte Aufstellungen
  const stats = soccer ? loadSquadStats(t.key) : null;
  if (stats?.v) {
    left.push(squadRadar(t, stats.v));
    right.push(bestCard(t, stats.v));
  } else if (stats) {
    const w = card("Stärken des Kaders", "Saison");
    w.append(faint(stats.err ?? "Saisonwerte werden geladen …", "faint c-empty"));
    left.push(w);
  }
  if (soccer) {
    teamHistory.setTeam(st);
    const h = card("Letzte Aufstellungen", "Startelf · ‹ › blättern", "history-card");
    h.append(teamHistory.el);
    right.push(h);
  }
  right.push(squadCard(t));
  const cols = el("div", "tp-cols");
  cols.dataset.key = `cols:${t.key}`;
  const a = el("div", "col"), b = el("div", "col");
  a.dataset.key = "a"; b.dataset.key = "b";
  a.append(...left);
  b.append(...right);
  cols.append(a, b);
  return [hero, cols];
}

/** Beste im Kader: Tore, Vorlagen, Einsatzzeit (antippen = Spielerkarte) */
function bestCard(t: FavTeam, v: PlayerStats[]) {
  const c = card("Beste im Kader", "Saison", "tp-best");
  const st = sportTeamOf(t);
  const top = (label: string, k: keyof PlayerStats, fmt: (x: number) => string) => {
    const list = [...v].filter((p) => Number(p[k]) > 0).sort((a, b) => Number(b[k]) - Number(a[k])).slice(0, 3);
    const box = el("div", "tb-group");
    box.dataset.key = label;
    box.append(el("span", "n-eyebrow", label));
    if (!list.length) box.append(el("span", "faint", "–"));
    for (const p of list) {
      const r = el("button", "tb-row");
      r.append(el("span", "tb-name", p.name), el("b", "", fmt(Number(p[k]))));
      r.onclick = () => openPlayerPage({ id: p.id, name: p.name }, st, "");
      box.append(r);
    }
    return box;
  };
  c.append(top("Tore", "goals", String), top("Vorlagen", "assists", String), top("Einsatzminuten", "minutes", (x) => x.toLocaleString("de-DE")));
  return c;
}

/** Kader nach Position; jede Zeile oeffnet die Spielerkarte */
function squadCard(t: FavTeam) {
  const r = rosters.get(t.key);
  const c = card("Kader", r?.v ? `${r.v.length} Spieler` : "", "tp-squad");
  if (!r) {
    rosters.set(t.key, { loading: true });
    invoke<RosterPlayer[]>("team_roster", { key: t.key })
      .then((v) => rosters.set(t.key, { v }))
      .catch((e) => rosters.set(t.key, { err: String(e) }))
      .finally(() => { if (view === "teams") renderTeamMain(); });
  }
  if (!r?.v) { c.append(faint(r?.err ?? "Kader wird geladen …", "faint c-empty")); return c; }
  const stats = t.key.startsWith("soccer:") ? squadStats.get(t.key)?.v : undefined;
  const st = sportTeamOf(t);
  const groups = new Map<string, RosterPlayer[]>();
  const soccer = r.v.every((p) => !p.pos || p.pos in POS_DE);
  for (const p of r.v) {
    const g = soccer ? POS_DE[p.pos] ?? "Weitere" : p.pos_name || p.pos || "Weitere";
    groups.set(g, [...(groups.get(g) ?? []), p]);
  }
  const order = ["Tor", "Abwehr", "Mittelfeld", "Sturm"];
  for (const [g, ps] of [...groups.entries()].sort((a, b) => (order.indexOf(a[0]) + 1 || 9) - (order.indexOf(b[0]) + 1 || 9))) {
    c.append(el("div", "n-eyebrow tp-eb", `${g} · ${ps.length}`));
    for (const p of ps.sort((a, b) => (Number(a.jersey) || 99) - (Number(b.jersey) || 99))) {
      const s = stats?.find((x) => x.id === p.id) ?? stats?.find((x) => x.name === p.name);
      const row = el("button", "player" + (p.injury ? " hurt" : ""));
      row.dataset.key = `${p.jersey}:${p.name}`;
      row.append(el("span", "pl-no", p.jersey || "–"), el("span", "pl-name", p.name));
      const meta = el("span", "pl-meta");
      if (s && s.minutes > 0) meta.append(el("span", "pl-line", `${s.goals} T · ${s.assists} V · ${s.minutes.toLocaleString("de-DE")}′`));
      if (p.flag) { const f = new Image(); f.alt = p.nation; f.title = p.nation; f.src = p.flag; f.onerror = () => f.remove(); meta.append(f); }
      if (p.age) meta.append(el("span", "", `${p.age}`));
      row.append(meta);
      if (p.injury) { const i = el("span", "pl-hurt", "verletzt"); i.title = p.injury; row.append(i); }
      row.title = `${p.name} – Spielerkarte öffnen`;
      row.onclick = () => openPlayerPage({ id: p.id, name: p.name }, st, "");
      c.append(row);
    }
  }
  c.append(faint("Kader: ESPN · Spielerkarte: Steckbrief, Saisonwerte, Radar, ähnliche Spieler, Vereinsstationen", "faint fine"));
  return c;
}

// ---------- Spielerkarte (Teams-Ansicht): alles zu einem Spieler ----------

type Station = { club: string; from: string; to: string; apps: number | null; goals: number | null; loan: boolean; national: boolean };
type PlayerInfo = { name: string; age: number; born: string; height_cm: number; weight_kg: number; nation: string; flag: string; position: string;
  headshot: string; photo: string; photo_page: string; career: Station[]; transfermarkt: string; wikidata: string };
const playerInfos = new Map<string, { v?: PlayerInfo; err?: string }>();
const pools = new Map<string, Promise<Pool>>();
const poolOf = new Map<string, Pool>();
const similars = new Map<string, { list?: Similar[]; err?: string; step: string }>();
const qualityRadar = new RadarAnim("player-radar");
let compareId = "";

/** Liga-Pfad fuer ESPN-Spielerdaten: aus dem angesehenen Spiel ("soccer/ger.1:…"); leer = Liga des Teams */
function pathOfFocus() {
  const k = focusMatch()?.key ?? "";
  const path = k.split(":")[0].split("/")[1] ?? "";
  return path && path !== "club.friendly" ? path : "";
}

/** Spielerkarte oeffnen (aus Aufstellung, Feld, Kader, ähnlichen Spielern) */
function openPlayerPage(p: Pick<Player, "id" | "name">, team: SportTeam, path = pathOfFocus()) {
  if (!p.id) return;
  if (sheetKind) closeSheet();
  playerSel = { id: p.id, name: p.name, team, path };
  teamSel = { key: team.id, name: team.name, ...(team.logo ? { logo: team.logo } : {}) };
  if (compareId === p.id) compareId = "";
  if (!playerInfos.has(p.id)) {
    playerInfos.set(p.id, {});
    invoke<PlayerInfo>("player_info", { id: p.id, path, name: p.name, team: team.id })
      .then((v) => playerInfos.set(p.id, { v }))
      .catch((e) => playerInfos.set(p.id, { err: String(e) }))
      .finally(() => { if (playerSel?.id === p.id && view === "teams") renderTeamMain(); });
  }
  if (view !== "teams") setView("teams"); else void renderTeams();
  q("main").scrollTop = 0;
}
const openPlayerSheet = openPlayerPage;

/** Alle Spieler der Liga (einmal je Liga, ~10 s beim ersten Mal) */
function loadPool(teamKey: string): Promise<Pool> {
  let p = pools.get(teamKey);
  if (!p) {
    p = invoke<Pool>("league_pool", { team: teamKey }).then((pool) => {
      for (const x of pool.players) rememberColor(x.team.id, x.team.name, x.team.color);
      poolOf.set(teamKey, pool);
      return pool;
    });
    pools.set(teamKey, p);
    p.catch(() => pools.delete(teamKey));
  }
  return p;
}

function loadSimilar(me: PlayerStats, teamKey: string) {
  if (similars.has(me.id)) return;
  const s = { step: "Liga wird geladen (beim ersten Mal ca. 10 s) …" } as { list?: Similar[]; err?: string; step: string };
  similars.set(me.id, s);
  const redraw = () => { if (playerSel?.id === me.id && view === "teams") renderTeamMain(); };
  loadPool(teamKey)
    .then((pool) => {
      s.step = layaStatus().state === "ready" ? "Laya ordnet die Spielerrollen ein …" : "Werte werden verglichen …";
      redraw();
      return similar(pool, me, 6, true);
    })
    .then(async (list) => {
      s.list = list;
      // Rolle des Spielers selbst (Laya hat sie bei der Suche schon eingeordnet: kommt aus dem Zwischenspeicher)
      const r = await roleFor(me);
      if (r) roleTag.set(me.id, r);
    })
    .catch((e) => { s.err = String(e); })
    .finally(redraw);
}

/** Werte je Achse: Feldspieler je 90 Minuten im Vergleich zum Besten der Bezugsgruppe (Liga, sonst Kader) */
function quality(p: PlayerStats, ref: PlayerStats[]) {
  const per90 = (x: PlayerStats, k: keyof PlayerStats) => (x.minutes > 0 ? (Number(x[k]) || 0) / (x.minutes / 90) : 0);
  const pool = ref.filter((x) => x.minutes >= 270 && group(x.pos) === group(p.pos));
  const best = (f: (x: PlayerStats) => number) => Math.max(0.0001, ...pool.map(f), f(p));
  const rel = (f: (x: PlayerStats) => number) => (p.minutes > 0 ? Math.min(1, f(p) / best(f)) : null);
  const passQ = (x: PlayerStats) => x.passes_ok / Math.max(1, x.passes_ok + x.passes_bad);
  const duelQ = (x: PlayerStats) => x.duels_won / Math.max(1, x.duels);
  if (group(p.pos) === "G") {
    const g = Math.max(1, p.minutes / 90);
    return {
      axes: ["Paraden", "Weiße Weste", "Gegentore", "Passquote"],
      values: p.minutes > 0 ? [scale(p.saves / g, 1, 5), scale(p.clean_sheets / Math.max(1, p.apps), 0, 0.5), scale(p.conceded / g, 2.6, 0.6), scale(passQ(p), 0.55, 0.9)] : [null, null, null, null],
      raw: [`${de1(p.saves / g)} / Spiel`, `${p.clean_sheets} von ${p.apps}`, `${de1(p.conceded / g)} / Spiel`, pctTxt(passQ(p))],
    };
  }
  const def = (x: PlayerStats) => per90(x, "tackles") + per90(x, "interceptions") + per90(x, "recoveries");
  return {
    axes: ["Tore", "Vorlagen", "Schüsse", "Torschussvorlagen", "Passquote", "Zweikampfquote", "Ballgewinne"],
    values: [rel((x) => per90(x, "goals")), rel((x) => per90(x, "assists")), rel((x) => per90(x, "shots")), rel((x) => per90(x, "shot_assists")),
      p.minutes > 0 ? scale(passQ(p), 0.6, 0.92) : null, p.minutes > 0 && p.duels ? scale(duelQ(p), 0.3, 0.7) : null, rel(def)],
    raw: [`${de1(per90(p, "goals"))} / 90`, `${de1(per90(p, "assists"))} / 90`, `${de1(per90(p, "shots"))} / 90`, `${de1(per90(p, "shot_assists"))} / 90`,
      pctTxt(passQ(p)), p.duels ? pctTxt(duelQ(p)) : "–", `${de1(def(p))} / 90`],
  };
}

/** zweite Farbe im Vergleich: zu aehnliche Teamfarben (gleiches Team) -> hell */
function contrastColor(a: string, b: string) {
  const rgb = (c: string) => { const h = c.replace("#", ""); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) || 0); };
  const [x, y] = [rgb(a), rgb(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) < 90 ? "#e5e5ea" : b;
}

function playerPage(sp: { id: string; name: string; team: SportTeam; path: string }): HTMLElement[] {
  const c = playerInfos.get(sp.id);
  const v = c?.v;
  const soccer = sp.team.id.startsWith("soccer:");
  const squad = soccer ? loadSquadStats(sp.team.id) : null;
  const pool = poolOf.get(sp.team.id);
  const me = squad?.v?.find((x) => x.id === sp.id) ?? pool?.players.find((x) => x.id === sp.id) ?? squad?.v?.find((x) => x.name === sp.name);
  const out: HTMLElement[] = [];
  // zurueck zum Team
  const back = el("button", "tp-back");
  back.dataset.key = "back";
  back.append(crestEl(sp.team, "crest"), el("span", "", `‹ ${sp.team.name}`));
  back.onclick = () => { playerSel = null; void renderTeams(); };
  out.push(back);
  // Kopf: Foto, Name, Steckbrief, Rolle
  const head = el("section", "pp-head n-card");
  head.dataset.key = `pp:${sp.id}`;
  head.style.setProperty("--tc", sp.team.color);
  const pic = el("div", "pp-pic");
  const src = v?.headshot || v?.photo;
  if (src) {
    const img = new Image();
    img.alt = sp.name;
    img.src = src;
    img.onerror = () => { if (v?.photo && src !== v.photo) img.src = v.photo; else img.remove(); };
    pic.append(img);
  } else pic.append(el("span", "pp-init", me?.jersey || sp.name.split(/\s+/).map((x) => x[0]).slice(0, 2).join("")));
  const info = el("div", "pp-info");
  info.append(el("b", "pp-name", v?.name || sp.name));
  const sub = el("span", "pp-pos");
  sub.append(crestEl(sp.team, "crest"), [sp.team.name, v?.position, me?.jersey ? `Nr. ${me.jersey}` : ""].filter(Boolean).join(" · "));
  info.append(sub);
  const facts = el("div", "pp-facts");
  const fact = (k: string, val: string) => { if (!val) return; const f = el("span", ""); f.append(el("b", "", val), el("small", "", k)); facts.append(f); };
  if (v) {
    fact("Alter", v.age ? `${v.age}` : "");
    fact("Geboren", v.born ? new Date(v.born).toLocaleDateString("de-DE") : "");
    fact("Größe", v.height_cm ? `${v.height_cm} cm` : "");
    fact("Gewicht", v.weight_kg ? `${v.weight_kg} kg` : "");
    if (v.nation) {
      const n = el("span", "pp-nation");
      if (v.flag) { const f = new Image(); f.src = v.flag; f.alt = ""; f.onerror = () => f.remove(); n.append(f); }
      n.append(el("b", "", v.nation));
      facts.append(n);
    }
  }
  info.append(facts);
  const myRole = me ? roleTag.get(me.id) : undefined;
  if (myRole) info.append(el("span", "pp-role", `Rolle (Laya): ${roleName(myRole)}`));
  head.append(pic, info);
  const links = el("div", "pp-links");
  if (v?.transfermarkt) {
    const tm = el("button", "n-btn ghost", "Transfermarkt");
    tm.title = "Marktwert und Transfers bei Transfermarkt";
    tm.onclick = () => void invoke("open_link", { url: `https://www.transfermarkt.de/spieler/profil/spieler/${v.transfermarkt}` }).catch(() => {});
    links.append(tm);
  }
  if (v?.photo && !v.headshot) {
    const cr = el("button", "pp-credit", "Foto: Wikimedia Commons");
    cr.onclick = () => void invoke("open_link", { url: v.photo_page }).catch(() => {});
    links.append(cr);
  }
  head.append(links);
  out.push(head);
  if (c?.err) out.push(faint(c.err, "faint"));
  const left: HTMLElement[] = [];
  const right: HTMLElement[] = [];
  // Saisonwerte
  const sc = card("Saisonwerte", me ? `${me.apps} Einsätze` : "", "pp-season");
  if (!me) sc.append(faint(squad?.loading ? "Saisonwerte werden geladen …" : "Keine Saisonwerte (ESPN führt den Spieler nicht im Kader)", "faint c-empty"));
  else {
    const g = el("div", "pp-tiles");
    const tile = (k: string, val: string) => { const t = el("span", "pp-tile"); t.append(el("b", "", val), el("small", "", k)); g.append(t); };
    const pq = me.passes_ok + me.passes_bad;
    tile("Minuten", me.minutes.toLocaleString("de-DE"));
    if (group(me.pos) === "G") {
      tile("Paraden", String(me.saves)); tile("Gegentore", String(me.conceded)); tile("Weiße Weste", String(me.clean_sheets));
      tile("Passquote", pq ? pctTxt(me.passes_ok / pq) : "–");
    } else {
      tile("Tore", String(me.goals)); tile("Vorlagen", String(me.assists)); tile("Schüsse", `${me.shots} (${me.shots_on} aufs Tor)`);
      tile("Torschussvorlagen", String(me.shot_assists)); tile("Passquote", pq ? pctTxt(me.passes_ok / pq) : "–");
      tile("Zweikampfquote", me.duels ? pctTxt(me.duels_won / me.duels) : "–"); tile("Tacklings", String(me.tackles));
      tile("Ballgewinne", String(me.interceptions)); tile("Balleroberungen", String(me.recoveries));
    }
    sc.append(g);
  }
  left.push(sc);
  // Spielerqualitaet mit Vergleich (Radar mit Uebergang)
  const qc = card("Spielerqualität", pool ? `Bezug: Beste der ${pool.league}` : "Bezug: Bester im Kader", "pp-radar");
  qc.dataset.key = "pp-radar";
  if (me) {
    const ref = pool?.players ?? squad?.v ?? [me];
    const a = quality(me, ref);
    const series = [{ label: me.name, color: sp.team.color || "#75b8ff", values: a.values, raw: a.raw }];
    const other = compareId ? pool?.players.find((x) => x.id === compareId) : undefined;
    if (other) {
      const b = quality(other, ref);
      series.push({ label: `${other.name} (${other.team.short || other.team.name})`, color: contrastColor(sp.team.color || "#75b8ff", other.team.color || "#e5e5ea"), values: b.values, raw: b.raw });
    }
    qualityRadar.set(a.axes, series);
    qc.append(qualityRadar.el);
    // Vergleich waehlen: Spieler der Liga (gleiche Positionsgruppe)
    const cmp = el("div", "pp-compare");
    cmp.dataset.key = "cmp";
    if (pool) {
      const sel = el("select", "pp-select");
      sel.append(new Option("Mit Spieler vergleichen …", ""));
      for (const p of pool.players.filter((x) => x.id !== me.id && group(x.pos) === group(me.pos) && x.minutes >= 270).sort((x, y) => x.name.localeCompare(y.name, "de"))) {
        const o = new Option(`${p.name} · ${p.team.short || p.team.name}`, p.id);
        if (p.id === compareId) o.selected = true;
        sel.append(o);
      }
      sel.onchange = () => { compareId = sel.value; renderTeamMain(); };
      cmp.append(sel);
      if (compareId) {
        const x = el("button", "n-btn ghost", "Vergleich beenden");
        x.onclick = () => { compareId = ""; renderTeamMain(); };
        cmp.append(x);
      }
    } else {
      const b = el("button", "n-btn ghost", "Mit Spielern der Liga vergleichen");
      b.onclick = () => { void loadPool(sp.team.id).then(() => renderTeamMain()); b.disabled = true; b.textContent = "Liga wird geladen …"; };
      cmp.append(b);
    }
    qc.append(cmp, el("p", "c-foot", group(me.pos) === "G" ? "Bezug: gute und schwache Werte einer Saison" : "Strahlen je 90 Minuten im Vergleich zum Besten der Bezugsgruppe (ab 270 Min.); Quoten absolut"));
  } else qc.append(faint("Ohne Saisonwerte kein Radar", "faint c-empty"));
  left.push(qc);
  // Aehnliche Spieler (Werte + Laya-Rollen)
  const simCard = card("Ähnliche Spieler", layaStatus().state === "ready" ? "Werte + Rolle (Laya)" : "nach Saisonwerten", "pp-similar");
  if (me && soccer) {
    loadSimilar(me, sp.team.id);
    const s = similars.get(me.id)!;
    if (s.list) {
      if (!s.list.length) simCard.append(faint("Keine vergleichbaren Spieler (zu wenige Minuten)", "faint c-empty"));
      for (const x of s.list) {
        if (x.role) roleTag.set(x.p.id, x.role);
        const r = el("div", "sim-row");
        r.dataset.key = x.p.id;
        const open = el("button", "sim-main");
        open.append(crestEl(x.p.team, "crest"), el("span", "sim-name", x.p.name));
        const meta = el("small", "sim-meta", [x.p.team.short || x.p.team.name, roleName(x.role)].filter(Boolean).join(" · "));
        open.append(meta);
        open.onclick = () => openPlayerPage({ id: x.p.id, name: x.p.name }, x.p.team, "");
        const bar = el("span", "sim-bar");
        bar.style.setProperty("--p", String(x.score));
        bar.style.setProperty("--tc", x.p.team.color || "var(--n-accent)");
        bar.title = `Ähnlichkeit ${Math.round(x.score * 100)} %`;
        bar.append(el("i"), el("b", "", `${Math.round(x.score * 100)} %`));
        const vs = el("button", "n-btn ghost sim-vs", compareId === x.p.id ? "im Vergleich" : "Vergleichen");
        vs.onclick = () => { compareId = x.p.id; renderTeamMain(); q(".pp-radar")?.scrollIntoView({ block: "nearest", behavior: "smooth" }); };
        r.append(open, bar, vs);
        simCard.append(r);
      }
      if (layaStatus().state !== "ready") simCard.append(faint("Mit Laya (Einstellungen) fließt auch die Spielerrolle ein.", "faint fine"));
    } else simCard.append(faint(s.err ?? s.step, "faint c-empty"));
  } else simCard.append(faint(soccer ? "Ohne Saisonwerte keine Suche" : "Gibt es für Fußball", "faint c-empty"));
  right.push(simCard);
  // Vereinsstationen
  const cc = card("Vereinsstationen", v?.career.length ? "Wikidata · ohne Ablösesummen" : "", "pp-career");
  if (v?.career.length) {
    const ol = el("ol", "pp-stations");
    for (const st of v.career) {
      const li = el("li", (st.national ? "nat" : "") + (st.loan ? " loan" : "") + (!st.to ? " now" : ""));
      li.dataset.key = `${st.club}:${st.from}`;
      li.append(el("span", "pp-years", `${st.from || "?"}–${st.to || "heute"}`), el("b", "pp-club", st.club));
      const tags = el("span", "pp-tags");
      if (st.loan) tags.append(el("span", "pp-tag", "Leihe"));
      if (st.national) tags.append(el("span", "pp-tag", "Nationalteam"));
      if (st.apps != null) tags.append(el("span", "pp-num", `${st.apps} Sp.${st.goals != null ? ` · ${st.goals} T.` : ""}`));
      li.append(tags);
      ol.append(li);
    }
    cc.append(ol);
  } else cc.append(faint(!c || (!v && !c.err) ? "Wird geladen …" : "Keine Stationen gefunden", "faint c-empty"));
  right.push(cc);
  const cols = el("div", "tp-cols");
  cols.dataset.key = `pcols:${sp.id}`;
  const a = el("div", "col"), b = el("div", "col");
  a.dataset.key = "a"; b.dataset.key = "b";
  a.append(...left);
  b.append(...right);
  cols.append(a, b);
  out.push(cols, faint("Steckbrief und Saisonwerte: ESPN · Foto und Stationen: Wikidata/Wikimedia Commons · Marktwerte und Ablösen gibt es nicht frei – dafür der Link zu Transfermarkt.", "faint fine"));
  return out;
}

/** Rollen aus der letzten Aehnlichkeitssuche (Laya), je Spieler */
const roleTag = new Map<string, Role>();

// ---------- Seitenblatt ----------

let sheetKind: "" | "settings" = "";

function openSheet(kind: "settings", title: string | HTMLElement) {
  sheetKind = kind;
  q(".sheet-title").replaceChildren(title);
  q(".backdrop").hidden = false;
  requestAnimationFrame(() => q(".backdrop").classList.add("show"));
}

function closeSheet() {
  sheetKind = "";
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
    leagues: leagues.filter((l) => !l.auto),
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

/** Team in der Teams-Ansicht oeffnen (Tabelle, Suche, Kacheln) */
function openTeam(t: FavTeam) {
  teamSel = t;
  playerSel = null;
  if (view !== "teams") setView("teams"); else void renderTeams();
  q("main").scrollTop = 0;
}

type RosterPlayer = { id: string; jersey: string; name: string; pos: string; pos_name: string; age: number; nation: string; flag: string; injury: string };
const rosters = new Map<string, { v?: RosterPlayer[]; err?: string; loading?: boolean }>();
const POS_DE: Record<string, string> = { G: "Tor", D: "Abwehr", M: "Mittelfeld", F: "Sturm" };

type PlayerStats = {
  id: string; name: string; jersey: string; pos: string; apps: number; minutes: number; goals: number; assists: number;
  shots: number; shots_on: number; shot_assists: number; passes_ok: number; passes_bad: number; duels_won: number; duels: number;
  tackles: number; interceptions: number; recoveries: number; saves: number; conceded: number; clean_sheets: number;
};
const squadStats = new Map<string, { v?: PlayerStats[]; err?: string; loading?: boolean }>();
const de1 = (v: number) => v.toLocaleString("de-DE", { maximumFractionDigits: 1 });
const pctTxt = (v: number) => `${Math.round(v * 100)} %`;

type SquadState = { v?: PlayerStats[]; err?: string; loading?: boolean };
function loadSquadStats(key: string): SquadState {
  const c = squadStats.get(key);
  if (c) return c;
  const n: SquadState = { loading: true };
  squadStats.set(key, n);
  invoke<PlayerStats[]>("squad_stats", { key })
    .then((v) => squadStats.set(key, { v }))
    .catch((e) => squadStats.set(key, { err: String(e) }))
    .finally(() => { if (view === "teams" && (teamSel?.key === key || playerSel?.team.id === key)) renderTeamMain(); });
  return n;
}

/**
 * Staerken des Kaders: Saisonwerte aller Spieler, je Spiel gerechnet (Spielminuten / 990 = Spiele). Bezugsgroessen
 * sind Spitzen- bzw. Schwachwerte einer Bundesliga-Saison — ein voller Strahl heisst „sehr stark“, nicht „Maximum“.
 */
function squadRadar(t: FavTeam, v: PlayerStats[]) {
  const sum = (k: keyof PlayerStats) => v.reduce((a, p) => a + (Number(p[k]) || 0), 0);
  const games = Math.max(1, sum("minutes") / 990);
  const keepers = v.filter((p) => p.pos === "G");
  const conceded = keepers.reduce((a, p) => a + p.conceded, 0);
  const keeperGames = Math.max(1, keepers.reduce((a, p) => a + p.minutes, 0) / 90);
  const passes = sum("passes_ok") / Math.max(1, sum("passes_ok") + sum("passes_bad"));
  const duels = sum("duels_won") / Math.max(1, sum("duels"));
  const axes = ["Torgefahr", "Chancen", "Kreativität", "Passspiel", "Zweikampf", "Defensive", "Abwehr hält"];
  const vals = [
    scale(sum("goals") / games, 0.5, 2.8), scale(sum("shots") / games, 7, 20), scale(sum("shot_assists") / games, 4, 14),
    scale(passes, 0.72, 0.9), scale(duels, 0.42, 0.58), scale((sum("tackles") + sum("interceptions")) / games, 10, 32),
    keepers.length ? scale(conceded / keeperGames, 2.6, 0.6) : null,
  ];
  const raw = [`${de1(sum("goals") / games)} Tore / Spiel`, `${de1(sum("shots") / games)} Schüsse / Spiel`, `${de1(sum("shot_assists") / games)} Torschussvorlagen / Spiel`,
    pctTxt(passes), pctTxt(duels), `${de1((sum("tackles") + sum("interceptions")) / games)} Ballgewinne / Spiel`, keepers.length ? `${de1(conceded / keeperGames)} Gegentore / Spiel` : "–"];
  const c = card("Stärken des Kaders", `Saison · ${Math.round(games)} Spiele`, "squad-radar");
  const tc = colorOfTeam(t.key, t.name) || "#75b8ff";
  const any = sum("minutes") > 0;
  c.append(radarEl(axes, [{ label: t.name, color: tc, values: any ? vals : axes.map(() => null), raw }]));
  c.append(el("p", "c-foot", any ? "Bezug: Spitzen- und Schwachwerte einer Bundesliga-Saison" : "Noch keine Saisonwerte"));
  return c;
}


// ---------- Einstellungen / Abgleich ----------

function renderSync() {
  void refreshNotch(snap.notch);
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
}
let lastLeagues = "";

// ---------- Bedienung: Spiel wechseln, Heute, Tabellenplatz, Kalender ----------

/** Live: naechstes/voriges Spiel der Leiste */
function stepMatch(dir: 1 | -1) {
  const ms = live.matches;
  if (ms.length < 2) return;
  const cur = focusMatch();
  const i = Math.max(0, ms.findIndex((m) => m.key === cur?.key));
  focusKey = ms[(i + dir + ms.length) % ms.length].key;
  renderLive();
  q(`.tile[data-key="${CSS.escape(focusKey)}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/** Spielplan/Ligen: der naechste Spieltag (heute oder spaeter) in die Mitte */
function goToday() {
  const start = new Date().setHours(0, 0, 0, 0);
  if (view === "plan") {
    const day = [...document.querySelectorAll<HTMLElement>(".plan .day:not(.free)")].find((d) => new Date(d.dataset.key ?? "").getTime() >= start);
    day?.scrollIntoView({ block: "center", behavior: "smooth" });
  } else if (view === "leagues") {
    const list = q(".lg-scroll");
    const b = [...document.querySelectorAll<HTMLElement>(".lg-block:not(.free)")].find((d) => new Date(d.dataset.key ?? "").getTime() >= start);
    if (list && b) list.scrollTo({ top: list.scrollTop + b.getBoundingClientRect().top - list.getBoundingClientRect().top - (list.clientHeight - b.offsetHeight) / 2, behavior: "smooth" });
  }
}

/** Tabellenplatz eines Teams („Platz 3 · 15 Pkt“), sobald die Tabelle seiner Liga geladen ist */
function tablePlace(t: FavTeam): string {
  const m = [...live.matches, ...(plan ?? [])].find((x) => x.home.id === t.key || x.away.id === t.key || norm(x.home.name) === norm(t.name) || norm(x.away.name) === norm(t.name));
  if (!m || NO_TABLE.has(m.league)) return "";
  const c = tables.get(m.league);
  if (!c) {
    tables.set(m.league, { at: Date.now() });
    invoke<Group[]>("standings", { league: m.league })
      .then((g) => tables.set(m.league, { at: Date.now(), groups: g }))
      .catch((e) => tables.set(m.league, { at: Date.now(), err: String(e) }))
      .finally(() => { if (view === "teams") void renderTeams(); });
    return "";
  }
  for (const g of c.groups ?? []) {
    const r = g.rows.find((x) => x.team.id === t.key || norm(x.team.name) === norm(t.name));
    if (r) return `Platz ${r.rank}${r.points ? ` · ${r.points} Pkt` : ""}`;
  }
  return "";
}

/** Kommende Spiele eines Teams (Spielplan + Teamansicht) als iCalendar-Datei */
async function exportCalendar(t: FavTeam) {
  await loadTeam(t.key);
  const mine = (m: SportMatch) => m.home.id === t.key || m.away.id === t.key || norm(m.home.name) === norm(t.name) || norm(m.away.name) === norm(t.name);
  const all = new Map<string, SportMatch>();
  for (const m of [...(plan ?? []).filter(mine), ...(teamViews.get(t.key)?.v?.next ?? [])]) if (m.state === "pre" && m.start > Date.now()) all.set(m.key, m);
  const games = [...all.values()].sort((a, b) => a.start - b.start);
  if (!games.length) { announce("Keine kommenden Spiele"); return; }
  const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const esc = (x: string) => x.replace(/[\\;,]/g, (c) => `\\${c}`);
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Nojo//Arena//DE", "CALSCALE:GREGORIAN", `X-WR-CALNAME:${esc(t.name)}`];
  for (const m of games) {
    lines.push("BEGIN:VEVENT", `UID:${m.key.replace(/[^a-z0-9.:-]/gi, "-")}@arena.nojo`, `DTSTAMP:${stamp(Date.now())}`, `DTSTART:${stamp(m.start)}`,
      `DTEND:${stamp(m.start + (m.sport === "soccer" ? 115 : 150) * 60_000)}`, `SUMMARY:${esc(`${m.home.name} – ${m.away.name}`)}`,
      `DESCRIPTION:${esc(m.league_name)}`, ...(m.link ? [`URL:${m.link}`] : []), "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  try {
    const path = await invoke<string>("export_ics", { name: t.name, ics: lines.join("\n") });
    announce(`${games.length} Spiele gespeichert: ${path}`);
  } catch (e) { announce(`Kalender: ${e}`); }
}

// ---------- Schnellsuche (Strg+K) ----------

type Hit = { key: string; label: string; sub: string; lead?: HTMLElement; run: () => void; words: string };
let palHits: Hit[] = [];
let palSel = 0;

/** Alles, was man oeffnen kann: Ansichten, Aktionen, Ligen, Teams (aus Spielen, Tabellen, Favoriten), Spiele heute */
function paletteItems(): Hit[] {
  const out: Hit[] = [];
  const names: Record<View, string> = { live: "Live", plan: "Spielplan", leagues: "Ligen", teams: "Teams" };
  VIEWS.forEach((v, i) => out.push({ key: `v:${v}`, label: names[v], sub: `Ansicht · Strg+${i + 1}`, run: () => setView(v), words: names[v] }));
  out.push({ key: "a:full", label: isFull ? "Vollbild verlassen" : "Vollbild", sub: "F11", run: () => void setFull(!isFull), words: "vollbild fullscreen" });
  out.push({ key: "a:settings", label: "Einstellungen", sub: "Teams, Wettbewerbe, Notch, KI", run: openSettings, words: "einstellungen settings" });
  for (const id of chosen()) {
    const name = leagueName(id);
    out.push({ key: `l:${id}`, label: name, sub: `Liga · ${SPORT_NAME[sportOf(id)] ?? ""}`, lead: leagueIcon(id, name, "lg-ico"), words: name,
      run: () => { leagueSport = sportOf(id); leagueId = id; setView("leagues"); } });
  }
  for (const m of live.matches.filter((x) => x.state === "in")) {
    out.push({ key: `m:${m.key}`, label: `${m.home.short || m.home.name} – ${m.away.short || m.away.name}`, sub: `Live · ${scoreOf(m)} · ${clockOf(m)}`,
      lead: crestEl(m.home), words: `${m.home.name} ${m.away.name} live`, run: () => { focusKey = m.key; setView("live"); } });
  }
  const teams = new Map<string, { key: string; name: string; logo: string; league: string }>();
  const add = (id: string, name: string, logo: string, league: string) => { if (id && !teams.has(id)) teams.set(id, { key: id, name, logo, league }); };
  for (const t of snap.sport.teams) add(t.key, t.name, t.logo ?? "", "Mein Team");
  for (const m of [...live.matches, ...(plan ?? [])]) { add(m.home.id, m.home.name, m.home.logo, m.league_name); add(m.away.id, m.away.name, m.away.logo, m.league_name); }
  for (const [lg, c] of tables) for (const g of c.groups ?? []) for (const r of g.rows) add(r.team.id, r.team.name, r.team.logo, leagueName(lg));
  for (const t of teams.values()) {
    out.push({ key: `t:${t.key}`, label: t.name, sub: `Team · ${t.league}`, lead: crestOf({ name: t.name, logo: t.logo }, "crest"), words: t.name,
      run: () => void openTeam({ key: t.key, name: t.name, logo: t.logo }) });
  }
  return out;
}

function openPalette() {
  const w = q(".palette-wrap");
  w.hidden = false;
  const input = q<HTMLInputElement>(".pal-input");
  input.value = "";
  renderPalette();
  input.focus();
  requestAnimationFrame(() => w.classList.add("show"));
}

function closePalette() {
  const w = q(".palette-wrap");
  w.classList.remove("show");
  w.hidden = true;
}

function renderPalette() {
  const query = norm(q<HTMLInputElement>(".pal-input").value);
  const all = paletteItems();
  // Treffer: alle Woerter der Suche im Namen; Ansichten/Aktionen nur ohne oder mit passender Suche
  palHits = (query ? all.filter((h) => query.split(" ").every((w) => norm(h.words + " " + h.sub).includes(w))) : all.filter((h) => !h.key.startsWith("t:"))).slice(0, 12);
  palSel = Math.min(palSel, Math.max(0, palHits.length - 1));
  const list = q(".pal-list");
  morph(list, palHits.length ? palHits.map((h, i) => {
    const li = el("li", "pal-item" + (i === palSel ? " sel" : ""));
    li.dataset.key = h.key;
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", String(i === palSel));
    if (h.lead) li.append(h.lead);
    const txt = el("span", "pal-text");
    txt.append(el("b", "", h.label), el("small", "", h.sub));
    li.append(txt);
    li.onmousemove = () => { if (palSel !== i) { palSel = i; renderPalette(); } };
    li.onclick = () => { closePalette(); h.run(); };
    return li;
  }) : [el("li", "pal-empty", "Nichts gefunden")]);
}

function setupPalette() {
  const w = q(".palette-wrap");
  const input = q<HTMLInputElement>(".pal-input");
  input.addEventListener("input", () => { palSel = 0; renderPalette(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { palSel = Math.min(palHits.length - 1, palSel + 1); renderPalette(); e.preventDefault(); }
    else if (e.key === "ArrowUp") { palSel = Math.max(0, palSel - 1); renderPalette(); e.preventDefault(); }
    else if (e.key === "Enter") { const h = palHits[palSel]; if (h) { closePalette(); h.run(); } }
    else if (e.key === "Escape") { closePalette(); e.stopPropagation(); }
  });
  w.addEventListener("mousedown", (e) => { if (e.target === w) closePalette(); });
}

// ---------- Fenster: Vollbild und maximiert ----------

/** Fenster erst beim Start holen (vorher gibt es die Tauri-Bruecke evtl. noch nicht) */
let win: ReturnType<typeof getCurrentWindow>;
let isFull = false;

async function syncWindow() {
  const [full, max] = await Promise.all([win.isFullscreen().catch(() => false), win.isMaximized().catch(() => false)]);
  isFull = !!full;
  document.body.classList.toggle("full", isFull);
  document.body.classList.toggle("max", !!max);
}

async function setFull(on: boolean) {
  await win.setFullscreen(on).catch(() => {});
  await syncWindow();
}

// ---------- Start ----------

async function main() {
  hooks.open = (url) => void invoke("open_link", { url }).catch(() => {});
  hooks.player = (p, t) => openPlayerPage(p, t);
  q<HTMLInputElement>(".team-search").addEventListener("input", (e) => { teamFilter = (e.target as HTMLInputElement).value; renderTeamSide(); });
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
  void win.onResized(() => { void syncWindow(); void refreshNotch(snap.notch); }).catch(() => {});
  void win.onMoved(() => void refreshNotch(snap.notch)).catch(() => {});

  document.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view as View)));
  document.querySelectorAll<HTMLButtonElement>(".plan-scope button").forEach((b) =>
    b.addEventListener("click", () => { planScope = b.dataset.scope === "fav" ? "fav" : "all"; renderPlan(); }));
  q(".gear").addEventListener("click", openSettings);
  q(".find-btn").innerHTML = icon("search");
  q(".find-btn").addEventListener("click", openPalette);
  q(".today-btn").addEventListener("click", goToday);
  setupPalette();
  q(".sheet-x").addEventListener("click", closeSheet);
  q(".backdrop").addEventListener("mousedown", (e) => { if (e.target === e.currentTarget) closeSheet(); });
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); return; }
    if (!q(".palette-wrap").hidden) return; // die Suche hat eigene Tasten
    const typing = (e.target as HTMLElement | null)?.closest?.("input, textarea, select");
    if (!typing && !sheetKind && !e.ctrlKey && !e.altKey) {
      if (view === "live" && (e.key === "ArrowLeft" || e.key === "ArrowRight")) { stepMatch(e.key === "ArrowRight" ? 1 : -1); e.preventDefault(); return; }
      if ((view === "plan" || view === "leagues") && e.key.toLowerCase() === "h") { goToday(); return; }
    }
    if (e.key === "Escape") { if (sheetKind) closeSheet(); else if (arranging) setArranging(false); else if (isFull) void setFull(false); }
    if (e.key === "F11") { e.preventDefault(); void setFull(!isFull); }
    if (e.ctrlKey && /^[1-4]$/.test(e.key)) setView(VIEWS[Number(e.key) - 1]);
  });

  snap = (await invoke<Snapshot | null>("settings_get").catch(() => null)) ?? snap;
  lastLeagues = snap.sport.leagues.join(",");
  leagues = (await invoke<LeagueInfo[] | null>("sport_leagues").catch(() => null)) ?? [];
  // Liga-Symbole und -Farben (aus den Logos) — zeichnet neu, sobald sie da sind
  void loadLeagueMeta(() => { if (view === "plan") renderPlan(); if (view === "leagues") renderLeagues(); if (view === "live") { focusSig = ""; renderLive(); } });
  await listen<Snapshot>("settings", (e) => { snap = e.payload; onSettings(); });
  await listen<Upd>("update", (e) => { upd = e.payload; renderUpd(); });
  onLaya(renderLaya);
  await initLaya();
  upd = (await invoke<Upd | null>("update_state").catch(() => null)) ?? upd;
  renderUpd();
  await listen<SportState>("sport", (e) => {
    live = e.payload;
    rememberColors(live.matches);
    if (view === "live") renderLive();
    if (view === "plan" && plan) renderPlan();
    if (view === "leagues" && plan) renderLeaguePlan();
    if (view === "teams") void renderTeams(); // naechstes Spiel, Tabellenplatz (morph: nur Geaendertes)
  });
  await listen<{ key: string; reset: boolean; plays: SportPlay[] }>("sport-plays", (e) => {
    if (e.payload.key === court.matchKey && court.el.isConnected) {
      if (e.payload.reset) court.reset(e.payload.plays); else court.add(e.payload.plays);
      return;
    }
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
  // Nebel: alle gewaehlten Ligen (auch die automatischen) in ihrer Farbe
  const fog = new Fog();
  document.body.prepend(fog.el);
  const tint = () => fog.setColors(chosen().map(leagueColor));
  tint();
  setInterval(tint, 1500);
  setInterval(() => { if (view === "live") { focusSig = ""; renderLive(); } }, 30_000);
  // Notch: Lage beim Start, bei jedem Abgleich und alle paar Sekunden (Umdocken)
  void refreshNotch(snap.notch);
  setInterval(() => void refreshNotch(snap.notch), 4000);
}

main();
