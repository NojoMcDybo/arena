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
        let (v, k, l) = tauri::async_runtime::block_on(async {
            (venue_info("BayArena".into(), "Leverkusen".into()).await, squad_stats("soccer:131".into()).await, league_meta().await)
        });
        let v = v.expect("Stadion");
        if let Ok(path) = std::env::var("ARENA_DUMP") {
            let _ = std::fs::write(&path, serde_json::json!({ "venue": v, "squad": k.as_ref().ok(), "leagues": l }).to_string());
        }
        println!("{}: {} Plaetze, eroeffnet {}, Grundriss {} Punkte, Feld {} Punkte ({})", v.name, v.capacity, v.opened, v.outline.len(), v.pitch.len(), v.wikidata);
        let k = k.expect("Kader");
        let best = k.iter().max_by(|a, b| a.goals.partial_cmp(&b.goals).unwrap()).unwrap();
        println!("Kader {} Spieler, bester Torschuetze {} ({})", k.len(), best.name, best.goals);
        println!("Logos: {}", l.iter().filter(|m| !m.logo.is_empty()).count());
    }
}
