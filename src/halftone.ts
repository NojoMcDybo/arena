/**
 * Wappen als Punkteraster (Halftone) im Hintergrund der Live-Ansicht: links das Heimwappen, rechts das der
 * Gaeste, gross und leise. Jede Rasterzelle wird ein Punkt — Groesse aus Deckkraft und Helligkeit des Wappens,
 * Farbe aus dem Wappen selbst. Zur Mitte hin laufen die Punkte aus, damit Stand und Uhr frei bleiben.
 *
 * Canvas 2D statt WebGL: das Raster wird nur beim Wechsel des Spiels oder der Groesse neu gezeichnet (kein
 * Dauerlauf, keine Animation). Die ESPN-Wappen kommen mit CORS (*), deshalb darf der Canvas sie auslesen;
 * klappt das nicht, bleibt der Hintergrund leer.
 */

import type { SportTeam } from "./sport-ui";

/** grosse Fassung fuers Raster (ESPN liefert 500 px; der Combiner verkleinert) */
function bigLogo(url: string) {
  const m = /^https:\/\/a\.espncdn\.com(\/i\/teamlogos\/[^?]+\.png)$/.exec(url);
  return m ? `https://a.espncdn.com/combiner/i?img=${m[1]}&h=160&w=160` : url;
}

function load(url: string): Promise<HTMLImageElement | null> {
  if (!url) return Promise.resolve(null);
  return new Promise((res) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => res(img);
    img.onerror = () => res(null);
    img.src = bigLogo(url);
  });
}

export class CrestDots {
  readonly el: HTMLCanvasElement;
  private sig = "";
  private imgs: (HTMLImageElement | null)[] = [null, null];
  private ro: ResizeObserver;
  private frame = 0;

  constructor() {
    this.el = document.createElement("canvas");
    this.el.className = "crest-dots";
    this.el.setAttribute("aria-hidden", "true");
    // morph() setzt es nur ein (Inhalt zeichnet die Klasse selbst)
    this.el.dataset.key = "crest-dots";
    this.el.dataset.keep = "";
    this.ro = new ResizeObserver(() => this.later());
    this.ro.observe(this.el);
  }

  set(home: SportTeam, away: SportTeam) {
    const sig = `${home.logo}|${away.logo}`;
    if (sig === this.sig) return;
    this.sig = sig;
    this.imgs = [null, null];
    this.draw();
    void Promise.all([load(home.logo), load(away.logo)]).then((imgs) => {
      if (this.sig !== sig) return;
      this.imgs = imgs;
      this.draw();
    });
  }

  private later() {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.draw());
  }

  private draw() {
    const c = this.el;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
    if (!w || !h) return;
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const g = c.getContext("2d");
    if (!g) return;
    g.clearRect(0, 0, w, h);
    const step = Math.round(7 * dpr);
    const size = Math.min(h * 1.15, w * 0.46);
    this.imgs.forEach((img, side) => {
      if (!img) return;
      // Raster: so viele Zellen, wie das Wappen breit ist
      const cells = Math.max(8, Math.floor(size / step));
      const off = document.createElement("canvas");
      off.width = off.height = cells;
      const o = off.getContext("2d", { willReadFrequently: true });
      if (!o) return;
      const ar = img.naturalWidth / Math.max(1, img.naturalHeight);
      const dw = ar >= 1 ? cells : cells * ar, dh = ar >= 1 ? cells / ar : cells;
      o.drawImage(img, (cells - dw) / 2, (cells - dh) / 2, dw, dh);
      let px: Uint8ClampedArray;
      try { px = o.getImageData(0, 0, cells, cells).data; } catch { return; } // ohne CORS: kein Raster
      // links ein Stueck ueber den Rand hinaus, rechts gespiegelt
      const x0 = side === 0 ? -size * 0.12 : w - size * 0.88;
      const y0 = (h - size) / 2;
      for (let j = 0; j < cells; j++) {
        for (let i = 0; i < cells; i++) {
          const k = (j * cells + i) * 4;
          const a = px[k + 3] / 255;
          if (a < 0.08) continue;
          const r = px[k], gg = px[k + 1], b = px[k + 2];
          const lum = (0.2126 * r + 0.7152 * gg + 0.0722 * b) / 255;
          const x = x0 + (i + 0.5) * step, y = y0 + (j + 0.5) * step;
          // zur Mitte des Fensters hin auslaufen
          const toMid = Math.abs(x - w / 2) / (w / 2);
          const fade = Math.min(1, Math.max(0, (toMid - 0.18) / 0.5));
          const rad = (step / 2) * Math.min(1, a * (0.45 + 0.55 * lum)) * 0.92;
          if (rad < 0.4 || fade <= 0) continue;
          g.globalAlpha = 0.24 * fade;
          g.fillStyle = `rgb(${Math.max(r, 60)},${Math.max(gg, 60)},${Math.max(b, 60)})`;
          g.beginPath();
          g.arc(x, y, rad, 0, Math.PI * 2);
          g.fill();
        }
      }
    });
    g.globalAlpha = 1;
  }
}
