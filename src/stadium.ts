/**
 * Stadion des Spiels, gezeichnet von oben und von der Seite (Daten: more.rs — Wikidata + OpenStreetMap).
 *
 * - Von oben: der echte Grundriss aus OpenStreetMap (leisure=stadium) mit dem Spielfeld darin, massstabsgetreu
 *   und genordet. Ohne OSM-Treffer ein schematisches Rund um ein Feld in Normgroesse.
 * - Von der Seite: Schnitt durch die Tribuenen; die Zahl der Raenge folgt der Kapazitaet (bis 15.000 einer,
 *   bis 40.000 zwei, darueber drei), dazu das Dach. Was die Wikipedia-Einleitung als Besonderheit nennt, steht
 *   in der Zeichnung: Laufbahn (Abstand zum Feld), Stehplaetze (steile Stehtribuene, Punkte), schliessbares Dach
 *   (Dachhaelften mit Spalt und gestrichelter Schliesslinie), herausfahrbarer Rasen, leuchtende Fassade.
 * - Foto (Wikimedia Commons) mit Urheberseite, Platzzahl gross mit einem Punkt je 1.000 Plaetze, Architekt,
 *   Baukosten, Superlativ und die ersten Saetze der Wikipedia.
 */

export type Features = { track: boolean; retractable: boolean; slide_pitch: boolean; standing: number; lit_facade: boolean; record: string };
export type Venue = {
  name: string; city: string; capacity: number; opened: string; lat: number; lon: number;
  outline: [number, number][]; pitch: [number, number][]; wikidata: string;
  photo: string; photo_page: string; architect: string; cost_eur: number; about: string; wiki_url: string; features: Features;
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

/** Seitenansicht: Schnitt durch beide Tribuenen, Raenge nach Kapazitaet, Besonderheiten eingezeichnet */
function sideView(v: Venue | null, accent: string) {
  const W = 220, H = 84, G = 70;
  const f = v?.features;
  const cap = v?.capacity ?? 0;
  const tiers = cap === 0 ? 0 : cap <= 15000 ? 1 : cap <= 40000 ? 2 : 3;
  const svg = sv("svg", { viewBox: `0 0 ${W} ${H}`, class: "st-side", role: "img" });
  const said: string[] = [tiers ? `${tiers} ${tiers === 1 ? "Rang" : "Ränge"}` : ""];
  // Laufbahn: die Tribuenen ruecken vom Feld ab
  const edge = f?.track ? 52 : 64;
  svg.append(sv("line", { x1: 4, y1: G, x2: W - 4, y2: G, class: "st-ground" }));
  svg.append(sv("line", { x1: 68, y1: G - 0.6, x2: W - 68, y2: G - 0.6, class: "st-turf" }));
  if (f?.track) {
    for (const x of [edge + 2, W - 68]) svg.append(sv("line", { x1: x, y1: G - 0.5, x2: x + 14 - 2, y2: G - 0.5, class: "st-track" }));
    said.push("Laufbahn");
  }
  if (f?.slide_pitch) {
    // Rasen faehrt unter der Tribuene hinaus
    svg.append(sv("path", { d: `M${W - 68} ${G + 4} L${W - 8} ${G + 4}`, class: "st-slide" }), sv("path", { d: `M${W - 14} ${G + 1.5} L${W - 8} ${G + 4} L${W - 14} ${G + 6.5}`, class: "st-slide" }));
    said.push("herausfahrbarer Rasen");
  }
  const shown = Math.max(1, tiers);
  let roofTop = G;
  for (const right of [false, true]) {
    const X = (x: number) => (right ? W - x : x);
    // rechts die Stehtribuene, wenn es eine gibt: steiler und mit Punkten
    const stand = !!f?.standing && right;
    let d = `M${X(edge)} ${G}`;
    let x = edge, y = G;
    for (let t = 0; t < shown; t++) {
      const run = (stand ? 11 : 16) - t * 2, rise = (stand ? 12 : 9) + t * 3;
      d += ` L${X(x - run)} ${y - rise}`;
      x -= run; y -= rise;
      if (t < shown - 1) { d += ` L${X(x - 3)} ${y}`; x -= 3; }
    }
    d += ` L${X(x - 4)} ${y} L${X(x - 4)} ${G} Z`;
    const tier = sv("path", { d, class: `st-tier${tiers ? "" : " dim"}${stand ? " standing" : ""}` });
    svg.append(tier);
    if (f?.lit_facade) svg.append(sv("line", { x1: X(x - 4), y1: y, x2: X(x - 4), y2: G, class: "st-facade", stroke: accent }));
    if (stand) {
      // Stehende als Punkte auf den Stufen
      for (let i = 0; i < 18; i++) {
        const t = (i + 0.5) / 18;
        svg.append(sv("circle", { cx: X(edge - t * (edge - x - 4)), cy: G - t * (G - y) - 1.6, r: 0.9, class: "st-fan" }));
      }
    }
    roofTop = y;
    const roofY = y - 6;
    if (f?.retractable) {
      // Dachhaelften mit Spalt; gestrichelt, wo sich das Dach schliesst
      svg.append(sv("path", { d: `M${X(x - 6)} ${roofY + 2} L${X(86)} ${roofY - 4}`, class: "st-roof" }));
    } else {
      svg.append(sv("path", { d: `M${X(x - 6)} ${roofY + 2} L${X(76)} ${roofY - 3}`, class: `st-roof${tiers ? "" : " dim"}` }));
    }
    svg.append(sv("line", { x1: X(x - 4), y1: roofY + 2, x2: X(x - 4), y2: y, class: `st-post${tiers ? "" : " dim"}` }));
  }
  if (f?.retractable) {
    const y = roofTop - 10;
    svg.append(sv("line", { x1: 86, y1: y, x2: W - 86, y2: y, class: "st-roof-close" }));
    said.push("schließbares Dach");
  }
  if (f?.standing) {
    const t = sv("text", { x: W - 8, y: G + 9, "text-anchor": "end", class: "st-label" });
    t.textContent = f.standing > 1 ? `${f.standing.toLocaleString("de-DE")} Stehplätze` : "Stehplätze";
    svg.append(t);
    said.push("Stehtribüne");
  }
  if (f?.lit_facade) said.push("leuchtende Fassade");
  svg.setAttribute("aria-label", `Seitenansicht${said.filter(Boolean).length ? ": " + said.filter(Boolean).join(", ") : ""}`);
  return svg;
}

/** Besonderheiten als kleine Marken */
function featureChips(f: Features | undefined) {
  const box = el("div", "st-feats");
  if (!f) return box;
  const add = (t: string, cls = "") => box.append(el("span", `st-feat ${cls}`.trim(), t));
  if (f.standing) add(f.standing > 1 ? `${f.standing.toLocaleString("de-DE")} Stehplätze` : "Stehplätze", "hot");
  if (f.retractable) add("Dach schließbar");
  if (f.slide_pitch) add("Rasen fährt hinaus");
  if (f.track) add("Laufbahn");
  if (f.lit_facade) add("Leuchtfassade");
  return box;
}

/** Ein Punkt je 1.000 Plaetze (hoechstens 100), in Reihen zu 20 */
function seatDots(cap: number) {
  const box = el("div", "st-dots");
  const n = Math.min(100, Math.round(cap / 1000));
  for (let i = 0; i < n; i++) box.append(el("i"));
  box.title = `${cap.toLocaleString("de-DE")} Plätze · ein Punkt je 1.000`;
  return box;
}

const euro = (n: number) => (n >= 1e9 ? `${(n / 1e9).toLocaleString("de-DE", { maximumFractionDigits: 1 })} Mrd. €` : `${Math.round(n / 1e6).toLocaleString("de-DE")} Mio. €`);

/** open: Link oeffnen (Tauri, im Browser) */
export function stadiumBody(v: Venue | null, sport: string, fallbackName: string, city: string, loading: boolean, accent = "#75b8ff", open?: (url: string) => void) {
  const wrap = el("div", "stadium");
  if (v?.photo) {
    const fig = el("figure", "st-photo");
    const img = el("img");
    img.src = v.photo;
    img.alt = v.name;
    img.loading = "lazy";
    img.onerror = () => fig.remove();
    const cap = el("button", "st-credit", "Foto: Wikimedia Commons");
    cap.title = "Urheber und Lizenz auf Wikimedia Commons";
    cap.onclick = () => open?.(v.photo_page);
    fig.append(img, cap);
    wrap.append(fig);
  }
  const views = el("div", "st-views");
  views.append(topView(v, sport), sideView(v, accent));
  const facts = el("div", "st-facts");
  const name = v?.name || fallbackName;
  facts.append(el("b", "st-name", name || "Stadion unbekannt"));
  const where = [v?.city || city, v?.opened ? `eröffnet ${v.opened}` : ""].filter(Boolean).join(" · ");
  if (where) facts.append(el("span", "st-where", where));
  if (v?.features.record) facts.append(el("span", "st-record", v.features.record));
  const cap = el("div", "st-cap");
  cap.append(el("b", "", v?.capacity ? v.capacity.toLocaleString("de-DE") : loading ? "…" : "–"), el("small", "", "Plätze"));
  facts.append(cap);
  if (v?.capacity) facts.append(seatDots(v.capacity));
  facts.append(featureChips(v?.features));
  const more = [v?.architect ? `Architekt: ${v.architect.replace(/^Architekt(en)?\s+/i, "")}` : "", v?.cost_eur ? `Baukosten: ${euro(v.cost_eur)}` : ""].filter(Boolean).join(" · ");
  if (more) facts.append(el("span", "st-where", more));
  wrap.append(views, facts);
  if (v?.about) {
    const about = el("p", "st-about", v.about);
    if (v.wiki_url) {
      const a = el("button", "st-wiki", "Wikipedia");
      a.title = "Ganzer Artikel in der Wikipedia";
      a.onclick = () => open?.(v.wiki_url);
      about.append(" ", a);
    }
    wrap.append(about);
  }
  return wrap;
}
