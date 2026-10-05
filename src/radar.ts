/**
 * Radar (Netzdiagramm) fuer Arena: Spieler, Kaderstaerken, Teamvergleich.
 *
 * Werte 0..1 je Achse (was 1 bedeutet, entscheidet der Aufrufer und schreibt es in die Unterzeile);
 * null = Wert fehlt (z. B. vor dem Spiel): dann steht nur das Netz da, die Achsen bleiben lesbar.
 * Mehrere Reihen liegen uebereinander (Teamvergleich: Heim und Gast in ihren Farben). Im Tooltip jedes
 * Eckpunkts steht der echte Wert, nicht der normierte.
 */

const SVGNS = "http://www.w3.org/2000/svg";
function sv<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  return e;
}

export type RadarSeries = {
  label: string;
  color: string;
  /** 0..1 je Achse, null = fehlt */
  values: (number | null)[];
  /** echter Wert je Achse fuer den Tooltip ("1,8 / 90 Min") */
  raw?: string[];
};

const R = 78;

export function radarEl(axes: string[], series: RadarSeries[], cls = "") {
  const n = axes.length;
  const box = document.createElement("div");
  box.className = `radar ${cls}`.trim();
  const svg = sv("svg", { viewBox: "-128 -112 256 224", class: "radar-svg", role: "img" });
  svg.setAttribute("aria-label", series.map((s) => `${s.label}: ${axes.map((a, i) => `${a} ${s.raw?.[i] ?? "–"}`).join(", ")}`).join("; ") || axes.join(", "));
  const ang = (i: number) => -Math.PI / 2 + (i / n) * Math.PI * 2;
  const pt = (i: number, r: number) => [Math.cos(ang(i)) * r, Math.sin(ang(i)) * r] as const;
  const grid = sv("g", { class: "rd-grid" });
  for (const k of [0.25, 0.5, 0.75, 1]) {
    grid.append(sv("polygon", { points: axes.map((_, i) => pt(i, R * k).map((v) => v.toFixed(1)).join(",")).join(" "), class: k === 1 ? "outer" : "" }));
  }
  axes.forEach((a, i) => {
    const [x, y] = pt(i, R);
    grid.append(sv("line", { x1: 0, y1: 0, x2: x.toFixed(1), y2: y.toFixed(1) }));
    const [lx, ly] = pt(i, R + 15);
    const t = sv("text", { x: lx.toFixed(1), y: (ly + 3).toFixed(1), "text-anchor": Math.abs(lx) < 6 ? "middle" : lx > 0 ? "start" : "end" });
    t.textContent = a;
    grid.append(t);
  });
  svg.append(grid);
  for (const s of series) {
    if (s.values.every((v) => v == null)) continue;
    const g = sv("g", { class: "rd-series" });
    g.style.setProperty("--c", s.color);
    const pts = s.values.map((v, i) => pt(i, R * Math.max(0.03, Math.min(1, v ?? 0))));
    g.append(sv("polygon", { points: pts.map((p) => p.map((v) => v.toFixed(1)).join(",")).join(" ") }));
    pts.forEach((p, i) => {
      if (s.values[i] == null) return;
      const c = sv("circle", { cx: p[0].toFixed(1), cy: p[1].toFixed(1), r: 2.6 });
      const title = sv("title");
      title.textContent = `${s.label} · ${axes[i]}: ${s.raw?.[i] ?? ""}`;
      c.append(title);
      g.append(c);
    });
    svg.append(g);
  }
  box.append(svg);
  // Legende nur bei mehreren Reihen
  if (series.length > 1) {
    const lg = document.createElement("div");
    lg.className = "rd-legend";
    for (const s of series) {
      const i = document.createElement("span");
      i.style.setProperty("--c", s.color);
      i.textContent = s.label;
      lg.append(i);
    }
    box.append(lg);
  }
  return box;
}

/** v auf 0..1 zwischen lo und hi (umgekehrt, wenn lo > hi: weniger ist besser) */
export const scale = (v: number, lo: number, hi: number) => Math.max(0, Math.min(1, (v - lo) / (hi - lo)));

/**
 * Radar mit Uebergang: neue Werte (oder ein zweiter Spieler zum Vergleich) wachsen in 0,6 s aus den alten
 * heraus, statt zu springen. Gleiche Achsen vorausgesetzt; wechseln die Achsen, beginnt es neu.
 */
export class RadarAnim {
  readonly el: HTMLElement;
  private axes: string[] = [];
  private cur: RadarSeries[] = [];
  private raf = 0;

  constructor(private cls = "") {
    this.el = document.createElement("div");
    this.el.className = "radar-anim";
    this.el.dataset.keep = "";
  }

  set(axes: string[], series: RadarSeries[]) {
    const same = axes.join("|") === this.axes.join("|");
    const from = same ? this.cur : [];
    this.axes = axes;
    cancelAnimationFrame(this.raf);
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const draw = (k: number) => {
      const e = 1 - (1 - k) ** 3;
      const mix = series.map((s, si) => {
        const f = from[si]?.values ?? s.values.map(() => 0);
        return { ...s, values: s.values.map((v, i) => (v == null ? null : (f[i] ?? 0) + (v - (f[i] ?? 0)) * e)) };
      });
      this.el.replaceChildren(radarEl(axes, mix, this.cls));
    };
    this.cur = series;
    if (still) return draw(1);
    const t0 = performance.now();
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / 600);
      draw(k);
      if (k < 1) this.raf = requestAnimationFrame(tick);
    };
    draw(0);
    this.raf = requestAnimationFrame(tick);
  }
}
