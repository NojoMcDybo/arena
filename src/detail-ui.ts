/**
 * Spielanalyse in Arena (Daten: info.rs, ESPN summary) — alles berechnet, nichts geraten:
 * - Statistik: beide Teams gegenueber, der Balken teilt sich in den Teamfarben
 * - Druckphasen: Torschuesse und Ecken ueber die Spielzeit, geglaettet; Heim nach oben, Gast nach unten
 * - Aufstellung mit Formation, Ein- und Auswechslungen
 * - vor dem Spiel: Prognose aus den Quoten, Form der letzten fuenf, direkter Vergleich
 * - Spielort und Schiedsrichter
 */

import { crestEl, type SportMatch, type SportTeam } from "./sport-ui";

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
  const h = el("header", "c-head");
  h.append(el("span", "n-eyebrow", title));
  if (meta) h.append(el("span", "c-meta", meta));
  c.append(h);
  return c;
}

// ---------- Statistik ----------

export function statsCard(m: SportMatch, d: MatchDetail) {
  const live = m.state !== "pre";
  const c = card(live ? "Statistik" : "Saison", live ? "" : "bisher");
  const list = el("div", "stats");
  for (const s of d.stats) {
    const row = el("div", "stat");
    const sum = s.h + s.a;
    const hw = s.h > s.a, aw = s.a > s.h;
    row.append(el("b", hw ? "lead" : "", s.home), el("span", "st-label", s.label), el("b", aw ? "lead" : "", s.away));
    if (sum > 0) {
      const bar = el("i", "st-bar");
      bar.style.setProperty("--k", String(s.h / sum));
      row.append(bar);
    }
    list.append(row);
  }
  c.append(list);
  return c;
}

// ---------- Druckphasen ----------

/**
 * Jede Chance wirkt ein paar Minuten nach (Gauss-Kern, 4 Min), Heim nach oben, Gast nach unten.
 * Tore als Punkte, Halbzeit gestrichelt, bei laufenden Spielen ein Lichtstrich an der aktuellen Minute.
 */
export function pulseCard(m: SportMatch, d: MatchDetail) {
  const c = card("Druckphasen", "Schüsse · Ecken");
  const now = m.state === "in" ? Number(/^(\d+)/.exec(m.clock)?.[1] ?? 0) + Number(/\+(\d+)/.exec(m.clock)?.[1] ?? 0) : 0;
  const end = Math.max(90, now, ...d.pulse.map((p) => p.minute));
  const W = 360, H = 96, mid = H / 2;
  const x = (min: number) => (min / end) * W;
  const sigma = 4;
  const curve = (side: string) => {
    const pts: number[] = [];
    for (let t = 0; t <= end; t += 0.5) {
      let v = 0;
      for (const p of d.pulse) if (p.side === side) v += p.w * Math.exp(-(((t - p.minute) / sigma) ** 2) / 2);
      pts.push(v);
    }
    return pts;
  };
  const hc = curve("home"), ac = curve("away");
  const top = Math.max(4, ...hc, ...ac);
  const k = (mid - 6) / top;
  const path = (vals: number[], dir: 1 | -1) => {
    const limit = m.state === "in" ? now : end;
    let dPath = `M0 ${mid}`;
    vals.forEach((v, i) => { const t = i * 0.5; if (t <= limit) dPath += ` L${x(t).toFixed(1)} ${(mid - dir * v * k).toFixed(1)}`; });
    return `${dPath} L${x(Math.min(limit, end)).toFixed(1)} ${mid} Z`;
  };
  const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, class: "pulse", preserveAspectRatio: "none", role: "img" });
  svg.setAttribute("aria-label", `Druckphasen: ${d.pulse.filter((p) => p.side === "home").length} Aktionen ${m.home.name}, ${d.pulse.filter((p) => p.side === "away").length} ${m.away.name}`);
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
  for (const p of d.pulse.filter((p) => p.w >= 5)) {
    const g = el("i", `pu-goal ${p.side}`);
    g.style.left = `${(p.minute / end) * 100}%`;
    g.style.setProperty("--c", p.side === "home" ? m.home.color : m.away.color);
    g.title = `Tor ${p.side === "home" ? m.home.name : m.away.name} · ${p.minute}'`;
    graph.append(g);
  }
  wrap.append(side, graph);
  // Wer hatte mehr? Summe der Gewichte als Satz (fuer Screenreader und als Unterzeile)
  const sum = (s: string) => d.pulse.filter((p) => p.side === s).reduce((a, p) => a + p.w, 0);
  const sh = sum("home"), sa = sum("away");
  const lead = sh + sa === 0 ? "Noch keine Torchancen" : Math.abs(sh - sa) < (sh + sa) * 0.12 ? "Ausgeglichen" : `Mehr Druck: ${(sh > sa ? m.home : m.away).short || (sh > sa ? m.home : m.away).name}`;
  c.append(wrap, el("p", "c-foot", lead));
  return c;
}

// ---------- Aufstellung ----------

function lineupCol(team: SportTeam, l: Lineup) {
  const col = el("div", "lu-col");
  col.style.setProperty("--tc", team.color);
  const head = el("div", "lu-head");
  head.append(crestEl(team, "crest"), el("span", "lu-form", l.formation || "–"));
  const list = el("ol", "lu-list");
  const row = (p: Player) => {
    const li = el("li", (p.sub_out ? "out" : "") + (p.sub_in ? " in" : ""));
    li.append(el("span", "lu-no", p.jersey || "·"), el("span", "lu-name", p.name), el("span", "lu-pos", p.pos));
    li.title = [p.name, p.sub_in ? "eingewechselt" : "", p.sub_out ? "ausgewechselt" : ""].filter(Boolean).join(" · ");
    return li;
  };
  const starters = l.players.filter((p) => p.starter);
  list.append(...starters.map(row));
  col.append(head, list);
  const subs = l.players.filter((p) => !p.starter && p.sub_in);
  if (subs.length) {
    const s = el("ol", "lu-list subs");
    s.append(...subs.map(row));
    col.append(el("span", "lu-sub", "Eingewechselt"), s);
  }
  return col;
}

export function lineupCard(m: SportMatch, d: MatchDetail) {
  if (!d.lineup_home && !d.lineup_away) return null;
  const c = card("Aufstellung", m.state === "pre" ? "voraussichtlich" : "");
  const g = el("div", "lineups");
  if (d.lineup_home) g.append(lineupCol(m.home, d.lineup_home));
  if (d.lineup_away) g.append(lineupCol(m.away, d.lineup_away));
  c.append(g);
  return c;
}

// ---------- Vor dem Spiel ----------

export function oddsCard(m: SportMatch, d: MatchDetail) {
  if (d.odds.length !== 3) return null;
  const c = card("Prognose", d.odds_by ? `aus Quoten · ${d.odds_by}` : "aus Quoten");
  const [h, x, a] = d.odds;
  const bar = el("div", "odds");
  const seg = (v: number, cls: string, color?: string) => {
    const s = el("i", cls);
    s.style.flexGrow = String(Math.max(0.02, v));
    if (color) s.style.setProperty("--c", color);
    return s;
  };
  bar.append(seg(h, "o-h", m.home.color), ...(x > 0 ? [seg(x, "o-x")] : []), seg(a, "o-a", m.away.color));
  const labels = el("div", "odds-labels");
  const lab = (t: SportTeam | null, v: number, text: string) => {
    const s = el("span", "");
    if (t) s.append(crestEl(t, "crest"));
    s.append(el("b", "", `${Math.round(v * 100)} %`), el("small", "", text));
    return s;
  };
  labels.append(lab(m.home, h, "Sieg"), ...(x > 0 ? [lab(null, x, "Remis")] : []), lab(m.away, a, "Sieg"));
  c.append(bar, labels);
  return c;
}

function formRow(team: SportTeam, games: FormGame[]) {
  const r = el("div", "fr");
  r.append(crestEl(team, "crest"));
  const dots = el("div", "form");
  // aeltestes links
  for (const g of [...games].reverse()) {
    const i = el("i", `f-${g.r}`);
    i.title = `${g.score} ${g.home ? "gegen" : "bei"} ${g.opp} · ${new Date(g.date).toLocaleDateString("de-DE")}${g.comp ? ` · ${g.comp}` : ""}`;
    dots.append(i);
  }
  const pts = games.reduce((s, g) => s + (g.r === "s" ? 3 : g.r === "u" ? 1 : 0), 0);
  r.append(dots, el("span", "fr-pts", games.length ? `${pts} Pkt` : "–"));
  return r;
}

export function formCard(m: SportMatch, d: MatchDetail) {
  if (!d.form_home.length && !d.form_away.length) return null;
  const c = card("Form", "letzte fünf");
  c.append(formRow(m.home, d.form_home), formRow(m.away, d.form_away));
  return c;
}

export function h2hCard(d: MatchDetail) {
  if (!d.h2h.length) return null;
  const c = card("Direkter Vergleich");
  for (const g of d.h2h) {
    const r = el("div", "h2h");
    r.append(el("span", "h2h-d", new Date(g.date).toLocaleDateString("de-DE", { day: "numeric", month: "short", year: "2-digit" })));
    const mid = el("span", "h2h-m");
    mid.append(crestEl(g.home, "crest"), el("b", "", `${g.home.score || 0}:${g.away.score || 0}`), crestEl(g.away, "crest"));
    r.append(mid);
    c.append(r);
  }
  return c;
}

export function infoCard(d: MatchDetail) {
  const rows: [string, string][] = [];
  if (d.venue) rows.push(["Stadion", d.city ? `${d.venue}, ${d.city}` : d.venue]);
  if (d.referee) rows.push(["Schiedsrichter", d.referee]);
  if (d.attendance > 0) rows.push(["Zuschauer", d.attendance.toLocaleString("de-DE")]);
  if (!rows.length) return null;
  const c = card("Spielort");
  const dl = el("dl", "info");
  for (const [k, v] of rows) dl.append(el("dt", "", k), el("dd", "", v));
  c.append(dl);
  return c;
}

/** Alle Karten zum Spiel, aufgeteilt auf die beiden Spalten der Live-Ansicht */
export function detailCards(m: SportMatch, d: MatchDetail): { main: HTMLElement[]; side: HTMLElement[] } {
  const main: (HTMLElement | null)[] = [];
  const side: (HTMLElement | null)[] = [];
  if (m.state === "pre") {
    main.push(oddsCard(m, d), formCard(m, d), d.stats.length ? statsCard(m, d) : null);
    side.push(h2hCard(d), lineupCard(m, d), infoCard(d));
  } else {
    if (m.sport === "soccer" && d.pulse.length) main.push(pulseCard(m, d));
    if (d.stats.length) main.push(statsCard(m, d));
    side.push(lineupCard(m, d), infoCard(d));
  }
  return { main: main.filter((x): x is HTMLElement => !!x), side: side.filter((x): x is HTMLElement => !!x) };
}
