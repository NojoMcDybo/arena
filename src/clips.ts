/**
 * Clips zum Spiel: offizielle ESPN-Videos (info.rs, „videos“ der Spielzusammenfassung) — Tore, Zusammenfassung,
 * Stimmen. ESPN stellt Tor-Clips meist wenige Minuten nach der Szene bereit (vor allem LaLiga, Premier League,
 * Champions League); Arena fragt laufende Spiele alle 30 s ab, neue Clips erscheinen dann von selbst.
 *
 * Laya (falls installiert) ordnet jede Ueberschrift ein: Tor, Zusammenfassung oder Stimmen; ohne Modell
 * entscheiden Stichworte. Tor-Clips werden dem Tor im Ticker zugeordnet (Nachname des Schuetzen im Titel).
 *
 * Soziale Netzwerke durchsucht Arena nicht: X, Instagram und TikTok haben keine freie Schnittstelle, und die
 * Tor-Videos dort sind meist ungenehmigte Mitschnitte der TV-Uebertragung.
 */

import { askLaya, layaReady } from "./laya/client";

export type Clip = { headline: string; url: string; thumb: string; duration: number; at: number };
export type ClipKind = "goal" | "highlights" | "reaction";

export const CLIP_DE: Record<ClipKind, string> = { goal: "Tor", highlights: "Zusammenfassung", reaction: "Stimmen" };

const CLIP_Q = {
  clip: {
    type: "choice",
    instructions: "What does this football video title show?",
    criteria: {
      goal: "a single goal, save or chance in a match",
      highlights: "the highlights or summary of a whole match",
      reaction: "an interview, press conference, reaction or analysis",
    },
  },
};

const kinds = new Map<string, ClipKind>();

/** Stichworte, solange Laya nichts gesagt hat */
function guess(h: string): ClipKind {
  const l = h.toLowerCase();
  if (/highlights|recap|summary/.test(l)) return "highlights";
  if (/analysis|interview|press|reacts|reaction|explains|says|on why|why |talks/.test(l)) return "reaction";
  if (/score|goal|header|heads|strike|finish|penalty|volley|equali|winner|lead|in front|fires|nets|curls|slots|taps|levels|doubles|opener|stunner|rocket|brace|hat-trick|save/.test(l)) return "goal";
  return "reaction";
}

export const clipKind = (h: string): ClipKind => kinds.get(h) ?? guess(h);

/** Laya ordnet neue Ueberschriften ein; danach `done` (neu zeichnen) */
export function classifyClips(clips: Clip[], done: () => void) {
  if (!layaReady()) return;
  const todo = clips.filter((c) => !kinds.has(c.headline));
  if (!todo.length) return;
  void askLaya(CLIP_Q, todo.map((c, i) => ({ id: String(i), text: c.headline }))).then((res) => {
    let changed = false;
    for (const [id, probs] of res) {
      const best = Object.entries(probs).sort((a, b) => b[1] - a[1])[0];
      if (best) { kinds.set(todo[Number(id)].headline, best[0] as ClipKind); changed = true; }
    }
    if (changed) done();
  });
}

/** Tor-Clip zu einem Torschuetzen (Nachname im Titel) */
export function clipForScorer(clips: Clip[], scorer: string): Clip | undefined {
  const last = scorer.replace(/\(.*?\)/g, "").trim().split(/\s+/).pop()?.toLowerCase();
  if (!last || last.length < 3) return undefined;
  return clips.find((c) => clipKind(c.headline) === "goal" && c.headline.toLowerCase().includes(last));
}

export const duration = (s: number) => (s > 0 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : "");
