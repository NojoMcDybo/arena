/**
 * Aehnliche Spieler: alle Spieler der Liga (more.rs league_pool) mit ihren Saisonwerten je 90 Minuten.
 *
 * - Werte: Tore, Vorlagen, Schuesse, aufs Tor, Torschussvorlagen, Pass- und Zweikampfquote, Tacklings,
 *   Ballgewinne (Interceptions), Balleroberungen — je Merkmal auf den Ligaschnitt bezogen (z-Wert), damit
 *   seltene Werte (Tore) so viel zaehlen wie haeufige (Paesse).
 * - Laya (falls installiert) ordnet jedem Spieler aus seinem Profiltext eine Rolle zu (questions.ts ROLE);
 *   die Rollenverteilung fliesst mit 30 % in die Aehnlichkeit ein. Ohne Laya zaehlen nur die Werte.
 * - Verglichen wird innerhalb der Positionsgruppe (Tor, Abwehr, Mittelfeld, Sturm), ab 270 Minuten.
 */

import { askLaya, layaReady } from "./laya/client";
import { ROLE, ROLE_DE, type Role } from "./laya/questions";
import type { SportTeam } from "./sport-ui";

export type Stats = {
  id: string; name: string; jersey: string; pos: string; apps: number; minutes: number; goals: number; assists: number;
  shots: number; shots_on: number; shot_assists: number; passes_ok: number; passes_bad: number; duels_won: number; duels: number;
  tackles: number; interceptions: number; recoveries: number; saves: number; conceded: number; clean_sheets: number;
};
export type PoolPlayer = Stats & { team: SportTeam };
export type Pool = { league: string; players: PoolPlayer[] };
export type Similar = { p: PoolPlayer; score: number; role?: Role };

const MIN_MINUTES = 270;

/** Positionsgruppe aus ESPNs Kuerzel (G, D, M, F bzw. CD-L, AM …) */
export function group(pos: string): "G" | "D" | "M" | "F" {
  const p = pos.toUpperCase();
  if (p === "G" || p === "GK") return "G";
  if (p === "D" || /^(CD|CB|LB|RB|LWB|RWB|SW)/.test(p)) return "D";
  if (p === "F" || /^(F|CF|ST|LW|RW|SS)/.test(p)) return "F";
  return "M";
}

const per90 = (p: Stats, v: number) => (p.minutes > 0 ? v / (p.minutes / 90) : 0);
const ratio = (a: number, b: number) => (b > 0 ? a / b : 0);

/** Merkmale je Spieler (Feldspieler bzw. Torwart) */
function features(p: Stats): number[] {
  if (group(p.pos) === "G") {
    const g = Math.max(1, p.minutes / 90);
    return [p.saves / g, p.conceded / g, ratio(p.clean_sheets, Math.max(1, p.apps)), ratio(p.passes_ok, p.passes_ok + p.passes_bad)];
  }
  return [
    per90(p, p.goals), per90(p, p.assists), per90(p, p.shots), per90(p, p.shots_on), per90(p, p.shot_assists),
    ratio(p.passes_ok, p.passes_ok + p.passes_bad), ratio(p.duels_won, p.duels), per90(p, p.tackles),
    per90(p, p.interceptions), per90(p, p.recoveries), per90(p, p.passes_ok + p.passes_bad),
  ];
}

/** Profil als Text fuer Laya (englisch, wie die Fragen) */
export function profileText(p: Stats) {
  const f = (v: number) => v.toFixed(2);
  const g = group(p.pos);
  const pos = { G: "goalkeeper", D: "defender", M: "midfielder", F: "forward" }[g];
  return `Position: ${pos} (${p.pos}). Per 90 minutes: ${f(per90(p, p.goals))} goals, ${f(per90(p, p.assists))} assists, ` +
    `${f(per90(p, p.shots))} shots, ${f(per90(p, p.shot_assists))} key passes, ${f(per90(p, p.passes_ok + p.passes_bad))} passes ` +
    `(${Math.round(ratio(p.passes_ok, p.passes_ok + p.passes_bad) * 100)}% accurate), duels won ${Math.round(ratio(p.duels_won, p.duels) * 100)}%, ` +
    `${f(per90(p, p.tackles))} tackles, ${f(per90(p, p.interceptions))} interceptions, ${f(per90(p, p.recoveries))} recoveries.`;
}

const cos = (a: number[], b: number[]) => {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
};

/** Rollen der Spieler (Laya), je Spieler-ID; leer ohne Modell */
export async function roles(players: Stats[]): Promise<Map<string, Record<string, number>>> {
  if (!layaReady()) return new Map();
  return askLaya(ROLE, players.map((p) => ({ id: p.id, text: profileText(p) })));
}

export const roleOf = (probs?: Record<string, number>): Role | undefined => {
  if (!probs) return undefined;
  const best = Object.entries(probs).sort((a, b) => b[1] - a[1])[0];
  return best ? (best[0] as Role) : undefined;
};
export const roleName = (r?: Role) => (r ? ROLE_DE[r] : "");

/**
 * Die n aehnlichsten Spieler zu `me` (gleiche Positionsgruppe, ab 270 Minuten). Mit Laya-Rollen, wenn
 * `withRoles` (dauert beim ersten Mal ein paar Sekunden je hundert Spieler).
 */
export async function similar(pool: Pool, me: Stats, n = 6, withRoles = true): Promise<Similar[]> {
  const g = group(me.pos);
  const cands = pool.players.filter((p) => group(p.pos) === g && p.minutes >= MIN_MINUTES && p.id !== me.id);
  if (!cands.length || me.minutes <= 0) return [];
  // z-Werte je Merkmal ueber die Gruppe
  const all = [me, ...cands].map(features);
  const k = all[0].length;
  const mean = Array.from({ length: k }, (_, i) => all.reduce((a, f) => a + f[i], 0) / all.length);
  const sd = Array.from({ length: k }, (_, i) => Math.sqrt(all.reduce((a, f) => a + (f[i] - mean[i]) ** 2, 0) / all.length) || 1);
  const z = (f: number[]) => f.map((v, i) => (v - mean[i]) / sd[i]);
  const mine = z(all[0]);
  const rl = withRoles ? await roles([me, ...cands]) : new Map<string, Record<string, number>>();
  const rv = (id: string) => { const r = rl.get(id); return r ? Object.keys(ROLE.role.criteria).map((c) => r[c] ?? 0) : null; };
  const myRole = rv(me.id);
  return cands
    .map((p, i) => {
      // Werte: Kosinus der z-Vektoren (-1..1) -> 0..1; Rollen: Kosinus der Wahrscheinlichkeiten
      const s = (cos(mine, z(all[i + 1])) + 1) / 2;
      const r = rv(p.id);
      const score = myRole && r ? 0.7 * s + 0.3 * cos(myRole, r) : s;
      return { p, score, role: roleOf(rl.get(p.id)) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
}

/** Rolle eines einzelnen Spielers (fuer die Spielerkarte) */
export async function roleFor(p: Stats): Promise<Role | undefined> {
  return roleOf((await roles([p])).get(p.id));
}
