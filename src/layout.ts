// Anordnung der Karten in der Live-Ansicht: zwei Spalten (breit: Hauptspalte, schmal: Seitenspalte), jede stapelt
// ihre Karten ohne Luecken. Die Standard-Anordnung haengt von der Spielphase ab (nach „Dashboard Design Patterns“:
// das Wichtigste der Situation oben links) — vor dem Spiel Prognose, Form und direkter Vergleich, waehrend des
// Spiels Spielfeld, Statistik und Ticker, danach Statistik und Analyse. Wer umstellt, aendert nur die Anordnung
// dieser Sportart in dieser Phase; „Standard“ nimmt sie zurueck.

export type CardId = "field" | "ticker" | "odds" | "form" | "h2h" | "pulse" | "stats" | "radar" | "lineup" | "stadium";
export type Phase = "pre" | "in" | "post";
export type Lanes = { main: CardId[]; side: CardId[]; hidden: CardId[] };

export const CARD_NAME: Record<CardId, string> = {
  field: "Spielfeld", ticker: "Ticker", odds: "Prognose", form: "Form", h2h: "Direkter Vergleich", pulse: "Druckphasen",
  stats: "Statistik", radar: "Teamvergleich", lineup: "Aufstellung", stadium: "Stadion",
};

const DEFAULT: Record<Phase, Lanes> = {
  pre: { main: ["odds", "form", "field", "radar", "stats"], side: ["h2h", "lineup", "stadium", "ticker"], hidden: ["pulse"] },
  in: { main: ["field", "stats", "pulse", "radar"], side: ["ticker", "lineup", "stadium"], hidden: ["odds", "form", "h2h"] },
  post: { main: ["stats", "radar", "pulse", "field"], side: ["ticker", "lineup", "stadium", "h2h"], hidden: ["odds", "form"] },
};

const KEY = "arena-layout-v1";

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

/** Standard dieser Sportart und Phase: Basketball stellt das Wurfbild nach dem Spiel nach vorn */
function standard(sport: string, state: string): Lanes {
  const d = DEFAULT[phaseOf(state)];
  const out = { main: [...d.main], side: [...d.side], hidden: [...d.hidden] };
  if (sport === "basketball" && phaseOf(state) === "post") out.main = ["field", ...out.main.filter((x) => x !== "field")];
  return out;
}

/** Anordnung fuer die vorhandenen Karten: gespeicherte (sonst Standard); neue Karten an ihren Standardplatz */
export function arrange(sport: string, state: string, have: CardId[]): Lanes & { custom: boolean } {
  const def = standard(sport, state);
  const saved = load()[slot(sport, state)];
  const base = saved ?? def;
  const ok = (ids: unknown) => (Array.isArray(ids) ? ids : []).filter((x): x is CardId => have.includes(x as CardId));
  const out: Lanes = { main: ok(base.main), side: ok(base.side), hidden: ok(base.hidden) };
  const seen = new Set([...out.main, ...out.side, ...out.hidden]);
  for (const id of have) {
    if (seen.has(id)) continue;
    const lane = def.main.includes(id) ? "main" : def.side.includes(id) ? "side" : "hidden";
    out[lane].push(id);
  }
  return { ...out, custom: !!saved };
}

export function save(sport: string, state: string, lanes: Lanes) {
  const all = load();
  all[slot(sport, state)] = { main: [...lanes.main], side: [...lanes.side], hidden: [...lanes.hidden] };
  store(all);
}

export function reset(sport: string, state: string) {
  const all = load();
  delete all[slot(sport, state)];
  store(all);
}

/** Karte bewegen: dy = -1/1 innerhalb der Spalte, swap = in die andere Spalte (oben einreihen) */
export function move(l: Lanes, id: CardId, how: "up" | "down" | "swap" | "hide" | "show"): Lanes {
  const out: Lanes = { main: [...l.main], side: [...l.side], hidden: [...l.hidden] };
  const lane = (["main", "side", "hidden"] as const).find((k) => out[k].includes(id));
  if (!lane) return out;
  const list = out[lane];
  const i = list.indexOf(id);
  if (how === "up" && i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]];
  else if (how === "down" && i < list.length - 1) [list[i + 1], list[i]] = [list[i], list[i + 1]];
  else if (how === "swap" && lane !== "hidden") { list.splice(i, 1); out[lane === "main" ? "side" : "main"].unshift(id); }
  else if (how === "hide" && lane !== "hidden") { list.splice(i, 1); out.hidden.push(id); }
  else if (how === "show" && lane === "hidden") { list.splice(i, 1); out.main.push(id); }
  return out;
}

export const PHASE_NAME: Record<Phase, string> = { pre: "vor dem Spiel", in: "während des Spiels", post: "nach dem Spiel" };
export { phaseOf };
