// Hintergrund: Nebel in den Farben der gewaehlten Ligen. Grosse weiche Schwaden ziehen langsam durchs Fenster,
// dazwischen dunkle, die den Grund durchlassen — jede Liga ist mit zwei Schwaden vertreten.
//
// Gerechnet wird klein (1/10 der Fenstergroesse) und vom Browser weich hochskaliert: Radialverlaeufe sind ohnehin
// unscharf, so kostet ein Bild fast nichts. 20 Bilder/s, angehalten im Hintergrund; „Bewegung reduzieren“
// zeigt ein stehendes Bild.

const SCALE = 10;
const FPS = 20;

type Wisp = { color: [number, number, number]; dark: boolean; x: number; y: number; r: number; ax: number; ay: number; sx: number; sy: number; ph: number; a: number };

const rgb = (hex: string): [number, number, number] => {
  const h = hex.replace("#", "");
  const f = h.length === 3 ? h.split("").map((c) => c + c).join("") : h.padEnd(6, "0");
  return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16) || 0) as [number, number, number];
};

/** gleichmaessig gestreut (Goldener Winkel), aber jedes Mal gleich — der Nebel springt beim Neuaufbau nicht */
const spot = (i: number, n: number) => {
  const a = i * 2.399963;
  const d = Math.sqrt((i + 0.5) / Math.max(n, 1)) * 0.5;
  return [0.5 + Math.cos(a) * d * 1.1, 0.5 + Math.sin(a) * d * 0.9];
};

export class Fog {
  readonly el: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private wisps: Wisp[] = [];
  private sig = "";
  private last = 0;
  private raf = 0;
  private still = matchMedia("(prefers-reduced-motion: reduce)");

  constructor() {
    this.el = document.createElement("canvas");
    this.el.className = "fog";
    this.el.setAttribute("aria-hidden", "true");
    this.ctx = this.el.getContext("2d")!;
    const size = () => {
      this.el.width = Math.max(16, Math.ceil(innerWidth / SCALE));
      this.el.height = Math.max(10, Math.ceil(innerHeight / SCALE));
      this.draw(performance.now());
    };
    addEventListener("resize", size);
    document.addEventListener("visibilitychange", () => this.run());
    this.still.addEventListener("change", () => this.run());
    size();
  }

  /** Ligafarben (Hex); gleiche Farben -> nichts zu tun */
  setColors(colors: string[]) {
    const list = [...new Set(colors.map((c) => c.toLowerCase()))];
    if (!list.length) list.push("#75b8ff");
    const sig = list.join(",");
    if (sig === this.sig) return;
    this.sig = sig;
    // zwei helle Schwaden je Liga, dazu dunkle (etwa jede dritte), die den Grund freilegen
    const bright = list.flatMap((c) => [c, c]);
    const darkN = Math.max(2, Math.round(bright.length / 3));
    const n = bright.length + darkN;
    const order = [...bright.map((c) => ({ c, dark: false })), ...Array.from({ length: darkN }, () => ({ c: "#000000", dark: true }))];
    // Farben mischen, damit gleiche Ligen nicht nebeneinander starten
    const mixed = order.map((o, i) => ({ o, k: (i * 7919) % n })).sort((a, b) => a.k - b.k).map((x) => x.o);
    this.wisps = mixed.map(({ c, dark }, i) => {
      const [x, y] = spot(i, n);
      const seed = (i * 0.6180339) % 1;
      return {
        color: rgb(c), dark, x, y,
        r: (dark ? 0.3 : 0.24) + seed * 0.16,
        ax: 0.12 + seed * 0.14, ay: 0.08 + ((seed * 3.3) % 1) * 0.12,
        sx: 0.018 + ((seed * 5.1) % 1) * 0.03, sy: 0.014 + ((seed * 7.7) % 1) * 0.026,
        ph: seed * Math.PI * 2,
        a: dark ? 0.85 : 0.5 + ((seed * 2.7) % 1) * 0.3,
      };
    }).sort((a, b) => Number(a.dark) - Number(b.dark)); // dunkle zuletzt: sie nehmen aus allem Farbe weg
    this.draw(performance.now());
    this.run();
  }

  private run() {
    cancelAnimationFrame(this.raf);
    if (document.hidden || this.still.matches) return;
    const tick = (t: number) => {
      this.raf = requestAnimationFrame(tick);
      if (t - this.last < 1000 / FPS) return;
      this.last = t;
      this.draw(t);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private draw(t: number) {
    const { ctx } = this;
    const w = this.el.width, h = this.el.height, big = Math.max(w, h);
    const s = t / 1000;
    // helles Thema der Designsprache (nojo-ui.css): :root[data-theme="light"]
    const light = document.documentElement.dataset.theme === "light";
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, w, h);
    for (const p of this.wisps) {
      // langsame Lissajous-Bahnen; Groesse und Dichte atmen leicht
      const x = (p.x + Math.sin(s * p.sx * 2 * Math.PI + p.ph) * p.ax) * w;
      const y = (p.y + Math.cos(s * p.sy * 2 * Math.PI + p.ph * 1.3) * p.ay) * h;
      const r = p.r * big * (1 + 0.12 * Math.sin(s * p.sy * 3 + p.ph));
      const a = p.a * (0.75 + 0.25 * Math.sin(s * p.sx * 4 + p.ph * 2));
      const [cr, cg, cb] = p.color;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      if (p.dark) {
        // dunkle Schwade: nimmt Farbe weg (hell: weniger stark, sonst wird es grau)
        ctx.globalCompositeOperation = "destination-out";
        const k = light ? a * 0.6 : a;
        g.addColorStop(0, `rgba(0,0,0,${k})`);
        g.addColorStop(0.55, `rgba(0,0,0,${k * 0.45})`);
        g.addColorStop(1, "rgba(0,0,0,0)");
      } else {
        // uebermalen statt aufhellen: jede Liga behaelt ihren Ton, wo ihre Schwade dicht ist (screen mischt alles zu Grau)
        ctx.globalCompositeOperation = "source-over";
        const k = light ? a * 0.55 : a;
        g.addColorStop(0, `rgba(${cr},${cg},${cb},${k})`);
        g.addColorStop(0.45, `rgba(${cr},${cg},${cb},${k * 0.5})`);
        g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      }
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.globalCompositeOperation = "source-over";
  }
}
