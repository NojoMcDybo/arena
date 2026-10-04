//! Arena: Liga-Logos, Stadien und Kaderwerte (fuer die Radare) — alles ohne Konto.
//!
//! - Liga-Logos: ESPN liefert sie im Spielplan (scoreboard -> leagues[0].logos, hell und dunkel).
//! - Stadion: ESPN nennt nur Name und Stadt. Kapazitaet, Koordinaten und Eroeffnung kommen aus Wikidata
//!   (Suche nach dem Namen, Eigenschaften P1083/P625/P1619), der Grundriss von oben aus OpenStreetMap
//!   (Overpass: leisure=stadium bzw. leisure=pitch um die Koordinaten), in Meter um die Mitte umgerechnet.
//! - Kaderwerte: Saisonstatistik jedes Spielers (ESPN Core, athletes/{id}/statistics), parallel geholt.
//!
//! Alles wird zwischengespeichert (Logos 1 Tag, Stadien 7 Tage, Spielerwerte 6 Stunden).

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use crate::extra::{cached, home_paths, season};
use crate::feed::{self, s, ESPN, LEAGUES};

const CORE: &str = "https://sports.core.api.espn.com/v2/sports";
const DAY: u64 = 24 * 3600;

/// Prozentkodierung fuer Abfragen (Wikidata-Suche, Overpass)
fn enc(t: &str) -> String {
    t.bytes()
        .map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

// ---------- Liga-Logos ----------

#[derive(Serialize)]
pub struct LeagueMeta {
    id: &'static str,
    logo: String,
    dark: String,
}

#[tauri::command]
pub async fn league_meta() -> Vec<LeagueMeta> {
    tauri::async_runtime::spawn_blocking(|| {
        std::thread::scope(|sc| {
            let hs: Vec<_> = LEAGUES
                .iter()
                .map(|l| {
                    sc.spawn(move || {
                        let mut m = LeagueMeta { id: l.id, logo: String::new(), dark: String::new() };
                        if l.team == Some("Deutschland") {
                            m.logo = "https://a.espncdn.com/i/teamlogos/countries/500/ger.png".into();
                            return m;
                        }
                        let Some(path) = l.espn.iter().find(|p| **p != "fifa.friendly").or(l.espn.first()) else { return m };
                        let Ok(v) = cached(&feed::agent(), &format!("{ESPN}/{}/{path}/scoreboard", l.sport), Duration::from_secs(DAY)) else { return m };
                        for lg in v["leagues"][0]["logos"].as_array().into_iter().flatten() {
                            let rel = lg["rel"].as_array().map(|r| r.iter().map(s).collect::<Vec<_>>()).unwrap_or_default();
                            let href = s(&lg["href"]);
                            if rel.iter().any(|r| r == "dark") { m.dark = href } else if m.logo.is_empty() { m.logo = href }
                        }
                        m
                    })
                })
                .collect();
            hs.into_iter().filter_map(|h| h.join().ok()).collect()
        })
    })
    .await
    .unwrap_or_default()
}

// ---------- Stadion ----------

#[derive(Serialize, Default, Clone)]
pub struct Venue {
    name: String,
    city: String,
    capacity: u64,
    opened: String,
    lat: f64,
    lon: f64,
    /// Grundriss von oben in Metern um die Mitte (x nach Osten, y nach Sueden); leer ohne OSM-Treffer
    outline: Vec<[f32; 2]>,
    /// Spielfeld (OSM leisure=pitch), gleiche Einheiten
    pitch: Vec<[f32; 2]>,
    /// Wikidata-Eintrag, aus dem die Zahlen stammen
    wikidata: String,
    /// Foto (Wikimedia Commons, Vorschau 640 px) und seine Seite (Urheber, Lizenz)
    photo: String,
    photo_page: String,
    architect: String,
    /// Baukosten in Euro (Wikidata P2130, nur wenn in Euro angegeben)
    cost_eur: u64,
    /// Einleitung der deutschen Wikipedia (gekuerzt) und die Seite dazu
    about: String,
    wiki_url: String,
    /// Besonderheiten, aus der Wikipedia-Einleitung gelesen (Seitenansicht zeichnet sie)
    features: Features,
}

#[derive(Serialize, Default, Clone)]
pub struct Features {
    /// Leichtathletik-Laufbahn zwischen Feld und Tribuenen
    track: bool,
    /// Dach laesst sich schliessen
    retractable: bool,
    /// Rasen faehrt hinaus
    slide_pitch: bool,
    /// Stehplaetze (Zahl, wenn genannt; 1 = es gibt welche)
    standing: u64,
    /// Fassade leuchtet (z. B. in Vereinsfarben)
    lit_facade: bool,
    /// Superlativ aus dem Text, z. B. „das größte Fußballstadion Deutschlands“
    record: String,
}

/// Besonderheiten aus der Wikipedia-Einleitung (deutsch): nur, was dort ausdruecklich steht
fn features_of(t: &str) -> Features {
    let l = t.to_lowercase();
    let has = |w: &[&str]| w.iter().any(|x| l.contains(x));
    let mut f = Features {
        track: has(&["leichtathletik", "laufbahn", "tartanbahn"]) && !has(&["ohne laufbahn", "ohne leichtathletik", "reines fußballstadion", "reinen fußballstadion"]),
        retractable: has(&["schiebedach", "verschließbares dach", "verschließbaren dach", "schließbares dach", "schließbaren dach", "dach geschlossen", "dach kann geschlossen"]),
        slide_pitch: has(&["herausfahrbar", "ausfahrbar", "rasen herausgefahren", "spielfeld herausgefahren"]),
        lit_facade: (has(&["fassade", "außenhülle", "hülle"]) && has(&["leucht", "beleucht", "farbig"])),
        ..Default::default()
    };
    // „… 24.454 Stehplätze …“, „davon 25.000 Stehplätze“
    let words: Vec<&str> = t.split_whitespace().collect();
    for (i, w) in words.iter().enumerate() {
        if w.to_lowercase().starts_with("steh") && i > 0 {
            let n: String = words[i - 1].chars().filter(|c| c.is_ascii_digit()).collect();
            if let Ok(x) = n.parse::<u64>() {
                if (500..200_000).contains(&x) {
                    f.standing = x;
                    break;
                }
            }
        }
    }
    if f.standing == 0 && has(&["stehpl", "stehtrib", "stehrang"]) {
        f.standing = 1;
    }
    // Superlativ: der Satzteil ab „größte/größten/älteste/erste …“ bis zum naechsten Komma oder Punkt
    for key in ["größte", "größten", "älteste", "ältesten", "modernste", "höchste", "erste "] {
        if let Some(i) = l.find(key) {
            let start = t[..i].rfind(|c: char| c == ',' || c == '.').map(|j| j + 1).unwrap_or(0);
            let end = t[i..].find(|c: char| c == ',' || c == '.' || c == ';').map(|j| i + j).unwrap_or(t.len());
            let part = t[start..end].trim();
            // „Mit 81.365 Zuschauerplätzen ist es das größte …“ -> ab „das/die/der“
            let part = ["das ", "die ", "der "].iter().filter_map(|a| part.find(a).map(|j| &part[j..])).min_by_key(|x| std::cmp::Reverse(x.len())).unwrap_or(part);
            if part.len() > 12 && part.len() < 140 {
                f.record = part.to_string();
                break;
            }
        }
    }
    f
}

/// Bezeichnungen zu Wikidata-Eintraegen (deutsch, sonst englisch), in einem Abruf
fn labels(agent: &ureq::Agent, ids: &[String]) -> std::collections::HashMap<String, (String, Value)> {
    let mut out = std::collections::HashMap::new();
    for chunk in ids.chunks(45) {
        let url = format!("https://www.wikidata.org/w/api.php?action=wbgetentities&ids={}&props=labels|claims&languages=de|en&format=json", chunk.join("|"));
        let Ok(v) = cached(agent, &url, Duration::from_secs(7 * DAY)) else { continue };
        for (id, e) in v["entities"].as_object().into_iter().flatten() {
            let l = e["labels"]["de"]["value"].as_str().or(e["labels"]["en"]["value"].as_str()).unwrap_or("").to_string();
            out.insert(id.clone(), (l, e.clone()));
        }
    }
    out
}

/// Commons-Datei -> Vorschaubild und Dateiseite
fn commons(file: &str, width: u32) -> (String, String) {
    let f = file.replace(' ', "_");
    (format!("https://commons.wikimedia.org/wiki/Special:FilePath/{}?width={width}", enc(&f)), format!("https://commons.wikimedia.org/wiki/File:{}", enc(&f)))
}

/// Einleitung der deutschen Wikipedia (reiner Text)
fn wiki_intro(agent: &ureq::Agent, title: &str) -> String {
    let url = format!("https://de.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&redirects=1&format=json&titles={}", enc(title));
    let Ok(v) = cached(agent, &url, Duration::from_secs(7 * DAY)) else { return String::new() };
    v["query"]["pages"].as_object().and_then(|p| p.values().next()).map(|p| s(&p["extract"])).unwrap_or_default()
}

/// hoechstens n Zeichen, an einer Satzgrenze
fn cut_sentences(t: &str, n: usize) -> String {
    let t = t.split("\n").next().unwrap_or(t).lines().next().unwrap_or(t).trim();
    if t.chars().count() <= n {
        return t.to_string();
    }
    let head: String = t.chars().take(n).collect();
    match head.rfind(". ") {
        Some(i) if i > n / 3 => head[..=i].to_string(),
        _ => format!("{}…", head.trim_end()),
    }
}

/// Wert einer Wikidata-Eigenschaft: bevorzugter Rang, sonst der letzte Eintrag
fn claim<'a>(e: &'a Value, p: &str) -> Option<&'a Value> {
    let list = e["claims"][p].as_array()?;
    list.iter().find(|c| c["rank"] == "preferred").or(list.last()).map(|c| &c["mainsnak"]["datavalue"]["value"])
}

fn wikidata(agent: &ureq::Agent, name: &str, city: &str) -> Option<(String, Value)> {
    let ttl = Duration::from_secs(7 * DAY);
    for lang in ["de", "en"] {
        let url = format!("https://www.wikidata.org/w/api.php?action=wbsearchentities&search={}&language={lang}&type=item&format=json&limit=6", enc(name));
        let Ok(v) = cached(agent, &url, ttl) else { continue };
        let hits = v["search"].as_array().cloned().unwrap_or_default();
        // Stadion-Treffer zuerst (Beschreibung), sonst der erste mit Koordinaten
        let looks = |h: &Value| {
            let d = s(&h["description"]).to_lowercase();
            ["stadium", "stadion", "arena", "ground", "venue", "spielstätte"].iter().any(|w| d.contains(w))
                || (!city.is_empty() && d.contains(&city.to_lowercase()))
        };
        let mut order: Vec<&Value> = hits.iter().filter(|h| looks(h)).collect();
        order.extend(hits.iter().filter(|h| !looks(h)));
        for h in order.into_iter().take(4) {
            let id = s(&h["id"]);
            let Ok(ent) = cached(agent, &format!("https://www.wikidata.org/wiki/Special:EntityData/{id}.json"), ttl) else { continue };
            let e = ent["entities"][&id].clone();
            if claim(&e, "P625").is_some() {
                return Some((id, e));
            }
        }
    }
    None
}

/// Overpass-Element -> Punkte (Breite, Laenge); Relationen: alle aeusseren Wege
fn geom(e: &Value) -> Vec<(f64, f64)> {
    let pts = |g: &Value| g.as_array().into_iter().flatten().filter_map(|p| Some((p["lat"].as_f64()?, p["lon"].as_f64()?))).collect::<Vec<_>>();
    if e["geometry"].is_array() {
        return pts(&e["geometry"]);
    }
    e["members"].as_array().into_iter().flatten().filter(|m| m["role"] != "inner").flat_map(|m| pts(&m["geometry"])).collect()
}

/// Flaeche in m² (Schuhbandformel, lokal eben)
fn area(p: &[[f32; 2]]) -> f32 {
    let n = p.len();
    (0..n).map(|i| { let (a, b) = (p[i], p[(i + 1) % n]); a[0] * b[1] - b[0] * a[1] }).sum::<f32>().abs() / 2.0
}

fn project(pts: &[(f64, f64)], lat0: f64, lon0: f64) -> Vec<[f32; 2]> {
    let kx = 111_320.0 * lat0.to_radians().cos();
    pts.iter().map(|(la, lo)| [((lo - lon0) * kx) as f32, ((lat0 - la) * 110_540.0) as f32]).collect()
}

fn osm(agent: &ureq::Agent, lat: f64, lon: f64, name: &str) -> (Vec<[f32; 2]>, Vec<[f32; 2]>) {
    let q = format!(
        "[out:json][timeout:15];(way(around:700,{lat},{lon})[\"leisure\"=\"stadium\"];relation(around:700,{lat},{lon})[\"leisure\"=\"stadium\"];way(around:400,{lat},{lon})[\"leisure\"=\"pitch\"];);out geom;"
    );
    // Overpass ist zeitweise ueberlastet (504): ein zweiter Versuch nach kurzer Pause (Fehler werden nicht gespeichert)
    let url = format!("https://overpass-api.de/api/interpreter?data={}", enc(&q));
    let mut got = None;
    for i in 0..2 {
        if i > 0 {
            std::thread::sleep(Duration::from_millis(1500));
        }
        if let Ok(v) = cached(agent, &url, Duration::from_secs(7 * DAY)) {
            got = Some(v);
            break;
        }
    }
    let Some(v) = got else { return (Vec::new(), Vec::new()) };
    let els = v["elements"].as_array().cloned().unwrap_or_default();
    let norm = |t: &str| t.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect::<String>();
    let want = norm(name);
    // Stadion: gleicher Name (auch Teil davon) vor groesster Flaeche
    let mut best: Option<(i32, f32, Vec<(f64, f64)>)> = None;
    for e in els.iter().filter(|e| e["tags"]["leisure"] == "stadium") {
        let g = geom(e);
        if g.len() < 4 {
            continue;
        }
        let n = norm(&s(&e["tags"]["name"]));
        let score = if !n.is_empty() && (n.contains(&want) || want.contains(&n)) { 1 } else { 0 };
        let a = area(&project(&g, lat, lon));
        if best.as_ref().is_none_or(|b| (score, a) > (b.0, b.1)) {
            best = Some((score, a, g));
        }
    }
    let Some((_, _, sg)) = best else { return (Vec::new(), Vec::new()) };
    // Mitte des Stadions als Ursprung
    let (cla, clo) = (sg.iter().map(|p| p.0).sum::<f64>() / sg.len() as f64, sg.iter().map(|p| p.1).sum::<f64>() / sg.len() as f64);
    let outline = project(&sg, cla, clo);
    let r = outline.iter().map(|p| p[0].hypot(p[1])).fold(0.0f32, f32::max);
    // Spielfeld: groesstes Feld nahe der Mitte
    let pitch = els
        .iter()
        .filter(|e| e["tags"]["leisure"] == "pitch")
        .map(|e| project(&geom(e), cla, clo))
        .filter(|p| p.len() >= 4 && p.iter().all(|q| q[0].hypot(q[1]) <= r * 1.05))
        .max_by(|a, b| area(a).partial_cmp(&area(b)).unwrap_or(std::cmp::Ordering::Equal))
        .unwrap_or_default();
    (outline, pitch)
}

#[tauri::command]
pub async fn venue_info(name: String, city: String) -> Result<Venue, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if name.trim().is_empty() {
            return Err("kein Stadion".into());
        }
        let agent = feed::agent();
        let mut v = Venue { name: name.clone(), city: city.clone(), ..Default::default() };
        let Some((id, e)) = wikidata(&agent, &name, &city) else { return Ok(v) };
        v.wikidata = id;
        if let Some(c) = claim(&e, "P1083") {
            v.capacity = s(&c["amount"]).trim_start_matches('+').parse::<f64>().unwrap_or(0.0) as u64;
        }
        if let Some(c) = claim(&e, "P625") {
            v.lat = c["latitude"].as_f64().unwrap_or(0.0);
            v.lon = c["longitude"].as_f64().unwrap_or(0.0);
        }
        if let Some(c) = claim(&e, "P1619") {
            v.opened = s(&c["time"]).trim_start_matches('+').chars().take(4).collect();
        }
        if let Some(f) = claim(&e, "P18").and_then(|c| c.as_str()) {
            (v.photo, v.photo_page) = commons(f, 640);
        }
        if let Some(c) = claim(&e, "P2130") {
            if s(&c["unit"]).ends_with("/Q4916") {
                v.cost_eur = s(&c["amount"]).trim_start_matches('+').parse::<f64>().unwrap_or(0.0) as u64;
            }
        }
        if let Some(a) = claim(&e, "P84").map(|c| s(&c["id"])).filter(|a| !a.is_empty()) {
            v.architect = labels(&agent, &[a.clone()]).get(&a).map(|x| x.0.clone()).unwrap_or_default();
        }
        if let Some(title) = e["sitelinks"]["dewiki"]["title"].as_str() {
            let intro = wiki_intro(&agent, title);
            v.features = features_of(&intro);
            v.about = cut_sentences(&intro, 420);
            v.wiki_url = format!("https://de.wikipedia.org/wiki/{}", enc(&title.replace(' ', "_")));
        }
        if v.lat != 0.0 || v.lon != 0.0 {
            let (o, p) = osm(&agent, v.lat, v.lon, &name);
            v.outline = o;
            v.pitch = p;
        }
        Ok(v)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- Spielerprofil: ESPN (Steckbrief, Foto) + Wikidata (Foto, Vereinsstationen) ----------

#[derive(Serialize, Default, Clone)]
pub struct Station {
    club: String,
    from: String,
    to: String,
    apps: Option<u32>,
    goals: Option<u32>,
    loan: bool,
    national: bool,
}

#[derive(Serialize, Default, Clone)]
pub struct PlayerInfo {
    name: String,
    age: u32,
    born: String,
    height_cm: u32,
    weight_kg: u32,
    nation: String,
    flag: String,
    position: String,
    /// ESPN-Portraet (gibt es im Fussball nur fuer manche) und Foto aus Wikimedia Commons
    headshot: String,
    photo: String,
    photo_page: String,
    /// Vereinsstationen (Wikidata P54), neueste zuerst; ohne Abloesesummen
    career: Vec<Station>,
    /// Transfermarkt-Kennung (Wikidata P2446) — nur fuer einen Link
    transfermarkt: String,
    wikidata: String,
}

fn year(v: &Value) -> String {
    s(&v["time"]).trim_start_matches('+').chars().take(4).collect()
}

/// Wikidata-Eintrag eines Fussballers: Name, Beruf Fussballspieler (Q937857), Geburtsjahr passt
fn player_entity(agent: &ureq::Agent, name: &str, born: &str) -> Option<(String, Value)> {
    let ttl = Duration::from_secs(7 * DAY);
    for lang in ["de", "en"] {
        let url = format!("https://www.wikidata.org/w/api.php?action=wbsearchentities&search={}&language={lang}&type=item&format=json&limit=6", enc(name));
        let Ok(v) = cached(agent, &url, ttl) else { continue };
        for h in v["search"].as_array().into_iter().flatten().take(5) {
            let id = s(&h["id"]);
            let Ok(ent) = cached(agent, &format!("https://www.wikidata.org/wiki/Special:EntityData/{id}.json"), ttl) else { continue };
            let e = ent["entities"][&id].clone();
            let footballer = e["claims"]["P106"].as_array().into_iter().flatten().any(|c| s(&c["mainsnak"]["datavalue"]["value"]["id"]) == "Q937857");
            let by = claim(&e, "P569").map(year).unwrap_or_default();
            if footballer && (born.is_empty() || by.is_empty() || by == born) {
                return Some((id, e));
            }
        }
    }
    None
}

#[tauri::command]
pub async fn player_info(id: String, path: String, name: String) -> Result<PlayerInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let ok = |x: &str| !x.is_empty() && x.len() < 40 && x.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c));
        if !ok(&id) || !ok(&path) {
            return Err("unbekannter Spieler".into());
        }
        let agent = feed::agent();
        let mut p = PlayerInfo { name: name.clone(), ..Default::default() };
        if let Ok(a) = cached(&agent, &format!("{CORE}/soccer/leagues/{path}/athletes/{id}"), Duration::from_secs(DAY)) {
            if !s(&a["displayName"]).is_empty() {
                p.name = s(&a["displayName"]);
            }
            p.age = a["age"].as_u64().unwrap_or(0) as u32;
            p.born = s(&a["dateOfBirth"]).chars().take(10).collect();
            // ESPN: Zoll und Pfund
            p.height_cm = (a["height"].as_f64().unwrap_or(0.0) * 2.54).round() as u32;
            p.weight_kg = (a["weight"].as_f64().unwrap_or(0.0) * 0.4536).round() as u32;
            p.nation = s(&a["citizenship"]);
            p.flag = s(&a["flag"]["href"]);
            p.position = s(&a["position"]["displayName"]);
            p.headshot = s(&a["headshot"]["href"]);
        }
        let born_year: String = p.born.chars().take(4).collect();
        if let Some((qid, e)) = player_entity(&agent, &p.name, &born_year) {
            p.wikidata = qid;
            if let Some(f) = claim(&e, "P18").and_then(|c| c.as_str()) {
                (p.photo, p.photo_page) = commons(f, 400);
            }
            p.transfermarkt = claim(&e, "P2446").map(s).unwrap_or_default();
            let stations: Vec<&Value> = e["claims"]["P54"].as_array().map(|a| a.iter().collect()).unwrap_or_default();
            let mut ids: Vec<String> = stations.iter().map(|c| s(&c["mainsnak"]["datavalue"]["value"]["id"])).filter(|x| !x.is_empty()).collect();
            // Art des Wechsels (Leihe, Transfer …) steht als Eintrag in P1642
            for c in &stations {
                for q in c["qualifiers"]["P1642"].as_array().into_iter().flatten() {
                    ids.push(s(&q["datavalue"]["value"]["id"]));
                }
            }
            ids.sort();
            ids.dedup();
            let lab = labels(&agent, &ids);
            for c in stations {
                let club = s(&c["mainsnak"]["datavalue"]["value"]["id"]);
                let Some((label, ent)) = lab.get(&club) else { continue };
                let q = &c["qualifiers"];
                let first = |k: &str| q[k].as_array().and_then(|a| a.first()).map(|x| &x["datavalue"]["value"]);
                let num = |k: &str| first(k).and_then(|v| s(&v["amount"]).trim_start_matches('+').parse::<u32>().ok());
                let loan = q["P1642"].as_array().into_iter().flatten().any(|x| {
                    lab.get(&s(&x["datavalue"]["value"]["id"])).is_some_and(|(l, _)| { let l = l.to_lowercase(); l.contains("leih") || l.contains("loan") })
                });
                let national = ent["claims"]["P31"].as_array().into_iter().flatten().any(|x| s(&x["mainsnak"]["datavalue"]["value"]["id"]) == "Q6979593")
                    || label.to_lowercase().contains("nationalmannschaft");
                p.career.push(Station {
                    club: label.clone(),
                    from: first("P580").map(year).unwrap_or_default(),
                    to: first("P582").map(year).unwrap_or_default(),
                    apps: num("P1350"),
                    goals: num("P1351"),
                    loan,
                    national,
                });
            }
            // neueste zuerst; laufende Stationen (ohne Ende) ganz oben
            p.career.sort_by(|a, b| (b.to.is_empty(), &b.from, &b.to).cmp(&(a.to.is_empty(), &a.from, &a.to)));
        }
        Ok(p)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- Aufstellungen der letzten Spiele ----------

#[derive(Serialize, Clone)]
pub struct LineupGame {
    event: String,
    date: u64,
    home: bool,
    opp: feed::Team,
    score: String,
    /// s(ieg) u(nentschieden) n(iederlage)
    result: String,
    comp: String,
    lineup: crate::info::Lineup,
}

/// Startelf des Teams in seinen letzten (bis zu fuenf) beendeten Ligaspielen, neueste zuerst
#[tauri::command]
pub async fn recent_lineups(team: String) -> Result<Vec<LineupGame>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (sport, id) = team.split_once(':').ok_or("unbekanntes Team")?;
        if sport != "soccer" || !id.chars().all(|c| c.is_ascii_digit()) {
            return Err("Aufstellungen gibt es für Fußballteams aus ESPN-Wettbewerben.".into());
        }
        let agent = feed::agent();
        let path = home_paths(&agent, sport, id).into_iter().next().ok_or("Liga des Teams unbekannt")?;
        let sched = cached(&agent, &format!("{ESPN}/soccer/{path}/teams/{id}/schedule"), Duration::from_secs(1800))?;
        let mut past: Vec<(u64, Value)> = sched["events"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|e| e["competitions"][0]["status"]["type"]["completed"].as_bool() == Some(true))
            .map(|e| (feed::parse_utc(&s(&e["date"])).unwrap_or(0), e.clone()))
            .collect();
        past.sort_by_key(|x| std::cmp::Reverse(x.0));
        past.truncate(5);
        let comp = feed::league(&path).map(|l| l.name).or_else(|| LEAGUES.iter().find(|l| l.espn.contains(&path)).map(|l| l.name)).unwrap_or("").to_string();
        let games: Vec<Option<LineupGame>> = std::thread::scope(|sc| {
            let hs: Vec<_> = past
                .iter()
                .map(|(date, e)| {
                    let (agent, path, id, comp) = (&agent, path, id, &comp);
                    sc.spawn(move || {
                        let eid = s(&e["id"]);
                        let sum = cached(agent, &format!("{ESPN}/soccer/{path}/summary?event={eid}"), Duration::from_secs(DAY)).ok()?;
                        let r = sum["rosters"].as_array()?.iter().find(|r| s(&r["team"]["id"]) == id)?;
                        let lineup = crate::info::lineup_of(r);
                        let cs = e["competitions"][0]["competitors"].as_array()?;
                        let me = cs.iter().find(|c| s(&c["id"]) == id || s(&c["team"]["id"]) == id)?;
                        let other = cs.iter().find(|c| !std::ptr::eq(*c, me))?;
                        let sc_of = |c: &Value| { let v = &c["score"]; if v.is_object() { s(&v["displayValue"]) } else { s(v) } };
                        let (a, b) = (sc_of(me), sc_of(other));
                        let (na, nb) = (a.parse::<i32>().unwrap_or(0), b.parse::<i32>().unwrap_or(0));
                        let home = s(&me["homeAway"]) == "home";
                        Some(LineupGame {
                            event: eid,
                            date: *date,
                            home,
                            opp: feed::team_of(other, "soccer"),
                            score: format!("{a}:{b}"),
                            result: if na > nb { "s" } else if na < nb { "n" } else { "u" }.into(),
                            comp: comp.clone(),
                            lineup,
                        })
                    })
                })
                .collect();
            hs.into_iter().map(|h| h.join().ok().flatten()).collect()
        });
        Ok(games.into_iter().flatten().filter(|g| !g.lineup.formation.is_empty() || g.lineup.players_len() > 0).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- Kaderwerte (Radare) ----------

#[derive(Serialize, Default, Clone)]
pub struct PlayerStats {
    id: String,
    name: String,
    jersey: String,
    pos: String,
    apps: f64,
    minutes: f64,
    goals: f64,
    assists: f64,
    shots: f64,
    shots_on: f64,
    shot_assists: f64,
    passes_ok: f64,
    passes_bad: f64,
    duels_won: f64,
    duels: f64,
    tackles: f64,
    interceptions: f64,
    recoveries: f64,
    saves: f64,
    conceded: f64,
    clean_sheets: f64,
}

fn player_stats(v: &Value) -> PlayerStats {
    let mut p = PlayerStats::default();
    for c in v["splits"]["categories"].as_array().into_iter().flatten() {
        for st in c["stats"].as_array().into_iter().flatten() {
            let x = st["value"].as_f64().unwrap_or(0.0);
            match s(&st["name"]).as_str() {
                "appearances" => p.apps = x,
                "minutes" => p.minutes = x,
                "totalGoals" => p.goals = x,
                "goalAssists" => p.assists = x,
                "totalShots" => p.shots = x,
                "shotsOnTarget" => p.shots_on = x,
                "shotAssists" => p.shot_assists = x,
                "accuratePasses" => p.passes_ok = x,
                "inaccuratePasses" => p.passes_bad = x,
                "duelsWon" => p.duels_won = x,
                "duels" => p.duels = x,
                "effectiveTackles" => p.tackles = x,
                "interceptions" => p.interceptions = x,
                "recoveries" => p.recoveries = x,
                "saves" => p.saves = x,
                "goalsConceded" => p.conceded = x,
                "cleanSheet" => p.clean_sheets = x,
                _ => {}
            }
        }
    }
    p
}

#[tauri::command]
pub async fn squad_stats(key: String) -> Result<Vec<PlayerStats>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (sport, id) = key.split_once(':').ok_or("unbekanntes Team")?;
        if sport != "soccer" || !id.chars().all(|c| c.is_ascii_digit()) {
            return Err("Kaderwerte gibt es für Fußballteams aus ESPN-Wettbewerben.".into());
        }
        let agent = feed::agent();
        let path = home_paths(&agent, sport, id).into_iter().next().ok_or("Liga des Teams unbekannt")?;
        let roster = cached(&agent, &format!("{ESPN}/soccer/{path}/teams/{id}/roster"), Duration::from_secs(6 * 3600))?;
        let players: Vec<(String, String, String, String)> = roster["athletes"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|a| (s(&a["id"]), s(&a["displayName"]), s(&a["jersey"]), s(&a["position"]["abbreviation"])))
            .filter(|p| !p.0.is_empty())
            .collect();
        let yr = season(crate::now_ms());
        let out: Vec<PlayerStats> = std::thread::scope(|sc| {
            players
                .chunks(8)
                .flat_map(|chunk| {
                    let hs: Vec<_> = chunk
                        .iter()
                        .map(|(pid, name, jersey, pos)| {
                            let agent = &agent;
                            sc.spawn(move || {
                                let url = format!("{CORE}/soccer/leagues/{path}/seasons/{yr}/types/1/athletes/{pid}/statistics");
                                let mut p = cached(agent, &url, Duration::from_secs(6 * 3600)).map(|v| player_stats(&v)).unwrap_or_default();
                                p.id = pid.clone();
                                p.name = name.clone();
                                p.jersey = jersey.clone();
                                p.pos = pos.clone();
                                p
                            })
                        })
                        .collect();
                    hs.into_iter().filter_map(|h| h.join().ok()).collect::<Vec<_>>()
                })
                .collect()
        });
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kodierung_und_flaeche() {
        assert_eq!(enc("BayArena Köln"), "BayArena%20K%C3%B6ln");
        assert!((area(&[[0.0, 0.0], [10.0, 0.0], [10.0, 5.0], [0.0, 5.0]]) - 50.0).abs() < 1e-3);
        let p = project(&[(51.0, 7.0), (51.001, 7.001)], 51.0, 7.0);
        assert_eq!(p[0], [0.0, 0.0]);
        assert!(p[1][0] > 60.0 && p[1][0] < 80.0 && p[1][1] < -100.0);
    }

    #[test]
    fn besonderheiten() {
        let f = features_of("Mit 81.365 Zuschauerplätzen ist es das größte Fußballstadion Deutschlands. Davon sind 24.454 Stehplätze auf der Südtribüne.");
        assert_eq!(f.standing, 24454);
        assert_eq!(f.record, "das größte Fußballstadion Deutschlands");
        assert!(!f.track && !f.retractable);
        let g = features_of("Die Arena hat ein verschließbares Dach, der Rasen ist herausfahrbar. Früher mit Laufbahn für Leichtathletik.");
        assert!(g.retractable && g.slide_pitch && g.track);
        assert!(!features_of("Ein reines Fußballstadion ohne Laufbahn.").track);
    }

    #[test]
    fn spielerwerte() {
        let v = serde_json::json!({ "splits": { "categories": [
            { "name": "general", "stats": [{ "name": "minutes", "value": 261.0 }, { "name": "duelsWon", "value": 12.0 }, { "name": "duels", "value": 26.0 }] },
            { "name": "offensive", "stats": [{ "name": "totalGoals", "value": 3.0 }, { "name": "accuratePasses", "value": 36.0 }] }
        ] } });
        let p = player_stats(&v);
        assert_eq!((p.minutes, p.goals, p.duels_won, p.duels, p.passes_ok), (261.0, 3.0, 12.0, 26.0, 36.0));
    }

    /// Netz noetig: cargo test --lib mehr_quellen -- --ignored --nocapture
    #[test]
    #[ignore]
    fn mehr_quellen() {
        let (v, k, l, pl, rl, v2) = tauri::async_runtime::block_on(async {
            (venue_info("BayArena".into(), "Leverkusen".into()).await, squad_stats("soccer:131".into()).await, league_meta().await,
             player_info("212330".into(), "ger.1".into(), "Patrik Schick".into()).await, recent_lineups("soccer:131".into()).await, venue_info("Signal Iduna Park".into(), "Dortmund".into()).await)
        });
        let v = v.expect("Stadion");
        if let Ok(path) = std::env::var("ARENA_DUMP") {
            let _ = std::fs::write(&path, serde_json::json!({ "venue": v, "squad": k.as_ref().ok(), "leagues": l, "player": pl.as_ref().ok(), "lineups": rl.as_ref().ok(), "venue2": v2.as_ref().ok() }).to_string());
        }
        if let Ok(v2) = &v2 { println!("SIP: Besonderheiten Stehplaetze {} Rekord {:?} Laufbahn {} Dach {}", v2.features.standing, v2.features.record, v2.features.track, v2.features.retractable); }
        let pl = pl.expect("Spieler");
        println!("Spieler {} ({} J., {} cm, {}), Foto {}, Stationen {}, TM {}", pl.name, pl.age, pl.height_cm, pl.nation, !pl.photo.is_empty(), pl.career.len(), pl.transfermarkt);
        for st in pl.career.iter().take(4) { println!("  {} {}–{} {:?}/{:?} Leihe {} NM {}", st.club, st.from, st.to, st.apps, st.goals, st.loan, st.national); }
        let rl = rl.expect("Aufstellungen");
        for g in &rl { println!("  Aufstellung {} gegen {} {} ({}), {} Spieler", g.lineup.formation, g.opp.name, g.score, g.result, g.lineup.players_len()); }
        println!("Stadion: Foto {}, Architekt {}, Kosten {}, Besonderheiten {} {} {} {} {:?}", !v.photo.is_empty(), v.architect, v.cost_eur, v.features.track, v.features.retractable, v.features.standing, v.features.slide_pitch, v.features.record);
        println!("{}: {} Plaetze, eroeffnet {}, Grundriss {} Punkte, Feld {} Punkte ({})", v.name, v.capacity, v.opened, v.outline.len(), v.pitch.len(), v.wikidata);
        let k = k.expect("Kader");
        let best = k.iter().max_by(|a, b| a.goals.partial_cmp(&b.goals).unwrap()).unwrap();
        println!("Kader {} Spieler, bester Torschuetze {} ({})", k.len(), best.name, best.goals);
        println!("Logos: {}", l.iter().filter(|m| !m.logo.is_empty()).count());
    }
}
