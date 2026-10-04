/**
 * Aufstellung auf dem Spielfeld: jede Mannschaft in ihrer Formation (ESPN: "4-2-3-1" und je Spieler die Position,
 * z. B. "CD-L", "AM-R"). Aus der Formation kommen die Reihen, aus der Position Tiefe (Abwehr … Sturm) und Seite
 * (links … rechts) — so stehen die Spieler da, wo sie spielen, ohne Tabellen je Formation.
 *
 * - match(): beide Teams — Heim in der linken Haelfte (spielt nach rechts), Gast rechts
 * - team(): ein Team ueber das ganze Feld (fuer „Letzte Aufstellungen“)
 * Spieler sind feste Elemente je Spieler-ID: beim Wechsel der Aufstellung laufen sie an ihren neuen Platz,
 * neue blenden ein (mit Ring: neu in der Startelf), wer fehlt, blendet aus.
 */

import type { Lineup, Player } from "./detail-ui";
import type { SportTeam } from "./sport-ui";

const W = 105, H = 68;

const SVGNS = "http://www.w3.org/2000/svg";
function sv<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  return e;
}
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** Tiefe 0 (Tor) … 4,5 (Sturm) aus der ESPN-Position */
function depth(pos: string) {
  const b = pos.toUpperCase().replace(/-[LR]$/, "");
  if (b === "G" || b === "GK") return 0;
  if (["CD", "CB", "SW", "D", "LB", "RB", "LCB", "RCB"].includes(b)) return 1;
  if (["LWB", "RWB", "WB"].includes(b)) return 1.5;
  if (["DM", "CDM", "LDM", "RDM"].includes(b)) return 2;
  if (["CM", "LM", "RM", "M", "LCM", "RCM"].includes(b)) return 2.5;
  if (["AM", "CAM", "LW", "RW", "W", "LAM", "RAM"].includes(b)) return 3.5;
  if (["F", "CF", "ST", "SS", "FW", "LF", "RF"].includes(b)) return 4.5;
  return 2.5;
}

/** Seite: -2 aussen links (LB, LM, LW …), -1 halblinks (CD-L, AM-L …), 0 Mitte, 1/2 rechts (aus Sicht des Teams) */
function side(pos: string) {
  const p = pos.toUpperCase();
  if (/^L(B|WB|M|W|F)$/.test(p)) return -2;
  if (/^R(B|WB|M|W|F)$/.test(p)) return 2;
  if (/-L$/.test(p) || /^L(CB|CM|DM|AM)$/.test(p)) return -1;
  if (/-R$/.test(p) || /^R(CB|CM|DM|AM)$/.test(p)) return 1;
  return 0;
}

export type Spot = { p: Player; x: number; y: number };

/**
 * Plaetze einer Startelf, Team spielt nach rechts; x von x0 (Torwart) bis x1 (Sturm), y 0..68 (links = oben).
 */
export function spots(l: Lineup, x0: number, x1: number): Spot[] {
  const xi = l.players.filter((p) => p.starter).slice(0, 11);
  const gk = xi.find((p) => depth(p.pos) === 0) ?? xi.find((p) => p.place === 1);
  const field = xi.filter((p) => p !== gk).sort((a, b) => depth(a.pos) - depth(b.pos) || a.place - b.place);
  let lines = l.formation.split("-").map((n) => parseInt(n, 10)).filter((n) => n > 0);
  if (lines.reduce((a, b) => a + b, 0) !== field.length) {
    // Formation fehlt oder passt nicht: Reihen nach Tiefe
    const groups = new Map<number, number>();
    for (const p of field) groups.set(Math.round(depth(p.pos)), (groups.get(Math.round(depth(p.pos))) ?? 0) + 1);
    lines = [...groups.entries()].sort((a, b) => a[0] - b[0]).map((g) => g[1]);
  }
  const out: Spot[] = [];
  if (gk) out.push({ p: gk, x: x0, y: H / 2 });
  let i = 0;
  lines.forEach((n, li) => {
    const row = field.slice(i, i + n).sort((a, b) => side(a.pos) - side(b.pos) || a.place - b.place);
    i += n;
    const x = x0 + ((x1 - x0) * (li + 1)) / lines.length;
    // aussen nicht ganz bis an die Linie; wenige Spieler enger zusammen
    const spread = Math.min(H - 14, 10 + n * 11);
    row.forEach((p, k) => out.push({ p, x, y: H / 2 + (n === 1 ? 0 : (k / (n - 1) - 0.5) * spread) }));
  });
  return out;
}

/** Schrift auf der Teamfarbe: dunkel auf hellen Farben (Gelb, Weiss), sonst weiss */
function ink(hex: string) {
  const h = hex.replace("#", "");
  if (h.length < 6) return "#fff";
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.6 ? "#111" : "#fff";
}

const shortName = (n: string) => {
  const parts = n.trim().split(/\s+/);
  return parts.length > 1 ? parts.slice(1).join(" ") : n;
};

export class FormationPitch {
  readonly el: HTMLElement;
  private layer: HTMLElement;
  private nodes = new Map<string, HTMLElement>();
  private onPick: ((p: Player, team: SportTeam) => void) | null = null;

  constructor(cls = "") {
    this.el = el("div", `fpitch ${cls}`.trim());
    this.el.dataset.keep = "";
    const svg = sv("svg", { viewBox: `-3 -3 ${W + 6} ${H + 6}`, class: "pitch-svg fp-svg", "aria-hidden": "true" });
    const g = sv("g", { class: "pl" });
    g.append(
      sv("rect", { x: 0, y: 0, width: W, height: H, rx: 0.6 }),
      sv("line", { x1: W / 2, y1: 0, x2: W / 2, y2: H }),
      sv("circle", { cx: W / 2, cy: H / 2, r: 9.15 }),
      sv("rect", { x: 0, y: H / 2 - 20.16, width: 16.5, height: 40.32 }),
      sv("rect", { x: W - 16.5, y: H / 2 - 20.16, width: 16.5, height: 40.32 }),
      sv("rect", { x: 0, y: H / 2 - 9.16, width: 5.5, height: 18.32 }),
      sv("rect", { x: W - 5.5, y: H / 2 - 9.16, width: 5.5, height: 18.32 }),
    );
    svg.append(g);
    this.layer = el("div", "fp-layer");
    this.el.append(svg, this.layer);
  }

  /** Klick auf einen Spieler (Spielerprofil) */
  pick(fn: (p: Player, team: SportTeam) => void) {
    this.onPick = fn;
  }

  /** beide Teams: Heim links (nach rechts), Gast rechts (gespiegelt) */
  match(home: SportTeam, hl: Lineup | null, away: SportTeam, al: Lineup | null) {
    const all: { s: Spot; t: SportTeam; side: "h" | "a" }[] = [];
    if (hl) for (const s of spots(hl, 4, 47)) all.push({ s, t: home, side: "h" });
    if (al) for (const s of spots(al, 4, 47)) all.push({ s: { ...s, x: W - s.x, y: H - s.y }, t: away, side: "a" });
    this.place(all, false);
  }

  /** ein Team ueber das ganze Feld; fresh = Spieler, die neu in der Startelf sind (Ring) */
  team(t: SportTeam, l: Lineup | null, fresh: Set<string> = new Set()) {
    const all = l ? spots(l, 6, 92).map((s) => ({ s, t, side: "h" as const })) : [];
    this.place(all, true, fresh);
  }

  private place(all: { s: Spot; t: SportTeam; side: "h" | "a" }[], names: boolean, fresh: Set<string> = new Set()) {
    const keep = new Set<string>();
    for (const { s, t, side } of all) {
      const id = `${side}:${s.p.id || s.p.jersey + s.p.name}`;
      keep.add(id);
      let n = this.nodes.get(id);
      if (!n) {
        n = el("button", `fp-man ${side}`);
        n.append(el("b", "", s.p.jersey || "·"), el("span", "fp-name", shortName(s.p.name)));
        n.style.left = `${(s.x / W) * 100}%`;
        n.style.top = `${(s.y / H) * 100}%`;
        n.classList.add("enter");
        this.layer.append(n);
        this.nodes.set(id, n);
        // Startzustand festschreiben, dann einblenden (Reflow statt requestAnimationFrame: laeuft auch verdeckt)
        void n.getBoundingClientRect();
        n.classList.remove("enter");
      }
      n.classList.remove("leave");
      n.classList.toggle("fresh", fresh.has(s.p.id));
      n.classList.toggle("named", names);
      n.style.setProperty("--tc", t.color);
      n.style.setProperty("--ti", ink(t.color));
      n.style.left = `${(s.x / W) * 100}%`;
      n.style.top = `${(s.y / H) * 100}%`;
      n.title = `${s.p.name}${s.p.pos ? ` · ${s.p.pos}` : ""}${s.p.jersey ? ` · Nr. ${s.p.jersey}` : ""}`;
      n.setAttribute("aria-label", n.title);
      const p = s.p;
      n.onclick = () => this.onPick?.(p, t);
    }
    for (const [id, n] of this.nodes) {
      if (keep.has(id)) continue;
      n.classList.add("leave");
      this.nodes.delete(id);
      setTimeout(() => n.remove(), 450);
    }
    this.el.classList.toggle("empty", !all.length);
  }
}
