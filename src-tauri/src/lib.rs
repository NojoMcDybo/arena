//! Arena — Live-Sport, Spielplan und Tabellen im Nojo-Oekosystem.
//!
//! - feed.rs:     Live-Spiele, Ticker und Ballverlauf (dieselben Quellen wie die Notch)
//! - extra.rs:    Spielplan, Tabellen, Teams
//! - more.rs:     Liga-Logos, Stadien (Wikidata + OpenStreetMap), Kaderwerte fuer die Radare
//! - laya.rs:     optionales KI-Modell fuer Schlagzeilen (Download, Pruefung, Deinstallation)
//! - info.rs:     Spieldetails (Statistik, Druckphasen, Aufstellung, Prognose), Kader, Schlagzeilen
//! - settings.rs: Sport-Einstellungen, abgeglichen mit der Notch (127.0.0.1:47800)
//! - update.rs:   Selbst-Update ueber GitHub Releases (NojoMcDybo/arena)
//!
//! Die Notch oeffnet ein Spiel hier ueber arena://spiel/<schluessel> (Deep Link; zweiter Start reicht ihn an
//! das laufende Fenster weiter).

mod extra;
mod feed;
mod info;
mod laya;
mod more;
mod settings;
mod update;

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Spiel aus einem Deep Link, bis das Fenster es abholt
static PENDING: Mutex<Option<String>> = Mutex::new(None);

/// "arena://spiel/soccer%2Fger.1%3A123" -> "soccer/ger.1:123"
fn match_of(url: &str) -> Option<String> {
    let rest = url.strip_prefix("arena://")?;
    let key = rest.strip_prefix("spiel/")?.trim_end_matches('/');
    let mut out = Vec::new();
    let b = key.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&key[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    let k = String::from_utf8(out).ok()?;
    // nur Schluessel aus feed.rs: "sport/liga:id" bzw. "oldb/kuerzel:id"
    let ok = k.len() < 80 && k.contains(':') && k.chars().all(|c| c.is_ascii_alphanumeric() || "/:._-".contains(c));
    ok.then_some(k)
}

fn show(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn open_links(app: &AppHandle, urls: impl IntoIterator<Item = String>) {
    for u in urls {
        if let Some(k) = match_of(&u) {
            *PENDING.lock().unwrap() = Some(k.clone());
            let _ = app.emit("open-match", k);
        }
    }
    show(app);
}

/// Spiel, das per Deep Link geoeffnet werden soll (einmal abholen)
#[tauri::command]
fn take_pending() -> Option<String> {
    PENDING.lock().unwrap().take()
}

#[tauri::command]
fn open_link(app: AppHandle, url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("nur https-Adressen".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// Spiele eines Teams als Kalenderdatei (.ics, vom Frontend gebaut) in Downloads\Arena speichern und oeffnen
/// (Windows nimmt die Standard-Kalender-App). Gibt den Pfad zurueck.
#[tauri::command]
fn export_ics(app: AppHandle, name: String, ics: String) -> Result<String, String> {
    if !ics.starts_with("BEGIN:VCALENDAR") || ics.len() > 200_000 {
        return Err("keine Kalenderdatei".into());
    }
    let safe: String = name.chars().map(|c| if c.is_alphanumeric() || c == ' ' || c == '-' { c } else { '_' }).collect::<String>().trim().chars().take(60).collect();
    let dir = app.path().download_dir().map_err(|e| e.to_string())?.join("Arena");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{} – Spiele.ics", if safe.is_empty() { "Team".into() } else { safe }));
    // Zeilenenden nach RFC 5545 (CRLF), egal wie das Frontend sie liefert
    let crlf = ics.replace("\r\n", "\n").replace('\n', "\r\n");
    std::fs::write(&path, crlf).map_err(|e| e.to_string())?;
    let p = path.to_string_lossy().into_owned();
    let _ = app.opener().open_path(&p, None::<&str>);
    Ok(p)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Nur eine Arena; ein zweiter Start (z. B. Deep Link aus der Notch) holt die laufende nach vorn
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            open_links(app, args.into_iter().filter(|a| a.starts_with("arena://")));
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            feed::sport_watch,
            feed::sport_leagues,
            feed::sport_teams,
            extra::schedule,
            extra::standings,
            extra::team_view,
            info::match_detail,
            info::team_roster,
            info::league_news,
            more::league_meta,
            more::venue_info,
            more::squad_stats,
            laya::laya_status,
            laya::laya_install,
            laya::laya_uninstall,
            settings::settings_get,
            settings::settings_set,
            update::update_state,
            update::update_check,
            update::update_install,
            take_pending,
            open_link,
            export_ics,
        ])
        .setup(|app| {
            let h = app.handle().clone();
            settings::load(&h);
            settings::spawn_sync(h.clone());
            feed::spawn(h.clone());
            update::spawn(h.clone());
            laya::spawn(h.clone());
            // Schema arena:// fuer diesen Benutzer anmelden (der Installer tut es auch; so klappt es auch im Test)
            #[cfg(desktop)]
            let _ = app.deep_link().register_all();
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                if let Some(k) = urls.iter().find_map(|u| match_of(u.as_str())) {
                    *PENDING.lock().unwrap() = Some(k);
                }
            }
            let h2 = h.clone();
            app.deep_link().on_open_url(move |e| open_links(&h2, e.urls().into_iter().map(|u| u.to_string())));
            show(&h);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Arena konnte nicht starten");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deep_links() {
        assert_eq!(match_of("arena://spiel/soccer%2Fger.1%3A740123"), Some("soccer/ger.1:740123".into()));
        assert_eq!(match_of("arena://spiel/oldb/bl3:77/"), Some("oldb/bl3:77".into()));
        assert_eq!(match_of("arena://spiel/%3Cscript%3E"), None);
        assert_eq!(match_of("https://spiel/x:1"), None);
    }
}
