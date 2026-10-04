/**
 * Liga-Symbole und Ligafarben.
 *
 * - Symbol: Logo von ESPN (dunkle Fassung bevorzugt, passt aufs Folio-Grau); ohne Logo ein Kuerzel.
 * - Farbe: aus dem Logo gelesen (haeufigster kraeftiger Farbton, Canvas), einmal pro Logo, im localStorage
 *   gemerkt. Einfarbige Logos (weiss/schwarz) nehmen die Ersatzfarbe unten. Die Farbe traegt die Spielplan-
 *   Verlaeufe: jede Liga hat ihren Ton, an der Grenze zweier Spalten fliessen sie ineinander (in OKLCH).
 */

import { invoke } from "@tauri-apps/api/core";

export type LeagueMeta = { id: string; logo: string; dark: string };

/** Ersatzfarben (Markenfarben der Ligen, wo das Logo keine kraeftige Farbe hat) */
const FALLBACK: Record<string, string> = {
  bl1: "#e2001a", bl2: "#e2001a", bl3: "#7f8c99", dfb: "#00a85a", ffb1: "#d6336c", dfbteam: "#f2c94c", turnier: "#8e6be8",
  ucl: "#2f5bd3", uel: "#ff6900", uecl: "#16c172", epl: "#7a3fbf", laliga: "#ff4b44", seriea: "#1f8fd6", ligue1: "#cddc39",
  nfl: "#3a6ee8", nba: "#e0383e", nhl: "#a7b0b8", mlb: "#2f6fd6",
};

const meta = new Map<string, LeagueMeta>();
const KEY = "arena-league-colors-v1";
const colors = new Map<string, string>();
try { for (const [k, v] of Object.entries(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, string>)) colors.set(k, v); } catch { /* leer */ }

/** Logos und (einmal) ihre Farben laden; `done` wird gerufen, wenn sich etwas Sichtbares aendert */
export async function loadLeagueMeta(done: () => void) {
  const list = (await invoke<LeagueMeta[] | null>("league_meta").catch(() => null)) ?? [];
  for (const m of list) meta.set(m.id, m);
  done();
  let changed = false;
  await Promise.all(list.filter((m) => m.logo && !colors.has(m.id)).map(async (m) => {
    const c = await logoColor(m.logo);
    if (c) { colors.set(m.id, c); changed = true; }
  }));
  if (changed) {
    try { localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(colors))); } catch { /* egal */ }
    done();
  }
}

export const leagueColor = (id: string) => colors.get(id) ?? FALLBACK[id] ?? "#75b8ff";

/** Liga-Symbol als kleines Bild (oder Kuerzel) */
export function leagueIcon(id: string, name: string, cls = "lg-ico") {
  const box = document.createElement("span");
  box.className = cls;
  box.style.setProperty("--lc", leagueColor(id));
  box.title = name;
  const m = meta.get(id);
  const src = m?.dark || m?.logo;
  if (src) {
    const img = new Image();
    img.alt = "";
    img.draggable = false;
    img.src = src;
    img.onerror = () => { img.remove(); box.classList.add("mono"); box.textContent = abbr(name); };
    box.append(img);
  } else {
    box.classList.add("mono");
    box.textContent = abbr(name);
  }
  return box;
}

const abbr = (name: string) => name.replace(/^(\d)\.\s*/, "$1").split(/[\s-]+/).map((w) => w[0]).join("").slice(0, 3).toUpperCase();

/** Haeufigster kraeftiger Farbton eines Logos (12 Farbton-Faecher), null bei einfarbigen Logos */
function logoColor(url: string): Promise<string | null> {
  return new Promise((res) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onerror = () => res(null);
    img.onload = () => {
      try {
        const N = 48;
        const c = document.createElement("canvas");
        c.width = c.height = N;
        const g = c.getContext("2d", { willReadFrequently: true })!;
        g.drawImage(img, 0, 0, N, N);
        const px = g.getImageData(0, 0, N, N).data;
        const bins = Array.from({ length: 12 }, () => ({ n: 0, r: 0, g: 0, b: 0 }));
        for (let k = 0; k < px.length; k += 4) {
          if (px[k + 3] < 200) continue;
          const r = px[k] / 255, gg = px[k + 1] / 255, b = px[k + 2] / 255;
          const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b), l = (mx + mn) / 2, d = mx - mn;
          const sat = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
          if (sat < 0.4 || l < 0.18 || l > 0.85) continue;
          let h = mx === r ? ((gg - b) / d) % 6 : mx === gg ? (b - r) / d + 2 : (r - gg) / d + 4;
          h = (h * 60 + 360) % 360;
          const bin = bins[Math.floor(h / 30) % 12];
          bin.n++; bin.r += px[k]; bin.g += px[k + 1]; bin.b += px[k + 2];
        }
        const best = bins.reduce((a, b) => (b.n > a.n ? b : a));
        if (best.n < (N * N) / 40) { res(null); return; }
        const hex = (v: number) => Math.round(v / best.n).toString(16).padStart(2, "0");
        res(`#${hex(best.r)}${hex(best.g)}${hex(best.b)}`);
      } catch { res(null); }
    };
    img.src = url;
  });
}
