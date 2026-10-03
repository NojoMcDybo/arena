//! Sport-Einstellungen: dieselben wie in der Notch (Einstellungen › Sport) — Wettbewerbe, Lieblingsteams und
//! wie sich die Notch verhaelt. Laeuft die Notch, ist sie die Quelle (http://127.0.0.1:47800/sport/settings,
//! nur Loopback): Arena liest alle paar Sekunden nach und schickt eigene Aenderungen sofort hin. Laeuft sie
//! nicht, merkt sich Arena die Aenderung (dirty) und schickt sie beim naechsten Kontakt.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

struct State {
    sport: Value,
    /// hier geaendert, aber noch nicht bei der Notch angekommen
    dirty: bool,
    /// Notch antwortet
    notch: bool,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);
static FILE: Mutex<Option<PathBuf>> = Mutex::new(None);

pub fn defaults() -> Value {
    json!({ "on": true, "leagues": ["bl1", "dfbteam"], "teams": [], "scope": "all", "expand": "goals", "center": true, "pitch": true, "fullscreen": true })
}

/// Gleiche Regeln wie normalize() in der Notch (settings-model.ts): nur bekannte Felder, begrenzte Laengen
pub fn sanitize(v: &Value) -> Value {
    let d = defaults();
    let b = |k: &str| v[k].as_bool().unwrap_or_else(|| d[k].as_bool().unwrap_or(true));
    let id_ok = |x: &str| (2..=12).contains(&x.len()) && x.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit());
    let mut leagues: Vec<String> = Vec::new();
    match v["leagues"].as_array() {
        Some(a) => {
            for x in a.iter().filter_map(|x| x.as_str()) {
                if id_ok(x) && !leagues.iter().any(|l| l == x) {
                    leagues.push(x.to_string());
                }
            }
        }
        None => leagues = vec!["bl1".into(), "dfbteam".into()],
    }
    let cut = |s: &str, n: usize| s.chars().take(n).collect::<String>();
    let mut teams: Vec<Value> = Vec::new();
    for t in v["teams"].as_array().into_iter().flatten() {
        let (Some(key), Some(name)) = (t["key"].as_str(), t["name"].as_str()) else { continue };
        if key.is_empty() || teams.iter().any(|x| x["key"] == key) {
            continue;
        }
        let mut o = json!({ "key": cut(key, 40), "name": cut(name, 60) });
        if let Some(l) = t["logo"].as_str() {
            o["logo"] = cut(l, 300).into();
        }
        teams.push(o);
        if teams.len() >= 20 {
            break;
        }
    }
    let expand = match v["expand"].as_str() {
        Some(e @ ("off" | "goals" | "important" | "all")) => e,
        _ => "goals",
    };
    json!({
        "on": b("on"),
        "leagues": leagues,
        "teams": teams,
        "scope": if v["scope"] == "fav" { "fav" } else { "all" },
        "expand": expand,
        "center": b("center"),
        "pitch": b("pitch"),
        "fullscreen": b("fullscreen"),
    })
}

pub fn load(app: &AppHandle) {
    let f = app.path().app_data_dir().ok().map(|d| d.join("config.json"));
    let saved: Value = f.as_ref().and_then(|f| std::fs::read(f).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or(Value::Null);
    let sport = if saved["sport"].is_object() { sanitize(&saved["sport"]) } else { defaults() };
    *STATE.lock().unwrap() = Some(State { sport, dirty: saved["dirty"].as_bool().unwrap_or(false), notch: false });
    *FILE.lock().unwrap() = f;
}

fn save() {
    let (sport, dirty) = match STATE.lock().unwrap().as_ref() {
        Some(s) => (s.sport.clone(), s.dirty),
        None => return,
    };
    if let Some(f) = FILE.lock().unwrap().as_ref() {
        if let Some(d) = f.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let _ = std::fs::write(f, json!({ "sport": sport, "dirty": dirty }).to_string());
    }
}

/// Aktuelle Sport-Einstellungen (fuer feed.rs und extra.rs)
pub fn sport() -> Value {
    STATE.lock().unwrap().as_ref().map(|s| s.sport.clone()).unwrap_or_else(defaults)
}

fn snapshot() -> Value {
    let g = STATE.lock().unwrap();
    match g.as_ref() {
        Some(s) => json!({ "sport": s.sport, "notch": s.notch, "pending": s.dirty }),
        None => json!({ "sport": defaults(), "notch": false, "pending": false }),
    }
}

// ---------- Notch (Loopback, eigene kleine HTTP-Anfrage wie in Helio) ----------

fn notch(method: &str, body: &str) -> Result<Value, String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], 47800));
    let t = Duration::from_millis(600);
    let mut s = TcpStream::connect_timeout(&addr, t).map_err(|e| e.to_string())?;
    s.set_read_timeout(Some(Duration::from_secs(2))).map_err(|e| e.to_string())?;
    s.set_write_timeout(Some(t)).map_err(|e| e.to_string())?;
    write!(
        s,
        "{method} /sport/settings HTTP/1.1\r\nHost: 127.0.0.1:47800\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .map_err(|e| e.to_string())?;
    let mut raw = Vec::new();
    s.take(256 * 1024).read_to_end(&mut raw).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&raw);
    let (head, body) = text.split_once("\r\n\r\n").ok_or("keine Antwort")?;
    let code = head.split_whitespace().nth(1).unwrap_or("");
    if code != "200" {
        // aeltere Notch ohne diese Schnittstelle: 404
        return Err(format!("Notch antwortet {code}"));
    }
    serde_json::from_str(body).map_err(|e| e.to_string())
}

fn set_notch(app: &AppHandle, up: bool) {
    let changed = {
        let mut g = STATE.lock().unwrap();
        match g.as_mut() {
            Some(s) if s.notch != up => {
                s.notch = up;
                true
            }
            _ => false,
        }
    };
    if changed {
        let _ = app.emit("settings", snapshot());
    }
}

/// Eigene Aenderung zur Notch schicken; klappt es nicht, beim naechsten Kontakt
fn push(app: &AppHandle) {
    let sport = sport();
    match notch("PUT", &sport.to_string()) {
        Ok(_) => {
            if let Some(s) = STATE.lock().unwrap().as_mut() {
                s.dirty = false;
            }
            save();
            set_notch(app, true);
        }
        Err(_) => set_notch(app, false),
    }
}

pub fn spawn_sync(app: AppHandle) {
    std::thread::spawn(move || loop {
        let dirty = STATE.lock().unwrap().as_ref().is_some_and(|s| s.dirty);
        if dirty {
            push(&app);
        } else {
            match notch("GET", "") {
                Ok(v) if v.is_object() => {
                    let theirs = sanitize(&v);
                    let changed = {
                        let mut g = STATE.lock().unwrap();
                        match g.as_mut() {
                            Some(s) if s.sport != theirs && !s.dirty => {
                                s.sport = theirs;
                                true
                            }
                            _ => false,
                        }
                    };
                    if changed {
                        save();
                        let _ = app.emit("settings", snapshot());
                    }
                    set_notch(&app, true);
                }
                _ => set_notch(&app, false),
            }
        }
        std::thread::sleep(Duration::from_secs(4));
    });
}

#[tauri::command]
pub fn settings_get() -> Value {
    snapshot()
}

#[tauri::command]
pub fn settings_set(app: AppHandle, sport: Value) -> Value {
    let clean = sanitize(&sport);
    if let Some(s) = STATE.lock().unwrap().as_mut() {
        s.sport = clean;
        s.dirty = true;
    }
    save();
    std::thread::spawn({
        let app = app.clone();
        move || {
            push(&app);
            let _ = app.emit("settings", snapshot());
        }
    });
    snapshot()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn einstellungen_bereinigt() {
        let v = sanitize(&json!({
            "on": false, "leagues": ["bl1", "bl1", "BÖSE", "x"], "scope": "fav", "expand": "boom",
            "teams": [{ "key": "soccer:268", "name": "Gladbach", "logo": "l" }, { "key": "soccer:268", "name": "doppelt" }, { "name": "ohne Schluessel" }],
            "fremd": 1
        }));
        assert_eq!(v["on"], false);
        assert_eq!(v["leagues"], json!(["bl1"]));
        assert_eq!(v["teams"].as_array().unwrap().len(), 1);
        assert_eq!(v["scope"], "fav");
        assert_eq!(v["expand"], "goals");
        assert!(v.get("fremd").is_none());
        assert_eq!(sanitize(&Value::Null)["leagues"], json!(["bl1", "dfbteam"]));
    }
}
