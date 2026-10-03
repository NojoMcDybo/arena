//! Arena: Hintergrund zu Spielen, Teams und Wettbewerben (alles ESPN, ohne Konto).
//!
//! - Spiel (summary?event=): Statistik beider Teams (Ballbesitz, Schuesse, Paesse …), Druckphasen aus dem
//!   Kommentar (jede Torchance mit Minute und Seite), Aufstellungen mit Formation, Stadion und Schiedsrichter,
//!   vor dem Spiel Prognose (aus den Quoten), Form und direkter Vergleich.
//! - Team (teams/{id}/roster): Kader mit Rueckennummer, Position, Alter, Nation und Verletzungen.
//! - Wettbewerb (news, transactions): Schlagzeilen (Transfers markiert) und Kaderbewegungen (US-Ligen; im
//!   Fussball liefert ESPN dort nichts). Marktwerte gibt es frei abrufbar nirgends.

use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};

use crate::extra::{cached, home_paths};
use crate::feed::{self, s, Team, ESPN};

/// "soccer/ger.1:401884788" -> ("soccer", "ger.1", "401884788")
fn split_key(key: &str) -> Result<(&str, &str, &str), String> {
    let (left, id) = key.split_once(':').ok_or("unbekanntes Spiel")?;
    let (sport, path) = left.split_once('/').ok_or("unbekanntes Spiel")?;
    if sport == "oldb" {
        return Err("Für dieses Spiel gibt es keine Details (OpenLigaDB).".into());
    }
    let ok = |x: &str| !x.is_empty() && x.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c));
    if !ok(sport) || !ok(path) || !ok(id) {
        return Err("unbekanntes Spiel".into());
    }
    Ok((sport, path, id))
}

fn num(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(0.0),
        Value::String(x) => x.trim().trim_end_matches('%').split(['-', '/']).next().and_then(|x| x.trim().parse().ok()).unwrap_or(0.0),
        _ => 0.0,
    }
}

// ---------- Spiel ----------

#[derive(Serialize, Default, Clone)]
pub struct Stat {
    label: String,
    home: String,
    away: String,
    /// Werte fuer den Balken (0 = keiner)
    h: f64,
    a: f64,
}

/// Torchance im Kommentar: Minute, Seite, Gewicht (Ecke 1, Schuss 2, aufs Tor 3, Tor 5)
#[derive(Serialize, Clone)]
pub struct Pulse {
    minute: u32,
    side: String,
    w: u8,
}

#[derive(Serialize, Clone)]
pub struct Player {
    jersey: String,
    name: String,
    pos: String,
    starter: bool,
    sub_in: bool,
    sub_out: bool,
    place: u32,
}

#[derive(Serialize, Default, Clone)]
pub struct Lineup {
    formation: String,
    players: Vec<Player>,
}

#[derive(Serialize, Clone)]
pub struct FormGame {
    /// s(ieg) u(nentschieden) n(iederlage)
    r: String,
    score: String,
    opp: String,
    home: bool,
    date: u64,
    comp: String,
}

#[derive(Serialize, Clone)]
pub struct H2h {
    date: u64,
    home: Team,
    away: Team,
}

#[derive(Serialize, Default)]
pub struct MatchDetail {
    stats: Vec<Stat>,
    pulse: Vec<Pulse>,
    lineup_home: Option<Lineup>,
    lineup_away: Option<Lineup>,
    venue: String,
    city: String,
    referee: String,
    attendance: u64,
    /// Prognose aus den Quoten: Heim, Remis, Gast (Summe 1); leer ohne Quoten
    odds: Vec<f64>,
    odds_by: String,
    form_home: Vec<FormGame>,
    form_away: Vec<FormGame>,
    h2h: Vec<H2h>,
}

/// Fussball-Statistik auf Deutsch, in dieser Reihenfolge; Prozentwerte rechnet Arena selbst
const SOCCER_STATS: &[(&str, &str)] = &[
    ("possessionPct", "Ballbesitz"),
    ("totalShots", "Schüsse"),
    ("shotsOnTarget", "Aufs Tor"),
    ("wonCorners", "Ecken"),
    ("passPct", "Passquote"),
    ("totalPasses", "Pässe"),
    ("crossPct", "Flankenquote"),
    ("tacklePct", "Zweikampfquote"),
    ("interceptions", "Ballgewinne"),
    ("saves", "Paraden"),
    ("foulsCommitted", "Fouls"),
    ("offsides", "Abseits"),
    ("yellowCards", "Gelbe Karten"),
    ("redCards", "Rote Karten"),
    // vor dem Spiel: Saisonwerte
    ("totalGoals", "Tore (Saison)"),
    ("goalsConceded", "Gegentore (Saison)"),
    ("goalDifference", "Tordifferenz"),
];

fn stats_of(box_teams: &Value, sport: &str, home_id: &str) -> Vec<Stat> {
    let teams: Vec<&Value> = box_teams.as_array().map(|a| a.iter().collect()).unwrap_or_default();
    if teams.len() != 2 {
        return Vec::new();
    }
    // Reihenfolge bei ESPN nicht garantiert: Heim ueber die id finden
    let (h, a) = if s(&teams[1]["team"]["id"]) == home_id { (teams[1], teams[0]) } else { (teams[0], teams[1]) };
    let get = |t: &Value, name: &str| t["statistics"].as_array().and_then(|x| x.iter().find(|e| e["name"] == name)).cloned();
    let mut out = Vec::new();
    if sport == "soccer" {
        let ratio = |t: &Value, ok: &str, all: &str| {
            let (o, n) = (get(t, ok).map(|e| num(&e["displayValue"])).unwrap_or(0.0), get(t, all).map(|e| num(&e["displayValue"])).unwrap_or(0.0));
            (n > 0.0).then(|| (o / n * 100.0).round())
        };
        for (name, label) in SOCCER_STATS {
            let pct = match *name {
                "passPct" => Some(("accuratePasses", "totalPasses")),
                "crossPct" => Some(("accurateCrosses", "totalCrosses")),
                "tacklePct" => Some(("effectiveTackles", "totalTackles")),
                _ => None,
            };
            if let Some((ok, all)) = pct {
                if let (Some(x), Some(y)) = (ratio(h, ok, all), ratio(a, ok, all)) {
                    out.push(Stat { label: (*label).into(), home: format!("{x} %"), away: format!("{y} %"), h: x, a: y });
                }
                continue;
            }
            let (Some(x), Some(y)) = (get(h, name), get(a, name)) else { continue };
            let (hv, av) = (num(&x["displayValue"]), num(&y["displayValue"]));
            let unit = if *name == "possessionPct" { " %" } else { "" };
            let show = |v: f64, raw: &Value| if unit.is_empty() { s(raw) } else { format!("{}{unit}", v.round()) };
            // Karten nur zeigen, wenn es welche gibt
            if name.ends_with("Cards") && hv + av == 0.0 {
                continue;
            }
            let bar = *name != "goalDifference";
            out.push(Stat {
                label: (*label).into(),
                home: show(hv, &x["displayValue"]),
                away: show(av, &y["displayValue"]),
                h: if bar { hv.max(0.0) } else { 0.0 },
                a: if bar { av.max(0.0) } else { 0.0 },
            });
        }
    } else {
        // US-Sport: was ESPN liefert, mit ESPNs Beschriftung
        for x in h["statistics"].as_array().into_iter().flatten().take(14) {
            let name = s(&x["name"]);
            let Some(y) = get(a, &name) else { continue };
            let label = [s(&x["label"]), s(&x["displayName"]), name.clone()].into_iter().find(|l| !l.is_empty()).unwrap_or_default();
            let (hv, av) = (num(&x["displayValue"]), num(&y["displayValue"]));
            out.push(Stat { label, home: s(&x["displayValue"]), away: s(&y["displayValue"]), h: hv.max(0.0), a: av.max(0.0) });
        }
    }
    out
}

/// "45'+2'" -> 47, "90'+4'" -> 94
fn minute_of(v: &Value) -> u32 {
    let t = s(&v["displayValue"]);
    let mut parts = t.split('+').map(|x| x.chars().filter(|c| c.is_ascii_digit()).collect::<String>().parse::<u32>().unwrap_or(0));
    let base = parts.next().unwrap_or(0);
    let extra = parts.next().unwrap_or(0);
    if base == 0 && extra == 0 {
        (v["value"].as_f64().unwrap_or(0.0) / 60.0).ceil() as u32
    } else {
        base + extra
    }
}

fn pulse_of(commentary: &Value, home_name: &str, away_name: &str) -> Vec<Pulse> {
    let mut out = Vec::new();
    for c in commentary.as_array().into_iter().flatten() {
        let p = &c["play"];
        let kind = s(&p["type"]["type"]);
        let w = match kind.as_str() {
            k if k.starts_with("goal") || k == "penalty---scored" => 5,
            "shot-on-target" => 3,
            "shot-off-target" | "shot-blocked" | "shot-hit-woodwork" => 2,
            "corner-awarded" => 1,
            _ => continue,
        };
        let team = s(&p["team"]["displayName"]);
        let side = if team == home_name { "home" } else if team == away_name { "away" } else { continue };
        let minute = minute_of(if p["clock"].is_object() { &p["clock"] } else { &c["time"] });
        out.push(Pulse { minute, side: side.into(), w });
    }
    out.sort_by_key(|p| p.minute);
    out
}

fn lineup_of(r: &Value) -> Lineup {
    let formation = match &r["formation"] {
        Value::String(x) => x.clone(),
        Value::Object(_) => s(&r["formation"]["name"]),
        _ => String::new(),
    };
    let truthy = |v: &Value| match v {
        Value::Bool(b) => *b,
        Value::Object(_) => true,
        _ => false,
    };
    let mut players: Vec<Player> = r["roster"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|p| Player {
            jersey: s(&p["jersey"]),
            name: { let x = s(&p["athlete"]["shortName"]); if x.is_empty() { s(&p["athlete"]["displayName"]) } else { x } },
            pos: s(&p["position"]["abbreviation"]),
            starter: p["starter"].as_bool().unwrap_or(false),
            sub_in: truthy(&p["subbedIn"]),
            sub_out: truthy(&p["subbedOut"]),
            place: s(&p["formationPlace"]).parse().unwrap_or(99),
        })
        .collect();
    players.sort_by_key(|p| (!p.starter, p.place, p.jersey.parse::<u32>().unwrap_or(99)));
    Lineup { formation, players }
}

fn form_of(v: &Value, team_id: &str) -> Vec<FormGame> {
    let Some(t) = v.as_array().and_then(|a| a.iter().find(|t| s(&t["team"]["id"]) == team_id)) else { return Vec::new() };
    t["events"]
        .as_array()
        .into_iter()
        .flatten()
        .take(5)
        .map(|e| FormGame {
            r: match s(&e["gameResult"]).as_str() { "W" => "s", "L" => "n", _ => "u" }.into(),
            score: s(&e["score"]).replace('-', ":"),
            opp: s(&e["opponent"]["displayName"]),
            home: s(&e["atVs"]) != "@",
            date: feed::parse_utc(&s(&e["gameDate"])).unwrap_or(0),
            comp: s(&e["competitionName"]),
        })
        .collect()
}

/// Amerikanische Quote -> Wahrscheinlichkeit (ohne Buchmacher-Marge, auf 1 normiert)
fn implied(ml: &[f64]) -> Vec<f64> {
    let p: Vec<f64> = ml.iter().map(|&m| if m < 0.0 { -m / (-m + 100.0) } else { 100.0 / (m + 100.0) }).collect();
    let sum: f64 = p.iter().sum();
    if sum <= 0.0 { Vec::new() } else { p.iter().map(|x| x / sum).collect() }
}

#[tauri::command]
pub async fn match_detail(key: String, state: String) -> Result<MatchDetail, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (sport, path, id) = split_key(&key)?;
        let ttl = Duration::from_secs(match state.as_str() { "in" => 25, "pre" => 600, _ => 3600 });
        let v = cached(&feed::agent(), &format!("{ESPN}/{sport}/{path}/summary?event={id}"), ttl)?;
        let comps = &v["header"]["competitions"][0]["competitors"];
        let side = |w: &str| comps.as_array().and_then(|a| a.iter().find(|c| c["homeAway"] == w)).cloned().unwrap_or(Value::Null);
        let (home, away) = (side("home"), side("away"));
        let (home_id, away_id) = (s(&home["team"]["id"]), s(&away["team"]["id"]));
        let mut d = MatchDetail {
            stats: stats_of(&v["boxscore"]["teams"], sport, &home_id),
            pulse: pulse_of(&v["commentary"], &s(&home["team"]["displayName"]), &s(&away["team"]["displayName"])),
            venue: s(&v["gameInfo"]["venue"]["fullName"]),
            city: s(&v["gameInfo"]["venue"]["address"]["city"]),
            referee: v["gameInfo"]["officials"].as_array().and_then(|o| o.first()).map(|o| s(&o["displayName"])).unwrap_or_default(),
            attendance: v["gameInfo"]["attendance"].as_u64().unwrap_or(0),
            form_home: form_of(&v["lastFiveGames"], &home_id),
            form_away: form_of(&v["lastFiveGames"], &away_id),
            ..Default::default()
        };
        for r in v["rosters"].as_array().into_iter().flatten() {
            let l = lineup_of(r);
            if l.players.is_empty() {
                continue;
            }
            if s(&r["homeAway"]) == "home" { d.lineup_home = Some(l) } else { d.lineup_away = Some(l) }
        }
        if let Some(p) = v["pickcenter"].as_array().and_then(|a| a.first()) {
            let ml = |x: &Value| x["moneyLine"].as_f64();
            let (h, a, dr) = (ml(&p["homeTeamOdds"]), ml(&p["awayTeamOdds"]), ml(&p["drawOdds"]));
            if let (Some(h), Some(a)) = (h, a) {
                d.odds = match dr { Some(dr) => implied(&[h, dr, a]), None => { let x = implied(&[h, a]); if x.len() == 2 { vec![x[0], 0.0, x[1]] } else { x } } };
                d.odds_by = s(&p["provider"]["name"]);
            }
        }
        for e in v["seasonseries"][0]["events"].as_array().into_iter().flatten().take(5) {
            let cs = e["competitors"].as_array().cloned().unwrap_or_default();
            let pick = |w: &str| cs.iter().find(|c| c["homeAway"] == w).map(|c| feed::team_of(&json!({ "team": c["team"], "score": c["score"] }), sport));
            if let (Some(h), Some(a)) = (pick("home"), pick("away")) {
                d.h2h.push(H2h { date: feed::parse_utc(&s(&e["date"])).unwrap_or(0), home: h, away: a });
            }
        }
        Ok(d)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- Kader ----------

#[derive(Serialize)]
pub struct RosterPlayer {
    jersey: String,
    name: String,
    /// G | D | M | F (Fussball) bzw. ESPNs Kuerzel
    pos: String,
    pos_name: String,
    age: u32,
    nation: String,
    flag: String,
    injury: String,
}

fn roster_player(a: &Value) -> RosterPlayer {
    let inj = a["injuries"].as_array().and_then(|x| x.first());
    RosterPlayer {
        jersey: s(&a["jersey"]),
        name: s(&a["displayName"]),
        pos: s(&a["position"]["abbreviation"]),
        pos_name: s(&a["position"]["displayName"]),
        age: a["age"].as_u64().unwrap_or(0) as u32,
        nation: s(&a["citizenship"]),
        flag: s(&a["flag"]["href"]),
        injury: inj.map(|i| { let t = s(&i["status"]); if t.is_empty() { s(&i["type"]["description"]) } else { t } }).unwrap_or_default(),
    }
}

#[tauri::command]
pub async fn team_roster(key: String) -> Result<Vec<RosterPlayer>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (sport, id) = key.split_once(':').ok_or("unbekanntes Team")?;
        if sport == "oldb" {
            return Err("Kader gibt es nur für Teams aus ESPN-Wettbewerben.".into());
        }
        if !id.chars().all(|c| c.is_ascii_digit()) {
            return Err("unbekanntes Team".into());
        }
        let agent = feed::agent();
        for path in home_paths(&agent, sport, id) {
            let Ok(v) = cached(&agent, &format!("{ESPN}/{sport}/{path}/teams/{id}/roster"), Duration::from_secs(6 * 3600)) else { continue };
            let mut out = Vec::new();
            for a in v["athletes"].as_array().into_iter().flatten() {
                // US-Sport: nach Positionen gruppiert ({position, items}); Fussball: flach
                if let Some(items) = a["items"].as_array() {
                    out.extend(items.iter().map(roster_player));
                } else {
                    out.push(roster_player(a));
                }
            }
            if !out.is_empty() {
                return Ok(out);
            }
        }
        Err("Kein Kader gefunden.".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- Wettbewerb: Schlagzeilen und Kaderbewegungen ----------

#[derive(Serialize)]
pub struct Article {
    headline: String,
    text: String,
    at: u64,
    link: String,
    image: String,
    transfer: bool,
}

#[derive(Serialize)]
pub struct Move {
    at: u64,
    text: String,
    team: Team,
}

#[derive(Serialize, Default)]
pub struct LeagueNews {
    news: Vec<Article>,
    moves: Vec<Move>,
}

/// Transfer-Meldung? (ESPN schreibt englisch)
pub fn is_transfer(t: &str) -> bool {
    let l = t.to_lowercase();
    ["transfer", "signs ", "signed", "signing", "loan", "joins ", "deal", "contract", "rumor", "rumour", "bid ", "fee", "wechsel"].iter().any(|w| l.contains(w))
}

#[tauri::command]
pub async fn league_news(league: String) -> Result<LeagueNews, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let l = feed::league(&league).ok_or("unbekannter Wettbewerb")?;
        let Some(path) = l.espn.iter().find(|p| **p != "fifa.friendly").or(l.espn.first()) else {
            return Ok(LeagueNews::default());
        };
        let agent = feed::agent();
        let ttl = Duration::from_secs(900);
        let mut out = LeagueNews::default();
        if let Ok(v) = cached(&agent, &format!("{ESPN}/{}/{path}/news?limit=30", l.sport), ttl) {
            for a in v["articles"].as_array().into_iter().flatten() {
                let headline = s(&a["headline"]);
                if headline.is_empty() {
                    continue;
                }
                let text = s(&a["description"]);
                let link = s(&a["links"]["web"]["href"]);
                out.news.push(Article {
                    transfer: is_transfer(&headline) || is_transfer(&text),
                    headline,
                    text,
                    at: feed::parse_utc(&s(&a["published"])).unwrap_or(0),
                    link: if link.starts_with("https://") { link } else { String::new() },
                    image: s(&a["images"][0]["url"]),
                });
            }
        }
        if let Ok(v) = cached(&agent, &format!("{ESPN}/{}/{path}/transactions?limit=40", l.sport), ttl) {
            for t in v["transactions"].as_array().into_iter().flatten() {
                let mut team = t["team"].clone();
                if team["logo"].is_null() {
                    team["logo"] = team["logos"][0]["href"].clone();
                }
                out.moves.push(Move {
                    at: feed::parse_utc(&s(&t["date"])).unwrap_or(0),
                    text: s(&t["description"]),
                    team: feed::team_of(&json!({ "team": team }), l.sport),
                });
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schluessel() {
        assert_eq!(split_key("soccer/ger.1:401884788").unwrap(), ("soccer", "ger.1", "401884788"));
        assert!(split_key("oldb/bl3:77").is_err());
        assert!(split_key("soccer/ger.1:1?x=2").is_err());
    }

    #[test]
    fn quoten_und_minuten() {
        let p = implied(&[-285.0, 400.0, 550.0]);
        assert!((p.iter().sum::<f64>() - 1.0).abs() < 1e-9);
        assert!(p[0] > 0.6 && p[2] < 0.2);
        assert_eq!(minute_of(&json!({ "displayValue": "45'+2'", "value": 2820 })), 47);
        assert_eq!(minute_of(&json!({ "displayValue": "", "value": 476 })), 8);
        assert!(is_transfer("Transfer rumors, news: Arsenal eye move"));
        assert!(!is_transfer("Kane: I'd be proud to win the Ballon d'Or"));
    }

    #[test]
    fn statistik_heim_zuerst() {
        let box_teams = json!([
            { "team": { "id": "2" }, "statistics": [{ "name": "possessionPct", "displayValue": "40.5" }, { "name": "totalShots", "displayValue": "7" }] },
            { "team": { "id": "1" }, "statistics": [{ "name": "possessionPct", "displayValue": "59.5" }, { "name": "totalShots", "displayValue": "12" }] }
        ]);
        let st = stats_of(&box_teams, "soccer", "1");
        assert_eq!(st[0].label, "Ballbesitz");
        assert_eq!(st[0].home, "60 %");
        assert_eq!(st[1].home, "12");
        assert_eq!(st[1].away, "7");
    }

    /// Netz noetig: cargo test --lib info_quellen -- --ignored --nocapture
    #[test]
    #[ignore]
    fn info_quellen() {
        let (d, r, n) = tauri::async_runtime::block_on(async {
            (match_detail("soccer/ger.1:401884788".into(), "post".into()).await, team_roster("soccer:268".into()).await, league_news("nba".into()).await)
        });
        let d = d.expect("Spiel");
        println!("Statistik {}, Chancen {}, Aufstellung {:?}", d.stats.len(), d.pulse.len(), d.lineup_home.as_ref().map(|l| l.formation.clone()));
        println!("Kader {}", r.expect("Kader").len());
        let n = n.expect("News");
        println!("News {}, Bewegungen {}", n.news.len(), n.moves.len());
    }
}
