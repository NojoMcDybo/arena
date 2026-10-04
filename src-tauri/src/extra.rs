//! Arena: Spielplan, Tabellen und Teams (zusaetzlich zu den Live-Spielen aus feed.rs).
//!
//! - Spielplan: ESPN kennt pro Wettbewerb einen Kalender der Spieltage (scoreboard -> leagues[0].calendar).
//!   Zeitraeume (dates=A-B) lehnt ESPN ab, also wird jeder Spieltag im Fenster einzeln geholt und zwischengespeichert.
//!   OpenLigaDB liefert die ganze Saison in einer Antwort.
//! - Tabellen: ESPN /apis/v2/.../standings (mit Zonen wie „Champions League“ samt Farbe), OpenLigaDB getbltable.
//! - Teams: naechste Spiele und letzte Ergebnisse (ESPN teams/{id}/schedule, OpenLigaDB getmatchesbyteamid).

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};

use crate::feed::{self, League, Match, ESPN, LEAGUES, OLDB};

const DAY: u64 = 86_400_000;

// ---------- Zwischenspeicher (pro Adresse, mit Haltbarkeit) ----------

static CACHE: Mutex<Option<HashMap<String, (Instant, Duration, Value)>>> = Mutex::new(None);

pub(crate) fn cached(agent: &ureq::Agent, url: &str, ttl: Duration) -> Result<Value, String> {
    if let Some((at, keep, v)) = CACHE.lock().unwrap().get_or_insert_with(HashMap::new).get(url) {
        if at.elapsed() < *keep {
            return Ok(v.clone());
        }
    }
    let v = feed::get_json(agent, url)?;
    let mut g = CACHE.lock().unwrap();
    let map = g.get_or_insert_with(HashMap::new);
    if map.len() > 600 {
        map.retain(|_, (at, keep, _)| at.elapsed() < *keep);
    }
    map.insert(url.to_string(), (Instant::now(), ttl, v.clone()));
    Ok(v)
}

/// Tage seit 1970 -> (Jahr, Monat, Tag) (Howard Hinnant, civil_from_days)
fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// ms seit 1970 -> "20261003" (UTC-Tag)
pub fn ymd(ms: u64) -> String {
    let (y, m, d) = civil((ms / DAY) as i64);
    format!("{y:04}{m:02}{d:02}")
}

/// Saison beginnt im Sommer (OpenLigaDB zaehlt mit dem Startjahr)
pub(crate) fn season(now: u64) -> i64 {
    let (y, m, _) = civil((now / DAY) as i64);
    if m >= 7 { y } else { y - 1 }
}

fn ttl_for(day_ms: u64, now: u64) -> Duration {
    if day_ms + DAY < now {
        Duration::from_secs(6 * 3600) // vorbei: aendert sich kaum
    } else if day_ms > now + DAY {
        Duration::from_secs(30 * 60)
    } else {
        Duration::from_secs(60) // heute
    }
}

// ---------- Spielplan ----------

fn tag(mut ms: Vec<Match>, l: &League) -> Vec<Match> {
    let favs = feed::cfg().favs;
    ms.retain(|m| l.team.is_none_or(|t| m.home.name == t || m.away.name == t));
    for m in ms.iter_mut() {
        m.league = l.id.into();
        m.league_name = l.name.into();
        m.fav = feed::is_fav(&m.home, &favs) || feed::is_fav(&m.away, &favs);
    }
    ms
}

/// Spiele eines Wettbewerbs zwischen from und to (ms)
fn league_matches(agent: &ureq::Agent, l: &League, from: u64, to: u64, now: u64) -> Vec<Match> {
    let mut out = Vec::new();
    if l.espn.is_empty() {
        if let Some(sc) = l.oldb {
            if let Ok(v) = cached(agent, &format!("{OLDB}/getmatchdata/{sc}/{}", season(now)), Duration::from_secs(600)) {
                out = feed::parse_oldb(&v, sc, now).into_iter().filter(|m| m.start >= from && m.start <= to).collect();
            }
        }
        return tag(out, l);
    }
    for path in l.espn {
        let base = format!("{ESPN}/{}/{path}/scoreboard", l.sport);
        let Ok(v) = cached(agent, &base, Duration::from_secs(600)) else { continue };
        out.extend(feed::parse_espn(&v, l.sport, path));
        let cal = &v["leagues"][0]["calendar"];
        let mut urls: Vec<(String, u64)> = Vec::new();
        for c in cal.as_array().into_iter().flatten() {
            match c {
                // Fussball, Basketball, Eishockey: ein Eintrag pro Spieltag
                Value::String(d) => {
                    if let Some(t) = feed::parse_utc(d) {
                        if t + DAY >= from && t <= to {
                            urls.push((format!("{base}?dates={}", ymd(t)), t));
                        }
                    }
                }
                // Football: Wochen mit Beginn/Ende
                Value::Object(_) => {
                    let st = feed::s(&c["value"]);
                    for e in c["entries"].as_array().into_iter().flatten() {
                        let (a, b) = (feed::parse_utc(&feed::s(&e["startDate"])), feed::parse_utc(&feed::s(&e["endDate"])));
                        if let (Some(a), Some(b)) = (a, b) {
                            if b >= from && a <= to {
                                urls.push((format!("{base}?seasontype={st}&week={}", feed::s(&e["value"])), a));
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        // ohne Kalender (oder sehr viele Spieltage, z. B. NBA): Tag fuer Tag, hoechstens drei Wochen
        if urls.is_empty() || urls.len() > 24 {
            urls = (0..)
                .map(|i| from + i * DAY)
                .take_while(|t| *t <= to)
                .take(24)
                .map(|t| (format!("{base}?dates={}", ymd(t)), t))
                .collect();
        }
        for (u, t) in urls {
            if let Ok(v) = cached(agent, &u, ttl_for(t, now)) {
                out.extend(feed::parse_espn(&v, l.sport, path));
            }
        }
    }
    let mut seen = std::collections::HashSet::new();
    out.retain(|m| seen.insert(m.key.clone()) && m.start + DAY >= from && m.start <= to);
    tag(out, l)
}

/// Alle Spiele der gewaehlten Wettbewerbe: eine Woche zurueck bis drei Wochen voraus
#[tauri::command]
pub async fn schedule() -> Result<Vec<Match>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let now = crate::now_ms();
        let (from, to) = (now.saturating_sub(8 * DAY), now + 22 * DAY);
        let ids = feed::cfg().leagues;
        let ls: Vec<&League> = ids.iter().filter_map(|id| feed::league(id)).collect();
        let mut all: Vec<Match> = std::thread::scope(|sc| {
            let hs: Vec<_> = ls.iter().map(|l| sc.spawn(move || league_matches(&feed::agent(), l, from, to, now))).collect();
            hs.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect()
        });
        let mut pairs = std::collections::HashSet::new();
        all.retain(|m| pairs.insert((feed::norm_name(&m.home.name), feed::norm_name(&m.away.name), m.start / 3_600_000)));
        all.sort_by_key(|m| m.start);
        Ok(all)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- Tabellen ----------

#[derive(Serialize, Default)]
pub struct Row {
    rank: u32,
    team: feed::Team,
    played: String,
    won: String,
    draw: String,
    lost: String,
    goals: String,
    diff: String,
    points: String,
    /// US-Sport: Siegquote, Rueckstand
    pct: String,
    behind: String,
    /// Zone (z. B. „Champions League“) und ihre Farbe
    note: String,
    color: String,
    fav: bool,
}

#[derive(Serialize)]
pub struct Group {
    name: String,
    rows: Vec<Row>,
}

fn stat<'a>(e: &'a Value, name: &str) -> &'a Value {
    e["stats"].as_array().and_then(|a| a.iter().find(|x| x["name"] == name)).unwrap_or(&Value::Null)
}

fn espn_rows(entries: &Value, sport: &str, favs: &[(String, String)]) -> Vec<Row> {
    let mut rows: Vec<Row> = Vec::new();
    for e in entries.as_array().into_iter().flatten() {
        let mut t = e["team"].clone();
        if t["logo"].is_null() {
            t["logo"] = t["logos"][0]["href"].clone();
        }
        let team = feed::team_of(&json!({ "team": t }), sport);
        let dv = |n: &str| feed::s(&stat(e, n)["displayValue"]);
        let goals = if dv("pointsFor").is_empty() { String::new() } else { format!("{}:{}", dv("pointsFor"), dv("pointsAgainst")) };
        rows.push(Row {
            rank: stat(e, "rank")["value"].as_f64().map(|v| v as u32).unwrap_or(0),
            fav: feed::is_fav(&team, favs),
            team,
            played: dv("gamesPlayed"),
            won: dv("wins"),
            draw: dv("ties"),
            lost: dv("losses"),
            goals,
            diff: dv("pointDifferential"),
            points: dv("points"),
            pct: dv("winPercent"),
            behind: dv("gamesBehind"),
            note: feed::s(&e["note"]["description"]),
            color: feed::hex(&feed::s(&e["note"]["color"])),
        });
    }
    if sport == "soccer" && rows.iter().all(|r| r.rank > 0) {
        rows.sort_by_key(|r| r.rank);
    } else if sport != "soccer" {
        // US: nach Siegquote (Eishockey: Punkte)
        let key = |r: &Row| if sport == "hockey" { r.points.parse::<f64>().unwrap_or(0.0) } else { r.pct.parse::<f64>().unwrap_or(0.0) };
        rows.sort_by(|a, b| key(b).partial_cmp(&key(a)).unwrap_or(std::cmp::Ordering::Equal));
    }
    for (i, r) in rows.iter_mut().enumerate() {
        r.rank = i as u32 + 1;
    }
    rows
}

/// Gruppen einsammeln: Liga (eine Tabelle), Gruppenphase oder Conferences (mehrere)
fn espn_groups(v: &Value, sport: &str, favs: &[(String, String)], out: &mut Vec<Group>) {
    if v["standings"]["entries"].is_array() {
        let rows = espn_rows(&v["standings"]["entries"], sport, favs);
        if !rows.is_empty() {
            out.push(Group { name: feed::s(&v["name"]), rows });
        }
    }
    for c in v["children"].as_array().into_iter().flatten() {
        espn_groups(c, sport, favs, out);
    }
}

#[tauri::command]
pub async fn standings(league: String) -> Result<Vec<Group>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let l = feed::league(&league).ok_or("unbekannter Wettbewerb")?;
        let agent = feed::agent();
        let favs = feed::cfg().favs;
        let ttl = Duration::from_secs(600);
        let mut out = Vec::new();
        if let Some(path) = l.espn.first().filter(|_| l.team.is_none() && l.id != "dfb") {
            let v = cached(&agent, &format!("https://site.api.espn.com/apis/v2/sports/{}/{path}/standings", l.sport), ttl)?;
            espn_groups(&v, l.sport, &favs, &mut out);
            if out.len() == 1 {
                out[0].name = l.name.into();
            }
        } else if let (Some(sc), true) = (l.oldb, l.espn.is_empty()) {
            let v = cached(&agent, &format!("{OLDB}/getbltable/{sc}/{}", season(crate::now_ms())), ttl)?;
            let mut rows = Vec::new();
            for (i, t) in v.as_array().into_iter().flatten().enumerate() {
                let short = { let x = feed::s(&t["shortName"]); if x.is_empty() { feed::s(&t["teamName"]) } else { x } };
                let team = feed::Team {
                    id: format!("oldb:{}", feed::s(&t["teamInfoId"])),
                    name: feed::s(&t["teamName"]),
                    abbr: short.chars().filter(|c| c.is_alphanumeric()).take(3).collect::<String>().to_uppercase(),
                    short,
                    logo: feed::s(&t["teamIconUrl"]),
                    ..Default::default()
                };
                let goals = t["goals"].as_i64().unwrap_or(0);
                let against = t["opponentGoals"].as_i64().unwrap_or(0);
                rows.push(Row {
                    rank: i as u32 + 1,
                    fav: feed::is_fav(&team, &favs),
                    team,
                    played: feed::s(&t["matches"]),
                    won: feed::s(&t["won"]),
                    draw: feed::s(&t["draw"]),
                    lost: feed::s(&t["lost"]),
                    goals: format!("{goals}:{against}"),
                    diff: format!("{:+}", goals - against),
                    points: feed::s(&t["points"]),
                    ..Default::default()
                });
            }
            out.push(Group { name: l.name.into(), rows });
        } else {
            return Err("Für diesen Wettbewerb gibt es keine Tabelle.".into());
        }
        if out.is_empty() {
            return Err("Noch keine Tabelle.".into());
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ---------- Teams ----------

#[derive(Serialize)]
pub struct TeamView {
    next: Vec<Match>,
    last: Vec<Match>,
}

/// ESPN liefert Ergebnisse mit score als Objekt ({value, displayValue}); parse_espn erwartet Text
fn flatten_scores(v: &mut Value) {
    for e in v["events"].as_array_mut().into_iter().flatten() {
        for c in e["competitions"][0]["competitors"].as_array_mut().into_iter().flatten() {
            if c["score"].is_object() {
                c["score"] = c["score"]["displayValue"].clone();
            }
        }
    }
}

/// In welcher ESPN-Liga spielt dieses Team? (gewaehlte Wettbewerbe zuerst, dann alle Vereinsligen)
pub(crate) fn home_paths(agent: &ureq::Agent, sport: &str, id: &str) -> Vec<&'static str> {
    let chosen = feed::cfg().leagues;
    let mut ls: Vec<&League> = LEAGUES.iter().filter(|l| l.sport == sport && l.team.is_none() && l.id != "turnier").collect();
    ls.sort_by_key(|l| !chosen.iter().any(|c| c == l.id));
    for l in ls {
        for path in l.espn {
            let Ok(v) = cached(agent, &format!("{ESPN}/{sport}/{path}/teams"), Duration::from_secs(24 * 3600)) else { continue };
            let hit = v.pointer("/sports/0/leagues/0/teams").and_then(|x| x.as_array()).into_iter().flatten().any(|t| feed::s(&t["team"]["id"]) == id);
            if hit {
                return vec![path];
            }
        }
    }
    // Nationalmannschaft: alle Laenderspiel-Wettbewerbe
    LEAGUES.iter().find(|l| l.id == "dfbteam").map(|l| l.espn.to_vec()).unwrap_or_default()
}

#[tauri::command]
pub async fn team_view(key: String) -> Result<TeamView, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let agent = feed::agent();
        let now = crate::now_ms();
        let favs = feed::cfg().favs;
        let mut all: Vec<Match> = Vec::new();
        let (sport, id) = key.split_once(':').ok_or("unbekanntes Team")?;
        if sport == "oldb" {
            let v = cached(&agent, &format!("{OLDB}/getmatchesbyteamid/{id}/6/6"), Duration::from_secs(600))?;
            all = feed::parse_oldb(&v, "team", now);
        } else {
            for path in home_paths(&agent, sport, id) {
                for q in ["?fixture=true", ""] {
                    let url = format!("{ESPN}/{sport}/{path}/teams/{id}/schedule{q}");
                    let ttl = Duration::from_secs(if q.is_empty() { 1800 } else { 600 });
                    if let Ok(mut v) = cached(&agent, &url, ttl) {
                        flatten_scores(&mut v);
                        for mut m in feed::parse_espn(&v, sport, path) {
                            if let Some(l) = LEAGUES.iter().find(|l| l.espn.contains(&path) && l.team.is_none()) {
                                m.league = l.id.into();
                                m.league_name = l.name.into();
                            }
                            all.push(m);
                        }
                    }
                }
            }
        }
        let mut seen = std::collections::HashSet::new();
        all.retain(|m| seen.insert(m.key.clone()));
        for m in all.iter_mut() {
            m.fav = feed::is_fav(&m.home, &favs) || feed::is_fav(&m.away, &favs);
        }
        let mut next: Vec<Match> = all.iter().filter(|m| m.state != "post" && m.start + 3 * 3_600_000 >= now).cloned().collect();
        next.sort_by_key(|m| m.start);
        next.truncate(5);
        let mut last: Vec<Match> = all.into_iter().filter(|m| m.state == "post").collect();
        last.sort_by_key(|m| std::cmp::Reverse(m.start));
        last.truncate(5);
        Ok(TeamView { next, last })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tage_und_saison() {
        assert_eq!(ymd(feed::parse_utc("2026-10-03T12:00Z").unwrap()), "20261003");
        assert_eq!(ymd(feed::parse_utc("2024-02-29T23:59Z").unwrap()), "20240229");
        assert_eq!(season(feed::parse_utc("2026-10-03T12:00Z").unwrap()), 2026);
        assert_eq!(season(feed::parse_utc("2027-03-01T12:00Z").unwrap()), 2026);
    }

    #[test]
    fn ergebnisse_als_text() {
        let mut v = json!({ "events": [{ "competitions": [{ "competitors": [{ "score": { "value": 2.0, "displayValue": "2" } }, { "score": "1" }] }] }] });
        flatten_scores(&mut v);
        assert_eq!(v["events"][0]["competitions"][0]["competitors"][0]["score"], "2");
        assert_eq!(v["events"][0]["competitions"][0]["competitors"][1]["score"], "1");
    }

    /// Gegen die echten Quellen (Netz noetig): cargo test --lib quellen -- --ignored --nocapture
    #[test]
    #[ignore]
    fn quellen() {
        let rt = tauri::async_runtime::block_on(async {
            let t = standings("bl1".into()).await;
            let s = schedule().await;
            let v = team_view("soccer:268".into()).await;
            (t, s, v)
        });
        let t = rt.0.expect("Tabelle");
        println!("Tabelle: {} Zeilen, 1. {} {}", t[0].rows.len(), t[0].rows[0].team.name, t[0].rows[0].points);
        let s = rt.1.expect("Spielplan");
        println!("Spielplan: {} Spiele", s.len());
        let v = rt.2.expect("Team");
        println!("Gladbach: {} kommend, {} vorbei", v.next.len(), v.last.len());
    }
}
