// Anordnung der Karten in der Live-Ansicht: oben eine volle Breite (das Spielfeld — die groesste Karte), darunter
// zwei Spalten, jede stapelt ihre Karten ohne Luecken. Die Standard-Anordnung haengt von der Spielphase ab (nach
// „Dashboard Design Patterns“: das Wichtigste der Situation zuerst) und haelt zusammen, was zusammengehoert:
//   Spielfeld + Aufstellung (vor dem Spiel steht die Aufstellung auf dem Feld), Statistik + Teamvergleich
//   (dieselben Zahlen, einmal als Radar), Ticker + Druckphasen (der Verlauf), Prognose + Form + Vergleich
//   (Einschaetzung vor dem Spiel), Aufstellung + letzte Aufstellungen.
// Wer umstellt, aendert nur die Anordnung dieser Sportart in dieser Phase; „Standard“ nimmt sie zurueck.

export type CardId = "field" | "ticker" | "odds" | "form" | "h2h" | "pulse" | "stats" | "radar" | "lineup" | "stadium" | "history";
export type Phase = "pre" | "in" | "post";
export type Lanes = { hero: CardId[]; main: CardId[]; side: CardId[]; hidden: CardId[] };
type Lane = keyof Lanes;
const LANES: Lane[] = ["hero", "main", "side", "hidden"];

export const CARD_NAME: Record<CardId, string> = {
  field: "Spielfeld", ticker: "Ticker", odds: "Prognose", form: "Form", h2h: "Direkter Vergleich", pulse: "Druckphasen",
  stats: "Statistik", radar: "Teamvergleich", lineup: "Aufstellung", stadium: "Stadion", history: "Letzte Aufstellungen",
};

const DEFAULT: Record<Phase, Lanes> = {
  // vor dem Spiel: wer spielt (Aufstellung auf dem Feld), dann die Einschaetzung, dann die Teamstaerke
  pre: { hero: ["field"], main: ["odds", "form", "h2h", "stats", "radar"], side: ["lineup", "history", "stadium"], hidden: ["ticker", "pulse"] },
  // waehrend des Spiels: Feld, Zahlen (Statistik + Radar), Verlauf (Ticker + Druckphasen)
  in: { hero: ["field"], main: ["stats", "radar", "pulse"], side: ["ticker", "lineup", "stadium"], hidden: ["odds", "form", "h2h", "history"] },
  // danach: das ganze Spiel auf dem Feld, die Bilanz, der Verlauf
  post: { hero: ["field"], main: ["stats", "radar", "pulse"], side: ["ticker", "lineup", "history", "stadium"], hidden: ["odds", "form", "h2h"] },
};

// v2: volle Breite fuer das Spielfeld (Anordnungen aus v1 gelten nicht mehr)
const KEY = "arena-layout-v2";

function load(): Record<string, Lanes> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function store(all: Record<string, Lanes>) {
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* ohne Speicher gilt der Standard */ }
}

const phaseOf = (state: string): Phase => (state === "in" ? "in" : state === "post" ? "post" : "pre");
const slot = (sport: string, state: string) => `${sport}:${phaseOf(state)}`;

/** Standard dieser Sportart und Phase */
function standard(_sport: string, state: string): Lanes {
  const d = DEFAULT[phaseOf(state)];
  return { hero: [...d.hero], main: [...d.main], side: [...d.side], hidden: [...d.hidden] };
}

/** Anordnung fuer die vorhandenen Karten: gespeicherte (sonst Standard); neue Karten an ihren Standardplatz.
 * Ohne Spielfeld (z. B. Eishockey) bleibt die volle Breite leer. */
export function arrange(sport: string, state: string, have: CardId[]): Lanes & { custom: boolean } {
  const def = standard(sport, state);
  const saved = load()[slot(sport, state)];
  const base: Partial<Lanes> = saved ?? def;
  const ok = (ids: unknown) => (Array.isArray(ids) ? ids : []).filter((x): x is CardId => have.includes(x as CardId));
  const out: Lanes = { hero: ok(base.hero), main: ok(base.main), side: ok(base.side), hidden: ok(base.hidden) };
  const seen = new Set(LANES.flatMap((k) => out[k]));
  for (const id of have) {
    if (seen.has(id)) continue;
    out[LANES.find((k) => def[k].includes(id)) ?? "hidden"].push(id);
  }
  return { ...out, custom: !!saved };
}

export function save(sport: string, state: string, lanes: Lanes) {
  const all = load();
  all[slot(sport, state)] = { hero: [...lanes.hero], main: [...lanes.main], side: [...lanes.side], hidden: [...lanes.hidden] };
  store(all);
}

export function reset(sport: string, state: string) {
  const all = load();
  delete all[slot(sport, state)];
  store(all);
}

/** Karte bewegen: hoch/runter in ihrer Reihe, in die andere Spalte, volle Breite an/aus, aus-/einblenden */
export function move(l: Lanes, id: CardId, how: "up" | "down" | "swap" | "wide" | "hide" | "show"): Lanes {
  const out: Lanes = { hero: [...l.hero], main: [...l.main], side: [...l.side], hidden: [...l.hidden] };
  const lane = LANES.find((k) => out[k].includes(id));
  if (!lane) return out;
  const list = out[lane];
  const i = list.indexOf(id);
  const to = (k: Lane, top = false) => { list.splice(i, 1); if (top) out[k].unshift(id); else out[k].push(id); };
  if (how === "up" && i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]];
  else if (how === "down" && i < list.length - 1) [list[i + 1], list[i]] = [list[i], list[i + 1]];
  else if (how === "swap" && (lane === "main" || lane === "side")) to(lane === "main" ? "side" : "main", true);
  else if (how === "wide") to(lane === "hero" ? "main" : "hero", lane === "hero");
  else if (how === "hide" && lane !== "hidden") to("hidden");
  else if (how === "show" && lane === "hidden") to("main");
  return out;
}

export const PHASE_NAME: Record<Phase, string> = { pre: "vor dem Spiel", in: "während des Spiels", post: "nach dem Spiel" };
export { phaseOf };
