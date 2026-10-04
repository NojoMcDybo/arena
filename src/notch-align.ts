// Ausrichtung an der Notch: Arena weiss, wo die Notch auf dem Bildschirm sitzt (lib.rs notch_rect) und richtet
// sich danach — der Spielstand steht genau unter ihr, die Trennlinie der beiden Kartenspalten liegt auf ihrer
// Mittelachse, und die Kopfleiste weicht aus, sobald die Notch ueber ihr liegt. Seitlich angedockt haelt der
// Inhalt Abstand zu ihr. Laeuft keine Notch, bleibt alles mittig wie gewohnt.

import { invoke } from "@tauri-apps/api/core";

type Rect = { dock: "top" | "left" | "right"; x: number; y: number; w: number; h: number };

let rect: Rect | null = null;
/** Mittelachse der Notch in Fensterkoordinaten (nur oben angedockt und wenn sie ueber dem Fenster liegt) */
let axis: number | null = null;

/** Lage neu holen (Fenster verschoben, Notch umgedockt); active = Notch laeuft */
export async function refreshNotch(active: boolean) {
  rect = active ? await invoke<Rect | null>("notch_rect").catch(() => null) : null;
  apply();
}

function apply() {
  const root = document.documentElement;
  const r = rect;
  const top = document.querySelector<HTMLElement>(".top")?.offsetHeight ?? 56;
  const a = r?.dock === "top" ? r.x + r.w / 2 : null;
  axis = a !== null && a > 40 && a < innerWidth - 40 ? a : null;
  // Kopfleiste: liegt die Notch ueber ihr, ruecken die Reiter neben die Marke (wie im Vollbild)
  document.body.classList.toggle("notched", !!r && axis !== null && r.y + r.h > 0 && r.y < top);
  // seitlich angedockt: so viel Abstand, wie die Notch ins Fenster ragt
  const overlapY = !!r && r.y < innerHeight && r.y + r.h > 0;
  const left = r?.dock === "left" && overlapY ? Math.max(0, r.x + r.w) : 0;
  const right = r?.dock === "right" && overlapY ? Math.max(0, innerWidth - r.x) : 0;
  root.style.setProperty("--notch-l", `${left > 0 && left < 200 ? left + 8 : 0}px`);
  root.style.setProperty("--notch-r", `${right > 0 && right < 200 ? right + 8 : 0}px`);
  alignLive();
}

/** Live: Spielstand unter die Notch, Spaltengrenze auf ihre Achse (nach jedem Neuzeichnen aufrufen) */
export function alignLive() {
  const box = document.querySelector<HTMLElement>(".focus");
  if (!box) return;
  const big = box.querySelector<HTMLElement>(".big");
  const body = big?.querySelector<HTMLElement>(".big-body");
  const score = big?.querySelector<HTMLElement>(".big-score");
  const off = () => { box.classList.remove("axis"); box.style.removeProperty("--split-l"); box.style.removeProperty("--split-r"); box.style.removeProperty("--score-dx"); };
  if (axis === null || !big || !body || !score || !big.offsetParent) return off();
  // Spaltengrenze: die Luecke zwischen den Spalten mittig auf der Achse; zu schmale Spalten -> Standardaufteilung
  const br = body.getBoundingClientRect();
  const gap = parseFloat(getComputedStyle(body).columnGap) || 16;
  const left = axis - br.left - gap / 2;
  const right = br.width - left - gap;
  const split = innerWidth >= 960 && left >= 300 && right >= 300;
  box.style.setProperty("--split-l", split ? `${left.toFixed(1)}px` : "");
  box.style.setProperty("--split-r", split ? `${right.toFixed(1)}px` : "");
  box.classList.toggle("axis", split);
  // Spielstand: die Ziffern mittig auf die Achse; begrenzt, damit Wappen und Namen in der Karte bleiben
  // (das Raster selbst ist so breit wie die Karte, gemessen wird also sein Inhalt)
  // tatsaechliche Verschiebung (auch mitten im Uebergang), nicht der Zielwert — sonst schaukelt sich die Rechnung auf
  const cur = parseFloat(getComputedStyle(score).translate) || 0;
  const num = score.querySelector<HTMLElement>(".big-num");
  const parts = Array.from(score.querySelectorAll<HTMLElement>(".big-side > *, .big-num"));
  if (!num || !parts.length) return;
  const nr = num.getBoundingClientRect();
  const kr = big.getBoundingClientRect();
  const minL = Math.min(...parts.map((e) => e.getBoundingClientRect().left)) - cur;
  const maxR = Math.max(...parts.map((e) => e.getBoundingClientRect().right)) - cur;
  let dx = axis - ((nr.left + nr.right) / 2 - cur);
  dx = Math.max(kr.left + 12 - minL, Math.min(kr.right - 12 - maxR, dx));
  box.style.setProperty("--score-dx", `${dx.toFixed(1)}px`);
}

addEventListener("resize", apply);
