/**
 * Stadion des Spiels, gezeichnet von oben und von der Seite (Daten: more.rs — Wikidata + OpenStreetMap).
 *
 * - Von oben: der echte Grundriss aus OpenStreetMap (leisure=stadium) mit dem Spielfeld darin, massstabsgetreu
 *   und genordet. Ohne OSM-Treffer ein schematisches Rund um ein Feld in Normgroesse.
 * - Von der Seite: Schnitt durch die Tribuenen; die Zahl der Raenge folgt der Kapazitaet (bis 15.000 einer,
 *   bis 40.000 zwei, darueber drei), dazu das Dach.
 * - Platzzahl gross, darunter ein Punkt je 1.000 Plaetze.
 */

export type Venue = {
  name: string; city: string; capacity: number; opened: string; lat: number; lon: number;
  outline: [number, number][]; pitch: [number, number][]; wikidata: string;
};

const SVGNS = "http://www.w3.org/2000/svg";
function sv<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}) {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, String(attrs[k]));
  return e;
}
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

const poly = (pts: [number, number][]) => pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");

/** Draufsicht: Grundriss in ein 200 × 130-Feld einpassen */
function topView(v: Venue | null, sport: string) {
  const W = 200, H = 130, PAD = 8;
  const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, class: "st-top", role: "img" });
  svg.setAttribute("aria-label", v?.outline.length ? `Grundriss von ${v.name} (OpenStreetMap)` : "Stadion von oben (schematisch)");
  if (v?.outline.length) {
    const all = [...v.outline, ...v.pitch];
    const xs = all.map((p) => p[0]), ys = all.map((p) => p[1]);
    const [minx, maxx, miny, maxy] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const k = Math.min((W - 2 * PAD) / Math.max(1, maxx - minx), (H - 2 * PAD) / Math.max(1, maxy - miny));
    const map = (p: [number, number]): [number, number] => [PAD + (p[0] - minx) * k + ((W - 2 * PAD) - (maxx - minx) * k) / 2, PAD + (p[1] - miny) * k + ((H - 2 * PAD) - (maxy - miny) * k) / 2];
    svg.append(sv("polygon", { points: poly(v.outline.map(map)), class: "st-stand" }));
    if (v.pitch.length) svg.append(sv("polygon", { points: poly(v.pitch.map(map)), class: `st-field ${sport}` }));
    // Massstab: 50 m
    const m50 = 50 * k;
    svg.append(sv("line", { x1: W - PAD - m50, y1: H - 3, x2: W - PAD, y2: H - 3, class: "st-scale" }));
    const t = sv("text", { x: W - PAD - m50 / 2, y: H - 5.5, "text-anchor": "middle", class: "st-scale-t" });
    t.textContent = "50 m";
    svg.append(t);
  } else {
    // schematisch: Rund (Tribuenen) um ein Feld 105 × 68 (Fussball) bzw. 28 × 15 (Halle)
    svg.append(sv("rect", { x: 14, y: 10, width: W - 28, height: H - 20, rx: 38, class: "st-stand dim" }));
    const f = sport === "soccer" ? [105, 68] : [56, 30];
    const k = Math.min((W - 76) / f[0], (H - 56) / f[1]);
    svg.append(sv("rect", { x: (W - f[0] * k) / 2, y: (H - f[1] * k) / 2, width: f[0] * k, height: f[1] * k, rx: 2, class: `st-field ${sport}` }));
  }
  return svg;
}

/** Seitenansicht: Schnitt durch beide Tribuenen, Raenge nach Kapazitaet */
function sideView(v: Venue | null) {
  const W = 200, H = 70, G = 60;
  const cap = v?.capacity ?? 0;
  const tiers = cap === 0 ? 0 : cap <= 15000 ? 1 : cap <= 40000 ? 2 : 3;
  const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, class: "st-side", role: "img" });
  svg.setAttribute("aria-label", tiers ? `Seitenansicht: ${tiers} ${tiers === 1 ? "Rang" : "Ränge"}` : "Seitenansicht");
  svg.append(sv("line", { x1: 4, y1: G, x2: W - 4, y2: G, class: "st-ground" }));
  svg.append(sv("line", { x1: 62, y1: G - 0.6, x2: W - 62, y2: G - 0.6, class: "st-turf" }));
  const shown = Math.max(1, tiers);
  for (const right of [false, true]) {
    const X = (x: number) => (right ? W - x : x);
    // Raenge als Stufen: jeder Rang steiler und hoeher (Rang 1 unten, nahe am Feld)
    let d = `M${X(62)} ${G}`;
    let x = 62, y = G;
    for (let t = 0; t < shown; t++) {
      const run = 16 - t * 2, rise = 9 + t * 3;
      d += ` L${X(x - run)} ${y - rise}`;
      x -= run; y -= rise;
      if (t < shown - 1) { d += ` L${X(x - 3)} ${y}`; x -= 3; }
    }
    d += ` L${X(x - 4)} ${y} L${X(x - 4)} ${G} Z`;
    svg.append(sv("path", { d, class: `st-tier${tiers ? "" : " dim"}` }));
    // Dach ueber die Raenge, leicht ueber das Feld hinaus
    const roofY = y - 6;
    svg.append(sv("path", { d: `M${X(x - 6)} ${roofY + 2} L${X(70)} ${roofY - 3}`, class: `st-roof${tiers ? "" : " dim"}` }));
    svg.append(sv("line", { x1: X(x - 4), y1: roofY + 2, x2: X(x - 4), y2: y, class: `st-post${tiers ? "" : " dim"}` }));
  }
  return svg;
}

/** Ein Punkt je 1.000 Plaetze (hoechstens 100), in Reihen zu 20 */
function seatDots(cap: number) {
  const box = el("div", "st-dots");
  const n = Math.min(100, Math.round(cap / 1000));
  for (let i = 0; i < n; i++) box.append(el("i"));
  box.title = `${cap.toLocaleString("de-DE")} Plätze · ein Punkt je 1.000`;
  return box;
}

export function stadiumBody(v: Venue | null, sport: string, fallbackName: string, city: string, loading: boolean) {
  const wrap = el("div", "stadium");
  const views = el("div", "st-views");
  views.append(topView(v, sport), sideView(v));
  const facts = el("div", "st-facts");
  const name = v?.name || fallbackName;
  facts.append(el("b", "st-name", name || "Stadion unbekannt"));
  const where = [v?.city || city, v?.opened ? `eröffnet ${v.opened}` : ""].filter(Boolean).join(" · ");
  if (where) facts.append(el("span", "st-where", where));
  const cap = el("div", "st-cap");
  cap.append(el("b", "", v?.capacity ? v.capacity.toLocaleString("de-DE") : loading ? "…" : "–"), el("small", "", "Plätze"));
  facts.append(cap);
  if (v?.capacity) facts.append(seatDots(v.capacity));
  wrap.append(views, facts);
  return wrap;
}
