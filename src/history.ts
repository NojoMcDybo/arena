/**
 * Karte „Letzte Aufstellungen“: die Startelf eines Teams in seinen letzten (bis zu fuenf) Ligaspielen zum
 * Durchklicken (more.rs recent_lineups). Zwischen zwei Spielen laufen die Spieler an ihren neuen Platz, wer neu
 * in der Startelf ist, bekommt einen Ring; dazu Formation, Gegner und Ergebnis. Oben die Wahl Heim/Gast.
 */

import type { Lineup, Player } from "./detail-ui";
import { FormationPitch } from "./formation";
import { icon } from "./nojo/nojo-icons";
import { crestEl, type SportMatch, type SportTeam } from "./sport-ui";

export type LineupGame = { event: string; date: number; home: boolean; opp: SportTeam; score: string; result: "s" | "u" | "n"; comp: string; lineup: Lineup };
type Load = { games?: LineupGame[]; err?: string };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const R_DE = { s: "Sieg", u: "Remis", n: "Niederlage" } as const;
const day = (t: number) => new Date(t).toLocaleDateString("de-DE", { day: "numeric", month: "short" });

export class LineupHistory {
  readonly el: HTMLElement;
  private pitch = new FormationPitch("fp-history");
  private head: HTMLElement;
  private strip: HTMLElement;
  private info: HTMLElement;
  private key = "";
  private side: "home" | "away" = "home";
  private idx = 0;
  private m: SportMatch | null = null;
  private data = new Map<string, Load>();

  constructor(private load: (team: string) => Promise<LineupGame[]>, pick: (p: Player, team: SportTeam) => void) {
    this.el = el("div", "lh");
    this.el.dataset.key = "lineup-history";
    this.el.dataset.keep = "";
    this.head = el("div", "lh-head");
    this.strip = el("div", "lh-strip");
    this.info = el("div", "lh-info");
    this.pitch.pick(pick);
    this.el.append(this.head, this.pitch.el, this.info, this.strip);
    this.el.tabIndex = 0;
    this.el.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); this.step(e.key === "ArrowLeft" ? 1 : -1); }
    });
  }

  /** prefer: welches Team zuerst (Lieblingsteam) */
  setMatch(m: SportMatch, prefer: "home" | "away" = "home") {
    this.m = m;
    if (m.key !== this.key) {
      this.key = m.key;
      this.side = prefer;
      this.idx = 0;
    }
    this.fetch(m.home.id);
    this.fetch(m.away.id);
    this.draw();
  }

  private fetch(team: string) {
    if (this.data.has(team)) return;
    this.data.set(team, {});
    this.load(team)
      .then((games) => this.data.set(team, { games }))
      .catch((e) => this.data.set(team, { err: String(e) }))
      .finally(() => this.draw());
  }

  private team() {
    return this.side === "home" ? this.m!.home : this.m!.away;
  }

  /** dir 1 = aelteres Spiel, -1 = neueres */
  private step(dir: number) {
    const g = this.data.get(this.team().id)?.games ?? [];
    if (!g.length) return;
    this.idx = Math.max(0, Math.min(g.length - 1, this.idx + dir));
    this.draw();
  }

  private draw() {
    if (!this.m) return;
    const t = this.team();
    // Teamwahl
    const pickBtn = (s: "home" | "away", tm: SportTeam) => {
      const b = el("button", "lh-team" + (s === this.side ? " on" : ""));
      b.append(crestEl(tm, "crest"), el("span", "", tm.short || tm.name));
      b.setAttribute("aria-pressed", String(s === this.side));
      b.onclick = () => { if (this.side !== s) { this.side = s; this.idx = 0; this.draw(); } };
      return b;
    };
    this.head.replaceChildren(pickBtn("home", this.m.home), pickBtn("away", this.m.away));
    const d = this.data.get(t.id);
    const games = d?.games ?? [];
    if (!games.length) {
      this.pitch.team(t, null);
      this.info.replaceChildren(el("span", "faint", d?.err ? d.err : d ? "Aufstellungen werden geladen …" : ""));
      if (d?.games && !d.games.length) this.info.replaceChildren(el("span", "faint", "Keine Aufstellungen der letzten Spiele"));
      this.strip.replaceChildren();
      return;
    }
    this.idx = Math.min(this.idx, games.length - 1);
    const g = games[this.idx];
    // neu in der Startelf: gegenueber dem Spiel davor (aelter)
    const prev = games[this.idx + 1];
    const before = new Set(prev?.lineup.players.filter((p) => p.starter).map((p) => p.id) ?? []);
    const fresh = new Set(prev ? g.lineup.players.filter((p) => p.starter && !before.has(p.id)).map((p) => p.id) : []);
    this.pitch.team({ ...t }, g.lineup, fresh);
    // Zeile unter dem Feld: Formation · gegen X · Ergebnis
    const opp = el("span", "lh-opp");
    opp.append(el("span", "", g.home ? "gegen" : "bei"), crestEl(g.opp, "crest"), el("b", "", g.opp.short || g.opp.name));
    const res = el("span", `lh-res r-${g.result}`, g.score);
    res.title = R_DE[g.result];
    const info = [el("b", "lh-form", g.lineup.formation || "–"), opp, res, el("span", "lh-date faint", `${day(g.date)} · ${g.comp}`)];
    if (fresh.size) info.push(el("span", "lh-fresh", `${fresh.size} neu`));
    this.info.replaceChildren(...info);
    // Spiele zum Durchklicken: aeltestes links, neuestes rechts
    const prevBtn = el("button", "lh-nav");
    prevBtn.innerHTML = icon("prev");
    prevBtn.title = "Älteres Spiel";
    prevBtn.disabled = this.idx >= games.length - 1;
    prevBtn.onclick = () => this.step(1);
    const nextBtn = el("button", "lh-nav");
    nextBtn.innerHTML = icon("next");
    nextBtn.title = "Neueres Spiel";
    nextBtn.disabled = this.idx === 0;
    nextBtn.onclick = () => this.step(-1);
    const dots = games.map((x, i) => {
      const b = el("button", `lh-dot r-${x.result}` + (i === this.idx ? " on" : ""));
      b.append(crestEl(x.opp, "crest"), el("small", "", day(x.date)));
      b.title = `${x.home ? "gegen" : "bei"} ${x.opp.name} ${x.score} · ${x.lineup.formation}`;
      b.onclick = () => { this.idx = i; this.draw(); };
      return b;
    }).reverse();
    this.strip.replaceChildren(prevBtn, ...dots, nextBtn);
  }
}
