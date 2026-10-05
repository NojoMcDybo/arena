/**
 * Laya in der Oberflaeche: Zustand des Modells (laya.rs), Einordnen von Schlagzeilen im Worker, Zwischenspeicher.
 *
 * - Ergebnisse je Schlagzeile bleiben im localStorage (eine Schlagzeile wird nur einmal eingeordnet).
 * - Der Worker startet erst, wenn es etwas einzuordnen gibt, und endet nach 90 s Ruhe (Speicher frei).
 * - Ohne Modell (aus, laedt noch, Fehler) passiert nichts; Arena nimmt dann die Stichwortsuche aus info.rs.
 */

import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Kind } from "./questions";

export type LayaStatus = {
  want: boolean;
  state: "off" | "missing" | "downloading" | "ready" | "error";
  done: number;
  total: number;
  message: string;
  dir: string;
};
export type Label = { kind: Kind; p: number };

let status: LayaStatus = { want: false, state: "off", done: 0, total: 0, message: "", dir: "" };
const subs = new Set<() => void>();
const notify = () => subs.forEach((f) => f());

export const layaStatus = () => status;
export function onLaya(fn: () => void) {
  subs.add(fn);
  return () => subs.delete(fn);
}

export async function initLaya() {
  status = (await invoke<LayaStatus | null>("laya_status").catch(() => null)) ?? status;
  await listen<LayaStatus>("laya", (e) => {
    status = e.payload;
    if (status.state !== "ready") stopWorker();
    notify();
  });
  notify();
}

export async function installLaya() {
  status = (await invoke<LayaStatus | null>("laya_install").catch(() => null)) ?? status;
  notify();
}

export async function uninstallLaya() {
  stopWorker();
  status = (await invoke<LayaStatus | null>("laya_uninstall").catch(() => null)) ?? status;
  try { localStorage.removeItem(KEY); } catch { /* egal */ }
  cache.clear();
  notify();
}

// ---------- Zwischenspeicher ----------

const KEY = "arena-laya-v1";
const cache = new Map<string, Label>();
try {
  for (const [k, v] of Object.entries(JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, Label>)) cache.set(k, v);
} catch { /* leer anfangen */ }
let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    // die neuesten 600 behalten
    const keep = [...cache.entries()].slice(-600);
    try { localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(keep))); } catch { /* voll: egal */ }
  }, 800);
}

export const labelOf = (text: string): Label | undefined => cache.get(text);

// ---------- Worker ----------

let worker: Worker | null = null;
let loading: Promise<void> | null = null;
let idleTimer = 0;
const queue: string[] = [];
const queued = new Set<string>();
let running = false;
let lastError = "";
/** laufende Einordnung: wie viele erledigt / insgesamt (fuer „Laya ordnet ein … 3/12“) */
const run = { done: 0, total: 0 };

export const layaWork = () => ({ ...run, busy: running || queue.length > 0, error: lastError });

/** laufende Fragen (askLaya): solange darf der Ruhe-Zeitgeber den Worker nicht beenden */
let asking = 0;
const idleStop = () => { if (!asking && !running) stopWorker(); };

function stopWorker() {
  clearTimeout(idleTimer);
  worker?.terminate();
  worker = null;
  loading = null;
}

function ensureWorker(): Promise<void> {
  if (worker && loading) return loading;
  worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  const w = worker;
  loading = new Promise<void>((resolve, reject) => {
    const on = (e: MessageEvent) => {
      if (e.data.type === "ready") { w.removeEventListener("message", on); resolve(); }
      if (e.data.type === "error") { w.removeEventListener("message", on); reject(new Error(e.data.message)); }
    };
    w.addEventListener("message", on);
    w.addEventListener("error", (e) => reject(new Error(e.message || "Worker-Fehler")), { once: true });
    w.postMessage({ type: "load", base: convertFileSrc(status.dir) });
  });
  return loading;
}

/** Auftraege an den Worker nacheinander (Einordnen und Fragen teilen sich ein Modell) */
let lock: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const next = lock.then(fn, fn);
  lock = next.catch(() => {});
  return next;
}

function runBatch(texts: string[]): Promise<void> {
  return exclusive(() => runBatchNow(texts));
}

function runBatchNow(texts: string[]): Promise<void> {
  const w = worker!;
  return new Promise<void>((resolve, reject) => {
    const on = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === "result") {
        const t = texts[Number(m.id)];
        cache.set(t, { kind: m.kind, p: m.p });
        queued.delete(t);
        run.done++;
        save();
        notify();
      } else if (m.type === "done") {
        w.removeEventListener("message", on);
        resolve();
      } else if (m.type === "error") {
        w.removeEventListener("message", on);
        reject(new Error(m.message));
      }
    };
    w.addEventListener("message", on);
    // stuerzt der Worker ab (z. B. kein Speicher), kommt keine Nachricht mehr: nicht ewig warten
    w.addEventListener("error", (e) => { w.removeEventListener("message", on); reject(new Error(e.message || "Worker abgestürzt")); }, { once: true });
    w.postMessage({ type: "classify", items: texts.map((text, i) => ({ id: String(i), text })) });
  });
}

async function pump() {
  if (running) return;
  running = true;
  lastError = "";
  try {
    await ensureWorker();
    while (queue.length && status.state === "ready") await runBatch(queue.splice(0, 8));
  } catch (e) {
    lastError = String((e as Error)?.message ?? e);
    console.warn("Laya:", lastError);
    stopWorker();
  }
  queue.length = 0;
  queued.clear();
  running = false;
  run.done = run.total = 0;
  notify();
  clearTimeout(idleTimer);
  idleTimer = window.setTimeout(idleStop, 90_000);
}

/** Schlagzeilen einordnen lassen (nur neue; Ergebnisse kommen ueber onLaya) */
export function classify(texts: string[]) {
  if (status.state !== "ready" || lastError) return;
  const todo = [...new Set(texts)].filter((t) => t && !cache.has(t) && !queued.has(t));
  if (!todo.length) return;
  for (const t of todo) queued.add(t);
  queue.push(...todo);
  run.total += todo.length;
  clearTimeout(idleTimer);
  void pump();
}

/**
 * Eine Auswahlfrage an Laya fuer viele Texte (z. B. Spielerrollen): Wahrscheinlichkeiten je Antwort und Eintrag.
 * Nur mit installiertem Modell; sonst bleibt die Liste leer. Antworten werden je Text gemerkt (diese Sitzung).
 */
const asked = new Map<string, Record<string, number>>();
export const layaReady = () => status.state === "ready" && !lastError;
export async function askLaya(questions: Record<string, unknown>, items: { id: string; text: string }[]): Promise<Map<string, Record<string, number>>> {
  const out = new Map<string, Record<string, number>>();
  if (!layaReady()) return out;
  const key = Object.keys(questions).join(",") + ":";
  const todo = items.filter((x) => { const c = asked.get(key + x.text); if (c) out.set(x.id, c); return !c; });
  if (!todo.length) return out;
  clearTimeout(idleTimer);
  asking++;
  try {
    await ensureWorker();
    await exclusive(() => new Promise<void>((resolve, reject) => {
      const w = worker!;
      const on = (e: MessageEvent) => {
        const m = e.data;
        if (m.type === "answer") {
          const it = todo[Number(m.id)];
          asked.set(key + it.text, m.probs);
          out.set(it.id, m.probs);
        } else if (m.type === "done") { w.removeEventListener("message", on); resolve(); }
        else if (m.type === "error") { w.removeEventListener("message", on); reject(new Error(m.message)); }
      };
      w.addEventListener("message", on);
      w.postMessage({ type: "ask", questions, items: todo.map((x, i) => ({ id: String(i), text: x.text })) });
    }));
  } catch (e) {
    lastError = String((e as Error)?.message ?? e);
    stopWorker();
    notify();
  }
  asking--;
  idleTimer = window.setTimeout(idleStop, 90_000);
  return out;
}

/** Nach einem Fehler erneut versuchen (Knopf in den Einstellungen) */
export function retryLaya() {
  lastError = "";
  notify();
}
