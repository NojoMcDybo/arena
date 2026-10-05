/**
 * Spielverlauf zum Nachscrollen (Fussball): alle Ballaktionen des Spiels (more.rs match_plays) auf dem Feld,
 * mit einer Leiste darunter. Zu jedem Zeitpunkt stehen da:
 * - alle Abschluesse bis dahin, in der Teamfarbe des Schuetzen: Tor = Stern mit Linie ins Tor, aufs Tor =
 *   gefuellter Punkt, vorbei = Ring, geblockt = Raute (Legende darunter)
 * - der Weg des Balls in den letzten Aktionen, die beteiligten Spieler mit Rueckennummer, der Ball
 * Ueber der Leiste: Tore und Halbzeit als Marken. Abspielen laesst den Verlauf im Zeitraffer laufen; bei
 * laufenden Spielen springt „Live“ ans Ende und bleibt dort.
 */

import { icon } from "./nojo/nojo-icons";
import { crestEl, isGoal, isShot, playName, type SportMatch, type SportPlay, type SportTeam } from "./sport-ui";

const W = 105, H = 68;
const px = (x: number) => Math.max(-1.5, Math.min(W + 1.5, (x / 100) * W));
const py = (y: number) => Math.max(-1.5, Math.min(H + 1.5, (y / 100) * H));

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

const lum = (c: string) => {
  const h = c.replace("#", "");
  if (h.length < 6) return 0;
  return 0.2126 * parseInt(h.slice(0, 2), 16) + 0.7152 * parseInt(h.slice(2, 4), 16) + 0.0722 * parseInt(h.slice(4, 6), 16);
};

type ShotKind = "goal" | "on" | "off" | "blocked";
const shotKind = (k: string): ShotKind => (isGoal(k) ? "goal" : k === "shot-on-target" || k === "penalty---saved" ? "on" : k === "shot-blocked" ? "blocked" : "off");

/** Spielminute aus "45'+2'" / "67'" -> Zahl fuer die Leiste */
const minuteOf = (m: string) => {
  const x = /(\d+)'?(?:\+(\d+))?/.exec(m);
  return x ? Number(x[1]) + (x[2] ? Number(x[2]) / 10 : 0) : 0;
};

export class MatchReplay {
  readonly el: HTMLElement;
  private svg: SVGSVGElement;
  private shotG: SVGGElement;
  private trailG: SVGGElement;
  private actorG: SVGGElement;
  private ball: SVGGElement;
  private label: HTMLElement;
  private range: HTMLInputElement;
  private marks: HTMLElement;
  private playBtn: HTMLButtonElement;
  private liveBtn: HTMLButtonElement;
  private legend: HTMLElement;
  private plays: SportPlay[] = [];
  private i = -1;
  private key = "";
  private teams: { home: SportTeam; away: SportTeam } | null = null;
  private follow = true;
  private live = false;
  private timer = 0;

  constructor() {
    this.el = el("div", "replay");
    this.el.dataset.key = "replay";
    this.el.dataset.keep = "";
    this.svg = sv("svg", { viewBox: `-3 -3 ${W + 6} ${H + 6}`, class: "pitch-svg rp-svg", "aria-hidden": "true" });
    const g = sv("g", { class: "pl" });
    g.append(
      sv("rect", { x: 0, y: 0, width: W, height: H, rx: 1 }),
      sv("line", { x1: W / 2, y1: 0, x2: W / 2, y2: H }),
      sv("circle", { cx: W / 2, cy: H / 2, r: 9.15 }),
      sv("rect", { x: 0, y: 13.85, width: 16.5, height: 40.3 }),
      sv("rect", { x: W - 16.5, y: 13.85, width: 16.5, height: 40.3 }),
      sv("rect", { x: 0, y: 24.85, width: 5.5, height: 18.3 }),
      sv("rect", { x: W - 5.5, y: 24.85, width: 5.5, height: 18.3 }),
    );
    this.trailG = sv("g", { class: "trail" });
    this.shotG = sv("g", { class: "rp-shots" });
    this.actorG = sv("g", { class: "rp-actors" });
    this.ball = sv("g", { class: "ball" });
    this.ball.append(sv("circle", { r: 1.25 }));
    this.svg.append(g, sv("rect", { x: -2, y: 30.34, width: 2, height: 7.32, class: "net" }), sv("rect", { x: W, y: 30.34, width: 2, height: 7.32, class: "net" }),
      this.trailG, this.shotG, this.actorG, this.ball);
    this.label = el("div", "pitch-label rp-label n-liquid", "Spielverlauf wird geladen …");
    const field = el("div", "rp-field");
    field.append(this.svg, this.label);

    // Leiste: Abspielen · Marken + Regler · Live
    this.playBtn = el("button", "rp-btn");
    this.playBtn.title = "Abspielen (Zeitraffer)";
    this.playBtn.innerHTML = icon("play");
    this.playBtn.onclick = () => this.toggle();
    this.range = el("input", "rp-range");
    this.range.type = "range";
    this.range.min = "0";
    this.range.max = "0";
    this.range.setAttribute("aria-label", "Spielverlauf");
    this.range.oninput = () => { this.stop(); this.follow = false; this.seek(Number(this.range.value)); };
    this.marks = el("div", "rp-marks");
    const track = el("div", "rp-track");
    track.append(this.marks, this.range);
    this.liveBtn = el("button", "rp-btn rp-live", "Live");
    this.liveBtn.title = "Zum aktuellen Stand";
    this.liveBtn.onclick = () => { this.stop(); this.follow = true; this.seek(this.plays.length - 1); };
    const bar = el("div", "rp-bar");
    bar.append(this.playBtn, track, this.liveBtn);
    this.legend = el("div", "rp-legend");
    this.el.append(field, bar, this.legend);
    this.el.tabIndex = 0;
    this.el.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        e.stopPropagation();
        this.stop();
        this.follow = false;
        this.seek(this.i + (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 20 : 1));
      }
    });
  }

  get matchKey() {
    return this.key;
  }

  setMatch(m: SportMatch) {
    this.teams = { home: m.home, away: m.away };
    this.el.style.setProperty("--hc", m.home.color);
    this.el.style.setProperty("--ac", m.away.color);
    this.live = m.state === "in";
    this.liveBtn.hidden = !this.live;
    if (m.key !== this.key) {
      this.key = m.key;
      this.plays = [];
      this.i = -1;
      this.follow = true;
      this.stop();
      this.draw();
      this.label.textContent = "Spielverlauf wird geladen …";
    }
    this.renderLegend();
  }

  /** alle Aktionen (neu geladen); am Ende bleiben, wenn man dort war */
  setPlays(plays: SportPlay[]) {
    const atEnd = this.follow || this.i >= this.plays.length - 1;
    this.plays = plays;
    this.range.max = String(Math.max(0, plays.length - 1));
    this.renderMarks();
    if (!plays.length) { this.label.textContent = "Kein Spielverlauf verfügbar"; return; }
    this.seek(atEnd || this.i < 0 ? plays.length - 1 : Math.min(this.i, plays.length - 1));
  }

  private toggle() {
    if (this.timer) return this.stop();
    if (this.i >= this.plays.length - 1) this.seek(0);
    this.follow = false;
    this.playBtn.innerHTML = icon("pause");
    this.playBtn.title = "Anhalten";
    this.timer = window.setInterval(() => {
      if (this.i >= this.plays.length - 1) { this.stop(); this.follow = this.live; return; }
      this.seek(this.i + 1);
    }, 140);
  }

  private stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = 0;
    this.playBtn.innerHTML = icon("play");
    this.playBtn.title = "Abspielen (Zeitraffer)";
  }

  private seek(i: number) {
    if (!this.plays.length) return;
    this.i = Math.max(0, Math.min(this.plays.length - 1, i));
    this.range.value = String(this.i);
    this.draw();
  }

  private color(side: string) {
    return side === "away" ? this.teams?.away.color ?? "#ff6b6b" : this.teams?.home.color ?? "#4da3ff";
  }

  /** Zustand bis Aktion i zeichnen */
  private draw() {
    const upto = this.i < 0 ? [] : this.plays.slice(0, this.i + 1);
    // Abschluesse
    const shots: SVGElement[] = [];
    for (const p of upto) {
      if (!isShot(p.kind) || p.x < 0) continue;
      const k = shotKind(p.kind);
      const c = this.color(p.side);
      const x = px(p.x), y = py(p.y);
      const g = sv("g", { class: `rp-shot ${k}`, transform: `translate(${x.toFixed(2)} ${y.toFixed(2)})` });
      const t = sv("title");
      t.textContent = `${p.minute} ${p.who || ""} · ${playName(p.kind)}`;
      g.append(t);
      if (k === "goal") {
        const gx = p.side === "away" ? 0 : W;
        shots.push(sv("line", { x1: x, y1: y, x2: gx, y2: H / 2, stroke: c, class: "rp-goal-line" }));
        g.append(sv("path", { d: "M0 -2.1 L0.62 -0.65 L2.1 -0.65 L0.9 0.3 L1.3 1.85 L0 0.95 L-1.3 1.85 L-0.9 0.3 L-2.1 -0.65 L-0.62 -0.65 Z", fill: c, stroke: "#fff", "stroke-width": 0.35 }));
      } else if (k === "on") g.append(sv("circle", { r: 1.05, fill: c, stroke: "rgba(0,0,0,.55)", "stroke-width": 0.25 }));
      else if (k === "blocked") g.append(sv("rect", { x: -0.8, y: -0.8, width: 1.6, height: 1.6, fill: "none", stroke: c, "stroke-width": 0.45, transform: "rotate(45)" }));
      else g.append(sv("circle", { r: 1, fill: "none", stroke: c, "stroke-width": 0.45 }));
      shots.push(g);
    }
    this.shotG.replaceChildren(...shots);
    // Weg des Balls: die letzten acht Aktionen mit Ort
    const pos = upto.filter((p) => p.x >= 0).slice(-8);
    const segs: SVGElement[] = [];
    for (let j = 1; j < pos.length; j++) {
      const a = pos[j - 1], b = pos[j];
      segs.push(sv("line", { x1: px(a.x2 ?? a.x).toFixed(2), y1: py(a.y2 ?? a.y).toFixed(2), x2: px(b.x).toFixed(2), y2: py(b.y).toFixed(2), opacity: ((j / pos.length) * 0.6).toFixed(2) }));
    }
    this.trailG.replaceChildren(...segs);
    // Spieler der letzten Aktionen (je Rueckennummer die letzte Stelle)
    const seen = new Map<string, SportPlay>();
    for (const p of upto.slice(-14)) if (p.jersey && p.side && p.x >= 0) seen.set(`${p.side}-${p.jersey}`, p);
    const actors: SVGElement[] = [];
    for (const p of seen.values()) {
      const c = this.color(p.side);
      const g = sv("g", { class: "rp-actor", transform: `translate(${px(p.x).toFixed(2)} ${py(p.y).toFixed(2)})` });
      g.append(sv("circle", { r: 2.5, fill: c }));
      const t = sv("text", { y: 0.9, "text-anchor": "middle", fill: lum(c) > 150 ? "#000" : "#fff" });
      t.textContent = p.jersey;
      g.append(t);
      actors.push(g);
    }
    this.actorG.replaceChildren(...actors);
    const last = upto[upto.length - 1];
    if (last && last.x >= 0) {
      const bx = px(last.x2 ?? last.x), by = py(last.y2 ?? last.y);
      this.ball.setAttribute("transform", `translate(${bx.toFixed(2)} ${by.toFixed(2)})`);
      this.ball.style.opacity = "1";
    } else this.ball.style.opacity = "0";
    if (last) this.say(last);
    this.liveBtn.classList.toggle("on", this.live && this.i >= this.plays.length - 1);
  }

  private say(p: SportPlay) {
    const team = p.side === "home" ? this.teams?.home : p.side === "away" ? this.teams?.away : undefined;
    const who = [p.jersey ? `#${p.jersey}` : "", p.who].filter(Boolean).join(" ");
    this.label.replaceChildren(
      el("span", "pl-min", p.minute),
      team ? crestEl(team, "crest pl-crest") : el("i", `pl-dot ${p.side}`),
      el("span", "pl-who", who),
      el("span", "pl-what", playName(p.kind)),
    );
  }

  /** Tore und Halbzeit ueber der Leiste (Position nach Aktion, nicht nach Minute: so passen sie zum Regler) */
  private renderMarks() {
    const n = Math.max(1, this.plays.length - 1);
    const out: HTMLElement[] = [];
    let half = false;
    this.plays.forEach((p, i) => {
      const at = `${(i / n) * 100}%`;
      if (isGoal(p.kind)) {
        const m = el("button", `rp-mark goal ${p.side}`);
        m.style.left = at;
        m.style.setProperty("--c", this.color(p.side));
        m.title = `${p.minute} Tor ${p.who}`;
        m.onclick = () => { this.stop(); this.follow = false; this.seek(i); };
        out.push(m);
      } else if (!half && minuteOf(p.minute) > 45 && !/^45'\+/.test(p.minute)) {
        half = true;
        const m = el("i", "rp-mark half");
        m.style.left = at;
        m.title = "Halbzeit";
        out.push(m);
      }
    });
    this.marks.replaceChildren(...out);
  }

  private renderLegend() {
    const item = (cls: string, text: string) => { const s = el("span", `rp-lg ${cls}`); s.append(el("i"), text); return s; };
    this.legend.replaceChildren(item("goal", "Tor"), item("on", "aufs Tor"), item("off", "vorbei"), item("blocked", "geblockt"),
      el("span", "rp-lg-teams", `${this.teams?.home.short || "Heim"} · ${this.teams?.away.short || "Gast"} in Teamfarbe`));
  }
}
