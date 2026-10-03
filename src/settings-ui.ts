/**
 * Sport-Einstellungen in Arena — dieselben wie in der Notch (Einstellungen › Sport) und mit ihr abgeglichen
 * (settings.rs). Wappen statt Vereinsnamen, kurze Texte.
 */

import { invoke } from "@tauri-apps/api/core";

export type SportExpand = "off" | "goals" | "important" | "all";
export type FavTeam = { key: string; name: string; logo?: string };
export type SportSettings = {
  on: boolean;
  leagues: string[];
  teams: FavTeam[];
  scope: "all" | "fav";
  expand: SportExpand;
  center: boolean;
  pitch: boolean;
  fullscreen: boolean;
};
export type Snapshot = { sport: SportSettings; notch: boolean; pending: boolean };
export type LeagueInfo = { id: string; name: string; group: string; sport: string; source: string };
type TeamInfo = { key: string; name: string; logo: string };

export const DEFAULT_SPORT: SportSettings = {
  on: true, leagues: ["bl1", "dfbteam"], teams: [], scope: "all", expand: "goals", center: true, pitch: true, fullscreen: true,
};

const EXPAND: [SportExpand, string, string][] = [
  ["off", "Nie", "nur der Spielstand in der Mitte"],
  ["goals", "Toren", "Tore und Rote Karten"],
  ["important", "Wichtigem", "dazu Anpfiff, Halbzeit, Abpfiff, Elfmeter, Videobeweis"],
  ["all", "Allem", "dazu Gelbe Karten, Wechsel, Pfosten"],
];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** Wappen; Name im Tooltip. Ohne Bild das Kuerzel. */
export function crestOf(t: { name: string; logo?: string }, cls = "crest") {
  const c = el("span", cls);
  c.title = t.name;
  c.setAttribute("role", "img");
  c.setAttribute("aria-label", t.name);
  const mono = () => {
    c.classList.add("mono");
    c.textContent = t.name.replace(/^(1\.|FC|SV|VfB|VfL|TSG|SC|FSV|SpVgg)\s+/i, "").slice(0, 3).toUpperCase();
  };
  if (t.logo) {
    const i = new Image();
    i.alt = "";
    i.decoding = "async";
    i.src = t.logo;
    i.onerror = () => { i.remove(); mono(); };
    c.append(i);
  } else mono();
  return c;
}

function card(title: string) {
  const c = el("section", "s-card n-card");
  const h = el("div", "s-head");
  h.append(el("span", "n-eyebrow", title));
  c.append(h);
  return c;
}

function toggle(label: string, on: boolean, set: (v: boolean) => void, tip = "") {
  const row = el("label", "toggle-row");
  if (tip) row.title = tip;
  const inp = el("input");
  inp.type = "checkbox";
  inp.checked = on;
  inp.setAttribute("role", "switch");
  inp.addEventListener("change", () => set(inp.checked));
  row.append(el("span", "", label), inp, el("span", "n-switch"));
  return row;
}

function seg<T extends string>(opts: [T, string][], value: T, set: (v: T) => void) {
  const s = el("div", "n-seg");
  for (const [v, label] of opts) {
    const b = el("button", v === value ? "active" : "", label);
    b.addEventListener("click", () => {
      s.querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
      set(v);
    });
    s.append(b);
  }
  return s;
}

let picking = false;
let teamLeague = "";
const teamCache = new Map<string, TeamInfo[]>();

export type SettingsCtx = {
  leagues: LeagueInfo[];
  snap: Snapshot;
  commit: (s: SportSettings) => void;
  announce: (t: string) => void;
};

export function renderSettings(box: HTMLElement, ctx: SettingsCtx) {
  const s: SportSettings = JSON.parse(JSON.stringify(ctx.snap.sport));
  const save = () => ctx.commit(s);
  const again = () => renderSettings(box, { ...ctx, snap: { ...ctx.snap, sport: s } });
  const parts: HTMLElement[] = [];

  // Abgleich mit der Notch
  const sync = el("div", "sync-line " + (ctx.snap.notch ? "ok" : ctx.snap.pending ? "wait" : "off"));
  sync.append(el("i", "dot"), ctx.snap.notch ? "Mit der Notch abgeglichen"
    : ctx.snap.pending ? "Notch läuft nicht – Änderungen gehen beim nächsten Start hin" : "Notch läuft nicht – Arena nutzt ihre eigenen Einstellungen");
  parts.push(sync);

  // Deine Teams: Wappen; „Hinzufügen“ oeffnet das Wappen-Raster
  const teams = card("Deine Teams");
  const open = picking || !s.teams.length;
  const add = el("button", "s-act", open ? "Fertig" : "Hinzufügen");
  add.hidden = !s.teams.length;
  add.addEventListener("click", () => { picking = !picking; again(); });
  teams.querySelector(".s-head")!.append(add);
  if (s.teams.length) {
    const row = el("div", "crest-row");
    for (const t of s.teams) {
      const b = el("button", "crest-tile n-liquid");
      b.title = `${t.name} – entfernen`;
      b.setAttribute("aria-label", `${t.name} entfernen`);
      b.append(crestOf(t), el("i", "x", "×"));
      b.addEventListener("click", () => { s.teams = s.teams.filter((x) => x.key !== t.key); save(); ctx.announce(`${t.name} entfernt`); again(); });
      row.append(b);
    }
    teams.append(row);
  }
  if (open) {
    if (!s.teams.length) teams.append(el("p", "s-hint", "Wappen antippen – Spiele deiner Teams stehen dann vorn."));
    const pick = el("div", "team-pick");
    const sel = el("select", "n-input") as HTMLSelectElement;
    for (const l of ctx.leagues) {
      const o = el("option", "", l.name) as HTMLOptionElement;
      o.value = l.id;
      sel.append(o);
    }
    if (!teamLeague) teamLeague = s.leagues[0] ?? ctx.leagues[0]?.id ?? "bl1";
    sel.value = teamLeague;
    const find = el("input", "n-input") as HTMLInputElement;
    find.type = "search";
    find.placeholder = "Suchen";
    find.spellcheck = false;
    const grid = el("div", "crest-grid");
    const show = () => {
      const list = teamCache.get(teamLeague);
      grid.replaceChildren();
      if (!list) { grid.append(el("small", "faint", "Wird geladen …")); return; }
      const qx = find.value.trim().toLowerCase();
      const hits = list.filter((t) => !s.teams.some((x) => x.key === t.key) && (!qx || t.name.toLowerCase().includes(qx)));
      if (!hits.length) grid.append(el("small", "faint", list.length ? "Kein Treffer" : "Keine Mannschaften"));
      for (const t of hits) {
        const b = el("button", "crest-pick");
        b.title = t.name;
        b.setAttribute("aria-label", `${t.name} hinzufügen`);
        b.append(crestOf(t));
        b.addEventListener("click", () => {
          s.teams = [...s.teams, { key: t.key, name: t.name, ...(t.logo ? { logo: t.logo } : {}) }];
          picking = true;
          save();
          ctx.announce(`${t.name} hinzugefügt`);
          again();
          (box.querySelector(".team-pick input") as HTMLInputElement | null)?.focus();
        });
        grid.append(b);
      }
    };
    const load = () => {
      show();
      if (teamCache.has(teamLeague)) return;
      const want = teamLeague;
      invoke<TeamInfo[]>("sport_teams", { league: want })
        .then((t) => { teamCache.set(want, t); if (teamLeague === want) show(); })
        .catch((e) => { if (teamLeague === want) grid.replaceChildren(el("small", "faint", `Nicht erreichbar: ${e}`)); });
    };
    sel.addEventListener("change", () => { teamLeague = sel.value; load(); });
    find.addEventListener("input", show);
    pick.append(sel, find);
    teams.append(pick, grid);
    if (ctx.leagues.length) queueMicrotask(load);
  }
  parts.push(teams);

  // Wettbewerbe
  const comp = card("Wettbewerbe");
  for (const g of [...new Set(ctx.leagues.map((l) => l.group))]) {
    const chips = el("div", "chips");
    for (const l of ctx.leagues.filter((x) => x.group === g)) {
      const b = el("button", "", l.name);
      b.setAttribute("aria-pressed", String(s.leagues.includes(l.id)));
      b.addEventListener("click", () => {
        s.leagues = s.leagues.includes(l.id) ? s.leagues.filter((x) => x !== l.id) : [...s.leagues, l.id];
        b.setAttribute("aria-pressed", String(s.leagues.includes(l.id)));
        save();
      });
      chips.append(b);
    }
    comp.append(el("small", "chip-group", g), chips);
  }
  parts.push(comp);

  // In der Notch
  const notch = card("In der Notch");
  notch.append(toggle("Live-Sport in der Notch", s.on, (v) => { s.on = v; save(); }));
  notch.append(seg<"all" | "fav">([["all", "Alle Spiele"], ["fav", "Nur meine Teams"]], s.scope, (v) => { s.scope = v; save(); }));
  const ex = el("div", "field");
  const hint = el("small", "", EXPAND.find((x) => x[0] === s.expand)?.[2] ?? "");
  ex.append(el("span", "", "Aufklappen bei"), seg(EXPAND.map(([v, l]) => [v, l] as [SportExpand, string]), s.expand, (v) => {
    s.expand = v;
    hint.textContent = EXPAND.find((x) => x[0] === v)?.[2] ?? "";
    save();
  }), hint);
  notch.append(ex,
    toggle("Spielstand in der Mitte", s.center, (v) => { s.center = v; save(); }),
    toggle("Spielfeld mit Ballverlauf", s.pitch, (v) => { s.pitch = v; save(); }, "Lädt nur, solange das Spielfeld zu sehen ist (etwa 10–15 MB pro Stunde)."),
    toggle("Tore auch im Vollbild", s.fullscreen, (v) => { s.fullscreen = v; save(); }, "Nur wenn die Notch im Vollbild am Rand bleibt."));
  parts.push(notch);

  const src = el("details", "fine-more");
  src.append(el("summary", "", "Daten: ESPN · OpenLigaDB"),
    el("p", "", "Beide frei abrufbar, ohne Konto. ESPN ist inoffiziell und kann sich ändern; OpenLigaDB wird von der Community gepflegt (3. Liga, Frauen-Bundesliga, Ersatz für Bundesliga und Pokal). Echte Positionen aller Spieler gibt es live nirgends frei – das Spielfeld zeigt den Ballverlauf mit Rückennummern."));
  parts.push(src);
  box.replaceChildren(...parts);
}
