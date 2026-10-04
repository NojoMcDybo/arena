/**
 * Spielanalyse in Arena (Daten: info.rs, ESPN summary; Stadion: more.rs) — alles berechnet, nichts geraten.
 * Jede Karte steht immer da (vor dem Spiel, solange Daten laden, ohne Daten); fehlt ein Wert, bleibt er leer
 * ("–", leeres Netz, leere Achse) — so springt die Seite nicht, wenn die Zahlen kommen.
 *
 * - Statistik: beide Teams gegenueber, der Balken teilt sich in den Teamfarben
 * - Teamvergleich: Radar aus der Statistik (Heim und Gast uebereinander)
 * - Druckphasen: Torschuesse und Ecken ueber die Spielzeit, geglaettet; Heim nach oben, Gast nach unten
 * - Aufstellung mit Formation, Ein- und Auswechslungen
 * - vor dem Spiel: Prognose aus den Quoten, Form der letzten fuenf, direkter Vergleich
 * - Stadion von oben und von der Seite mit Platzzahl, Schiedsrichter, Zuschauer
 */

import type { CardId } from "./layout";
import { crestEl, type SportMatch, type SportTeam } from "./sport-ui";
import { radarEl, scale, type RadarSeries } from "./radar";
import { stadiumBody, type Venue } from "./stadium";

export type Stat = { label: string; home: string; away: string; h: number; a: number };
export type Pulse = { minute: number; side: string; w: number };
export type Player = { jersey: string; name: string; pos: string; starter: boolean; sub_in: boolean; sub_out: boolean; place: number };
export type Lineup = { formation: string; players: Player[] };
export type FormGame = { r: "s" | "u" | "n"; score: string; opp: string; home: boolean; date: number; comp: string };
export type H2h = { date: number; home: SportTeam; away: SportTeam };
export type MatchDetail = {
  stats: Stat[]; pulse: Pulse[]; lineup_home: Lineup | null; lineup_away: Lineup | null;
  venue: string; city: string; referee: string; attendance: number;
  odds: number[]; odds_by: string; form_home: FormGame[]; form_away: FormGame[]; h2h: H2h[];
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const SVGNS = "http://www.w3.org/2000/svg";
function sv<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  return e;
}

/** Karte mit Kopfzeile (Augenbraue links, Hinweis rechts) — der eine Kartenaufbau in ganz Arena */
export function card(title: string, meta = "", cls = "") {
  const c = el("section", `card n-card ${cls}`.trim());
  // Schluessel fuer morph(): dieselbe Karte bleibt dieselbe, nur ihr Inhalt aendert sich
  c.dataset.key = `card:${title}`;
  const h = el("header", "c-head");
  h.append(el("span", "n-eyebrow", title));
  if (meta) h.append(el("span", "c-meta", meta));
  c.append(h);
  return c;
}

const empty = (text: string) => el("p", "c-empty faint", text);

// ---------- Statistik ----------

/** leere Zeilen, solange es keine Zahlen gibt */
const PLACEHOLDER: Record<string, string[]> = {
  soccer: ["Ballbesitz", "Schüsse", "Aufs Tor", "Ecken", "Passquote", "Fouls"],
  basketball: ["Würfe", "Dreier", "Freiwürfe", "Rebounds", "Assists", "Ballverluste"],
};

export function statsCard(m: SportMatch, d: MatchDetail | null) {
  const live = m.state !== "pre";
  const c = card(live ? "Statistik" : "Saison", live ? "" : "bisher");
  const list = el("div", "stats");
  const rows = d?.stats.length ? d.stats : (PLACEHOLDER[m.sport] ?? PLACEHOLDER.soccer).map((label) => ({ label, home: "–", away: "–", h: 0, a: 0 }));
  for (const s of rows) {
    const row = el("div", "stat");
    row.dataset.key = s.label;
    const sum = s.h + s.a;
    row.append(el("b", s.h > s.a ? "lead" : "", s.home), el("span", "st-label", s.label), el("b", s.a > s.h ? "lead" : "", s.away));
    const bar = el("i", "st-bar" + (sum > 0 ? "" : " none"));
    bar.style.setProperty("--k", String(sum > 0 ? s.h / sum : 0.5));
    row.append(bar);
    list.append(row);
  }
  c.append(list);
  return c;
}

// ---------- Teamvergleich (Radar) ----------

/** Achsen mit Bezugsgroesse: Wert auf 0..1 (Fussball); andere Sportarten: im Verhaeltnis der beiden Teams */
const SOCCER_AXES: [string, string, (v: number) => number][] = [
  ["Ballbesitz", "Ballbesitz", (v) => scale(v, 20, 80)],
  ["Schüsse", "Schüsse", (v) => scale(v, 0, 25)],
  ["Aufs Tor", "Aufs Tor", (v) => scale(v, 0, 12)],
  ["Passquote", "Passquote", (v) => scale(v, 55, 95)],
  ["Zweikampfquote", "Zweikämpfe", (v) => scale(v, 25, 75)],
  ["Ecken", "Ecken", (v) => scale(v, 0, 12)],
];

export function teamRadarCard(m: SportMatch, d: MatchDetail | null) {
  const c = card("Teamvergleich", m.sport === "soccer" ? "Bezug: Spitzenwerte eines Spiels" : "im Verhältnis zueinander");
  const stats = d?.stats ?? [];
  let axes: string[];
  let hv: (number | null)[], av: (number | null)[], hr: string[], ar: string[];
  if (m.sport === "soccer") {
    axes = SOCCER_AXES.map((x) => x[1]);
    const get = (label: string) => stats.find((s) => s.label === label);
    hv = SOCCER_AXES.map(([l, , f]) => { const s = get(l); return s ? f(s.h) : null; });
    av = SOCCER_AXES.map(([l, , f]) => { const s = get(l); return s ? f(s.a) : null; });
    hr = SOCCER_AXES.map(([l]) => get(l)?.home ?? "–");
    ar = SOCCER_AXES.map(([l]) => get(l)?.away ?? "–");
  } else {
    const pick = stats.filter((s) => s.h + s.a > 0).slice(0, 6);
    axes = pick.length >= 3 ? pick.map((s) => s.label) : PLACEHOLDER[m.sport] ?? PLACEHOLDER.soccer;
    hv = pick.length >= 3 ? pick.map((s) => (s.h / Math.max(s.h, s.a)) * 0.9) : axes.map(() => null);
    av = pick.length >= 3 ? pick.map((s) => (s.a / Math.max(s.h, s.a)) * 0.9) : axes.map(() => null);
    hr = pick.map((s) => s.home);
    ar = pick.map((s) => s.away);
  }
  const series: RadarSeries[] = [
    { label: m.home.short || m.home.name, color: m.home.color, values: hv, raw: hr },
    { label: m.away.short || m.away.name, color: m.away.color, values: av, raw: ar },
  ];
  c.append(radarEl(axes, series, "team-radar"));
  if (hv.every((v) => v == null)) c.append(el("p", "c-foot", m.state === "pre" ? "Füllt sich mit dem Anpfiff" : "Noch keine Werte"));
  return c;
}

// ---------- Druckphasen ----------

/**
 * Jede Chance wirkt ein paar Minuten nach (Gauss-Kern, 4 Min), Heim nach oben, Gast nach unten.
 * Tore als Punkte, Halbzeit gestrichelt, bei laufenden Spielen ein Lichtstrich an der aktuellen Minute.
 */
export function pulseCard(m: SportMatch, d: MatchDetail | null) {
  const c = card("Druckphasen", "Schüsse · Ecken");
  const pulse = d?.pulse ?? [];
  const now = m.state === "in" ? Number(/^(\d+)/.exec(m.clock)?.[1] ?? 0) + Number(/\+(\d+)/.exec(m.clock)?.[1] ?? 0) : 0;
  const end = Math.max(90, now, ...pulse.map((p) => p.minute));
  const W = 360, H = 96, mid = H / 2;
  const x = (min: number) => (min / end) * W;
  const sigma = 4;
  const curve = (side: string) => {
    const pts: number[] = [];
    for (let t = 0; t <= end; t += 0.5) {
      let v = 0;
      for (const p of pulse) if (p.side === side) v += p.w * Math.exp(-(((t - p.minute) / sigma) ** 2) / 2);
      pts.push(v);
    }
    return pts;
  };
  const hc = curve("home"), ac = curve("away");
  const top = Math.max(4, ...hc, ...ac);
  const k = (mid - 6) / top;
  const path = (vals: number[], dir: 1 | -1) => {
    const limit = m.state === "in" ? now : m.state === "pre" ? 0 : end;
    let dPath = `M0 ${mid}`;
    vals.forEach((v, i) => { const t = i * 0.5; if (t <= limit) dPath += ` L${x(t).toFixed(1)} ${(mid - dir * v * k).toFixed(1)}`; });
    return `${dPath} L${x(Math.min(limit, end)).toFixed(1)} ${mid} Z`;
  };
  const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, class: "pulse", preserveAspectRatio: "none", role: "img" });
  svg.setAttribute("aria-label", `Druckphasen: ${pulse.filter((p) => p.side === "home").length} Aktionen ${m.home.name}, ${pulse.filter((p) => p.side === "away").length} ${m.away.name}`);
  svg.append(
    sv("line", { x1: x(45), y1: 4, x2: x(45), y2: H - 4, class: "pu-half" }),
    sv("path", { d: path(hc, 1), class: "pu-area", fill: m.home.color }),
    sv("path", { d: path(ac, -1), class: "pu-area", fill: m.away.color }),
    sv("line", { x1: 0, y1: mid, x2: W, y2: mid, class: "pu-axis" }),
  );
  if (m.state === "in") svg.append(sv("line", { x1: x(now), y1: 2, x2: x(now), y2: H - 2, class: "pu-now" }));
  const wrap = el("div", "pulse-wrap");
  const side = el("div", "pu-crests");
  side.append(crestEl(m.home, "crest"), crestEl(m.away, "crest"));
  const axis = el("div", "pu-ticks");
  for (const t of [0, 15, 30, 45, 60, 75, 90]) {
    const s = el("span", "", `${t}'`);
    s.style.left = `${(t / end) * 100}%`;
    axis.append(s);
  }
  const graph = el("div", "pu-graph");
  graph.append(svg, axis);
  // Tore als Lichtpunkte am Rand (HTML, damit sie im gestreckten SVG rund bleiben)
  for (const p of pulse.filter((p) => p.w >= 5)) {
    const g = el("i", `pu-goal ${p.side}`);
    g.style.left = `${(p.minute / end) * 100}%`;
    g.style.setProperty("--c", p.side === "home" ? m.home.color : m.away.color);
    g.title = `Tor ${p.side === "home" ? m.home.name : m.away.name} · ${p.minute}'`;
    graph.append(g);
  }
  wrap.append(side, graph);
  const sum = (s: string) => pulse.filter((p) => p.side === s).reduce((a, p) => a + p.w, 0);
  const sh = sum("home"), sa = sum("away");
  const lead = m.state === "pre" ? "Ab Anpfiff" : sh + sa === 0 ? "Noch keine Torchancen" : Math.abs(sh - sa) < (sh + sa) * 0.12 ? "Ausgeglichen" : `Mehr Druck: ${(sh > sa ? m.home : m.away).short || (sh > sa ? m.home : m.away).name}`;
  c.append(wrap, el("p", "c-foot", lead));
  return c;
}

// ---------- Aufstellung ----------

function lineupCol(team: SportTeam, l: Lineup | null) {
  const col = el("div", "lu-col");
  col.dataset.key = team.id;
  col.style.setProperty("--tc", team.color);
  const head = el("div", "lu-head");
  head.append(crestEl(team, "crest"), el("span", "lu-form", l?.formation || "–"));
  const list = el("ol", "lu-list");
  const row = (p: Player) => {
    const li = el("li", (p.sub_out ? "out" : "") + (p.sub_in ? " in" : ""));
    li.dataset.key = `${p.jersey}:${p.name}`;
    li.append(el("span", "lu-no", p.jersey || "·"), el("span", "lu-name", p.name), el("span", "lu-pos", p.pos));
    li.title = [p.name, p.sub_in ? "eingewechselt" : "", p.sub_out ? "ausgewechselt" : ""].filter(Boolean).join(" · ");
    return li;
  };
  if (l) list.append(...l.players.filter((p) => p.starter).map(row));
  else for (let i = 0; i < 11; i++) { const li = el("li", "ghost"); li.append(el("span", "lu-no", "·"), el("span", "lu-name", ""), el("span", "lu-pos", "")); list.append(li); }
  col.append(head, list);
  const subs = l?.players.filter((p) => !p.starter && p.sub_in) ?? [];
  if (subs.length) {
    const s = el("ol", "lu-list subs");
    s.append(...subs.map(row));
    col.append(el("span", "lu-sub", "Eingewechselt"), s);
  }
  return col;
}

export function lineupCard(m: SportMatch, d: MatchDetail | null) {
  const has = !!(d?.lineup_home || d?.lineup_away);
  const c = card("Aufstellung", !has ? "noch nicht bekannt" : m.state === "pre" ? "voraussichtlich" : "");
  const g = el("div", "lineups");
  g.append(lineupCol(m.home, d?.lineup_home ?? null), lineupCol(m.away, d?.lineup_away ?? null));
  c.append(g);
  return c;
}

// ---------- Vor dem Spiel ----------

export function oddsCard(m: SportMatch, d: MatchDetail | null) {
  const ok = d?.odds.length === 3;
  const c = card("Prognose", ok ? (d!.odds_by ? `aus Quoten · ${d!.odds_by}` : "aus Quoten") : "keine Quoten");
  const [h, x, a] = ok ? d!.odds : [0, 0, 0];
  const bar = el("div", "odds" + (ok ? "" : " none"));
  const seg = (v: number, cls: string, color?: string) => {
    const s = el("i", cls);
    s.style.flexGrow = String(ok ? Math.max(0.02, v) : 1);
    if (color) s.style.setProperty("--c", color);
    return s;
  };
  bar.append(seg(h, "o-h", m.home.color), ...(x > 0 || !ok ? [seg(x, "o-x")] : []), seg(a, "o-a", m.away.color));
  const labels = el("div", "odds-labels");
  const lab = (t: SportTeam | null, v: number, text: string) => {
    const s = el("span", "");
    if (t) s.append(crestEl(t, "crest"));
    s.append(el("b", "", ok ? `${Math.round(v * 100)} %` : "–"), el("small", "", text));
    return s;
  };
  labels.append(lab(m.home, h, "Sieg"), ...(x > 0 || !ok ? [lab(null, x, "Remis")] : []), lab(m.away, a, "Sieg"));
  c.append(bar, labels);
  return c;
}

function formRow(team: SportTeam, games: FormGame[]) {
  const r = el("div", "fr");
  r.dataset.key = team.id;
  r.append(crestEl(team, "crest"));
  const dots = el("div", "form");
  // aeltestes links; ohne Daten fuenf leere Punkte
  if (!games.length) for (let i = 0; i < 5; i++) dots.append(el("i", "f-none"));
  for (const g of [...games].reverse()) {
    const i = el("i", `f-${g.r}`);
    i.title = `${g.score} ${g.home ? "gegen" : "bei"} ${g.opp} · ${new Date(g.date).toLocaleDateString("de-DE")}${g.comp ? ` · ${g.comp}` : ""}`;
    dots.append(i);
  }
  const pts = games.reduce((s, g) => s + (g.r === "s" ? 3 : g.r === "u" ? 1 : 0), 0);
  r.append(dots, el("span", "fr-pts", games.length ? `${pts} Pkt` : "–"));
  return r;
}

export function formCard(m: SportMatch, d: MatchDetail | null) {
  const c = card("Form", "letzte fünf");
  c.append(formRow(m.home, d?.form_home ?? []), formRow(m.away, d?.form_away ?? []));
  return c;
}

export function h2hCard(d: MatchDetail | null) {
  const c = card("Direkter Vergleich");
  if (!d?.h2h.length) { c.append(empty("Keine früheren Duelle bekannt")); return c; }
  for (const g of d.h2h) {
    const r = el("div", "h2h");
    r.dataset.key = String(g.date);
    r.append(el("span", "h2h-d", new Date(g.date).toLocaleDateString("de-DE", { day: "numeric", month: "short", year: "2-digit" })));
    const mid = el("span", "h2h-m");
    mid.append(crestEl(g.home, "crest"), el("b", "", `${g.home.score || 0}:${g.away.score || 0}`), crestEl(g.away, "crest"));
    r.append(mid);
    c.append(r);
  }
  return c;
}

// ---------- Stadion ----------

export function stadiumCard(m: SportMatch, d: MatchDetail | null, venue: Venue | null, loading: boolean) {
  const c = card("Stadion", venue?.outline.length ? "von oben: OpenStreetMap · Plätze: Wikidata" : venue?.capacity ? "Plätze: Wikidata" : "");
  c.append(stadiumBody(venue, m.sport, d?.venue ?? "", d?.city ?? "", loading));
  const rows: [string, string][] = [["Schiedsrichter", d?.referee || "–"], ["Zuschauer", d && d.attendance > 0 ? d.attendance.toLocaleString("de-DE") : "–"]];
  const dl = el("dl", "info");
  for (const [k, v] of rows) dl.append(el("dt", "", k), el("dd", "", v));
  c.append(dl);
  return c;
}

/** Alle Karten zum Spiel, aufgeteilt auf die beiden Spalten der Live-Ansicht — immer vollstaendig */
/** alle Analyse-Karten mit festem Schluessel (layout.ts ordnet sie an; was eine Phase nicht braucht, ist dort
 * ausgeblendet und laesst sich zurueckholen) */
export function detailCards(m: SportMatch, d: MatchDetail | null, venue: Venue | null, venueLoading: boolean): Map<CardId, HTMLElement> {
  const out = new Map<CardId, HTMLElement>([
    ["odds", oddsCard(m, d)],
    ["form", formCard(m, d)],
    ["h2h", h2hCard(d)],
    ["stats", statsCard(m, d)],
    ["radar", teamRadarCard(m, d)],
    ["lineup", lineupCard(m, d)],
    ["stadium", stadiumCard(m, d, venue, venueLoading)],
  ]);
  if (m.sport === "soccer") out.set("pulse", pulseCard(m, d));
  return out;
}
