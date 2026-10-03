//! Laya — optionales KI-Modell, das Schlagzeilen einordnet (Transfer fix/Geruecht, Verlaengerung, Verletzung,
//! Spiel, Sonstiges). Die Einordnung selbst laeuft im WebView (src/laya/, onnxruntime-web); hier nur:
//!
//! - Wunsch merken (`laya.json`: an/aus). Der Installer setzt ihn ueber eine Auswahldatei (`laya-choice`,
//!   installer-hooks.nsh: Haken auf der Willkommensseite, standardmaessig gesetzt), die beim Start uebernommen wird.
//! - Paket laden: sechs Dateien vom GitHub-Release `laya-model-1`, jede mit fester Groesse und SHA-256 (unten
//!   festgeschrieben, sonst wird nichts benutzt). Abgebrochene Downloads setzen fort (Range).
//! - Deinstallieren: Ordner loeschen. Das Deinstallationsprogramm loescht ihn ebenfalls (ausser bei Updates).
//!
//! Ablage: %LOCALAPPDATA%\de.nojo.arena\laya (vom WebView ueber das Asset-Protokoll lesbar, nur dieser Ordner).
//! Paket bauen: tools/laya/build_model.py

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

const BASE: &str = "https://github.com/NojoMcDybo/arena/releases/download/laya-model-1";

/// Quelle des Pakets; ARENA_LAYA_BASE ueberschreibt sie (nur zum Testen gegen einen lokalen Server)
fn base_url() -> String {
    std::env::var("ARENA_LAYA_BASE").ok().filter(|b| b.starts_with("http")).unwrap_or_else(|| BASE.into())
}

/// (Name im Release, Name auf der Platte, Groesse, SHA-256)
const FILES: &[(&str, &str, u64, &str)] = &[
    ("laya-en-int4.rl_agent_config.json", "rl_agent_config.json", 745, "ae287b56bbcf5f8c4f4541ae9dfd00c914c4c48b940b8398c3058af37ba92bbd"),
    ("laya-en-int4.tokenizer.json", "tokenizer.json", 3_583_228, "6c8aaa9a542084f2457eab775d4eeb51f92a70c0fd9de28d5edb0ddec3c08d30"),
    ("laya-en-int4.LICENSE.txt", "LICENSE.txt", 11_667, "09f2fa48a41552bae157124660d6a31906890c187e33c2c3c2e6cfbf6aaae055"),
    ("laya-en-int4.ort-1.30.0.wasm", "ort.wasm", 14_239_897, "3398c10d07d229bd91b364548e130e0e51a8e5704b88c7c083ebbeb78842dee2"),
    ("laya-en-int4.head.onnx", "head.onnx", 39_027_462, "188123d33fb89157d272a9e0f0a40d07744a762e9d7cb9f01b32e544e6521f3b"),
    ("laya-en-int4.encoder.onnx", "encoder.onnx", 249_853_451, "c6812454c7bb96e2cf8677c5408805510c3827b7e4773f44e1e8135201c34516"),
];
/// Kennung des Pakets: aendert sich mit jedem neuen Modell (alte Ordner werden dann ersetzt)
const PACKAGE: &str = "laya-en-int4@fa9a2a7+ort-1.30.0";

pub fn total_size() -> u64 {
    FILES.iter().map(|f| f.2).sum()
}

#[derive(Serialize, Clone, Default)]
pub struct Status {
    /// Nutzer moechte das Modell
    want: bool,
    /// off | missing | downloading | ready | error
    state: String,
    done: u64,
    total: u64,
    message: String,
    /// Ordner (fuer convertFileSrc im WebView), nur wenn bereit
    dir: String,
}

static STATUS: Mutex<Option<Status>> = Mutex::new(None);
static RUNNING: AtomicBool = AtomicBool::new(false);
static CANCEL: AtomicBool = AtomicBool::new(false);

fn base_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_local_data_dir().ok()
}
fn model_dir(app: &AppHandle) -> Option<PathBuf> {
    base_dir(app).map(|d| d.join("laya"))
}

fn read_want(app: &AppHandle) -> bool {
    base_dir(app)
        .and_then(|d| fs::read_to_string(d.join("laya.json")).ok())
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|v| v["want"].as_bool())
        .unwrap_or(false)
}

fn write_want(app: &AppHandle, want: bool) {
    if let Some(d) = base_dir(app) {
        let _ = fs::create_dir_all(&d);
        let _ = fs::write(d.join("laya.json"), serde_json::json!({ "want": want }).to_string());
    }
}

/// Bereit = Paketkennung stimmt und alle Dateien haben ihre Groesse (Pruefsummen beim Laden geprueft)
fn is_ready(dir: &Path) -> bool {
    fs::read_to_string(dir.join("package.txt")).is_ok_and(|p| p.trim() == PACKAGE)
        && FILES.iter().all(|f| fs::metadata(dir.join(f.1)).is_ok_and(|m| m.len() == f.2))
}

fn compute(app: &AppHandle) -> Status {
    let want = read_want(app);
    let dir = model_dir(app);
    let ready = dir.as_deref().is_some_and(is_ready);
    Status {
        want,
        state: if ready { "ready" } else if want { "missing" } else { "off" }.into(),
        done: if ready { total_size() } else { 0 },
        total: total_size(),
        message: String::new(),
        dir: if ready { dir.map(|d| d.to_string_lossy().into_owned()).unwrap_or_default() } else { String::new() },
    }
}

fn set(app: &AppHandle, s: Status) {
    *STATUS.lock().unwrap() = Some(s.clone());
    let _ = app.emit("laya", s);
}

fn current(app: &AppHandle) -> Status {
    let g = STATUS.lock().unwrap().clone();
    g.unwrap_or_else(|| compute(app))
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_connect(Some(Duration::from_secs(20)))
        .timeout_recv_response(Some(Duration::from_secs(30)))
        .timeout_recv_body(Some(Duration::from_secs(3 * 3600)))
        .user_agent(concat!("Arena/", env!("CARGO_PKG_VERSION"), " (Windows)"))
        .build()
        .into()
}

fn hash_file(path: &Path, h: &mut Sha256) -> std::io::Result<u64> {
    let mut f = File::open(path)?;
    let mut buf = vec![0u8; 1 << 20];
    let mut n = 0u64;
    loop {
        let k = f.read(&mut buf)?;
        if k == 0 {
            return Ok(n);
        }
        h.update(&buf[..k]);
        n += k as u64;
    }
}

fn hex(d: &[u8]) -> String {
    d.iter().map(|b| format!("{b:02x}")).collect()
}

/// Eine Datei laden (fortsetzen, wenn ein Teil da ist) und pruefen. `progress` bekommt die Bytes dieser Datei.
fn fetch_one(agent: &ureq::Agent, base: &str, dir: &Path, f: &(&str, &str, u64, &str), progress: &mut dyn FnMut(u64)) -> Result<(), String> {
    let (asset, name, size, sha) = *f;
    let dest = dir.join(name);
    if fs::metadata(&dest).is_ok_and(|m| m.len() == size) {
        return Ok(()); // schon geprueft geladen (Groesse genuegt hier; is_ready verlangt zusaetzlich package.txt)
    }
    let part = dir.join(format!("{name}.part"));
    let mut h = Sha256::new();
    let mut have = if part.exists() { hash_file(&part, &mut h).map_err(|e| e.to_string())? } else { 0 };
    if have > size {
        let _ = fs::remove_file(&part);
        h = Sha256::new();
        have = 0;
    }
    if have < size {
        let url = format!("{base}/{asset}");
        let mut req = agent.get(&url);
        if have > 0 {
            req = req.header("Range", format!("bytes={have}-"));
        }
        let res = req.call().map_err(|e| format!("Download fehlgeschlagen ({asset}): {e}"))?;
        if have > 0 && res.status().as_u16() != 206 {
            // Server kann nicht fortsetzen: von vorn
            h = Sha256::new();
            have = 0;
        }
        let mut out = OpenOptions::new().create(true).write(true).append(have > 0).truncate(have == 0).open(&part).map_err(|e| e.to_string())?;
        let mut r = res.into_body().into_reader();
        let mut buf = vec![0u8; 256 * 1024];
        let mut last = Instant::now();
        loop {
            if CANCEL.load(Ordering::SeqCst) {
                return Err("abgebrochen".into());
            }
            let k = r.read(&mut buf).map_err(|e| format!("Download unterbrochen: {e}"))?;
            if k == 0 {
                break;
            }
            out.write_all(&buf[..k]).map_err(|e| e.to_string())?;
            h.update(&buf[..k]);
            have += k as u64;
            if have > size {
                break;
            }
            if last.elapsed() > Duration::from_millis(300) {
                last = Instant::now();
                progress(have);
            }
        }
        out.flush().map_err(|e| e.to_string())?;
    }
    if have != size || hex(&h.finalize()) != sha {
        let _ = fs::remove_file(&part);
        return Err(format!("Prüfsumme stimmt nicht ({name}) – Datei verworfen."));
    }
    fs::rename(&part, &dest).map_err(|e| e.to_string())?;
    Ok(())
}

/// Ganzes Paket nach `dir` laden; `progress(geladen, gesamt)`
fn fetch_all(dir: &Path, base: &str, progress: &mut dyn FnMut(u64, u64)) -> Result<(), String> {
    // anderes (altes) Paket: Ordner leeren
    if fs::read_to_string(dir.join("package.txt")).is_ok_and(|p| p.trim() != PACKAGE) {
        let _ = fs::remove_dir_all(dir);
    }
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let agent = agent();
    let mut before = 0u64;
    for f in FILES {
        progress(before, total_size());
        fetch_one(&agent, base, dir, f, &mut |n| progress(before + n, total_size()))?;
        before += f.2;
    }
    fs::write(dir.join("package.txt"), PACKAGE).map_err(|e| e.to_string())?;
    Ok(())
}

fn download(app: AppHandle) {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return;
    }
    CANCEL.store(false, Ordering::SeqCst);
    let result = match model_dir(&app) {
        None => Err("kein Datenordner".to_string()),
        Some(dir) => fetch_all(&dir, &base_url(), &mut |done, total| {
            set(&app, Status { want: true, state: "downloading".into(), done, total, ..Default::default() });
        }),
    };
    RUNNING.store(false, Ordering::SeqCst);
    match result {
        Ok(()) => set(&app, compute(&app)),
        Err(_) if CANCEL.load(Ordering::SeqCst) => set(&app, compute(&app)),
        Err(e) => set(&app, Status { want: true, state: "error".into(), total: total_size(), message: e, ..Default::default() }),
    }
}

fn remove(app: &AppHandle) {
    CANCEL.store(true, Ordering::SeqCst);
    // laufenden Download kurz ausklingen lassen (er prueft CANCEL nach jedem Block)
    for _ in 0..40 {
        if !RUNNING.load(Ordering::SeqCst) {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    if let Some(d) = model_dir(app) {
        let _ = fs::remove_dir_all(d);
    }
}

#[tauri::command]
pub fn laya_status(app: AppHandle) -> Status {
    current(&app)
}

/// Modell laden (Wunsch merken, Download im Hintergrund)
#[tauri::command]
pub fn laya_install(app: AppHandle) -> Status {
    write_want(&app, true);
    let s = compute(&app);
    set(&app, s.clone());
    if s.state != "ready" {
        std::thread::spawn(move || download(app));
    }
    s
}

/// Modell entfernen (Wunsch merken, Download abbrechen, Ordner loeschen)
#[tauri::command]
pub async fn laya_uninstall(app: AppHandle) -> Result<Status, String> {
    write_want(&app, false);
    let a = app.clone();
    tauri::async_runtime::spawn_blocking(move || remove(&a)).await.map_err(|e| e.to_string())?;
    let s = compute(&app);
    set(&app, s.clone());
    Ok(s)
}

/// Beim Start: Auswahl aus dem Installer uebernehmen; ist das Modell gewuenscht, aber nicht da, nachladen
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        if let Some(d) = base_dir(&app) {
            let choice = d.join("laya-choice");
            if let Ok(t) = fs::read_to_string(&choice) {
                let want = t.trim() == "1";
                write_want(&app, want);
                if !want {
                    remove(&app);
                }
                let _ = fs::remove_file(&choice);
            }
        }
        let s = compute(&app);
        set(&app, s.clone());
        if s.state == "missing" {
            // nicht gleich beim Start: erst die Spielstaende
            std::thread::sleep(Duration::from_secs(8));
            if read_want(&app) {
                download(app);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paket_vollstaendig() {
        assert_eq!(FILES.len(), 6);
        assert!(FILES.iter().all(|f| f.3.len() == 64 && f.3.chars().all(|c| c.is_ascii_hexdigit())));
        assert!(total_size() > 300_000_000 && total_size() < 320_000_000);
        // jede Datei, die laya-ts / der Worker braucht
        for n in ["encoder.onnx", "head.onnx", "tokenizer.json", "rl_agent_config.json", "ort.wasm"] {
            assert!(FILES.iter().any(|f| f.1 == n), "{n} fehlt");
        }
    }

    /// Gegen einen lokalen Server mit dem Paket (tools/laya/README.md):
    /// ARENA_LAYA_BASE=http://127.0.0.1:8767 cargo test --lib laya_download -- --ignored --nocapture
    #[test]
    #[ignore]
    fn laya_download() {
        let base = std::env::var("ARENA_LAYA_BASE").expect("ARENA_LAYA_BASE setzen");
        let dir = std::env::temp_dir().join("arena-laya-download");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        // halber Teil liegt schon da: muss fortgesetzt werden und trotzdem die Pruefsumme treffen
        let enc = FILES.iter().find(|f| f.1 == "encoder.onnx").unwrap();
        let src = reqwest_like(&format!("{base}/{}", enc.0), 1_000_000);
        fs::write(dir.join("encoder.onnx.part"), src).unwrap();
        let mut calls = 0;
        let t = Instant::now();
        fetch_all(&dir, &base, &mut |_, _| calls += 1).expect("Download");
        assert!(is_ready(&dir));
        println!("geladen in {:?}, {calls} Fortschrittsmeldungen", t.elapsed());
        // kaputte Datei wird erkannt und verworfen
        fs::remove_file(dir.join("LICENSE.txt")).unwrap();
        fs::write(dir.join("LICENSE.txt.part"), vec![b'x'; 11_667]).unwrap();
        assert!(fetch_all(&dir, &base, &mut |_, _| {}).is_err());
        assert!(!dir.join("LICENSE.txt.part").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    /// erste n Bytes einer Adresse
    fn reqwest_like(url: &str, n: usize) -> Vec<u8> {
        let mut res = agent().get(url).call().unwrap();
        let mut buf = vec![0u8; n];
        res.body_mut().as_reader().read_exact(&mut buf).unwrap();
        buf
    }

    #[test]
    fn pruefsumme() {
        let p = std::env::temp_dir().join("arena-laya-test.bin");
        fs::write(&p, b"abc").unwrap();
        let mut h = Sha256::new();
        assert_eq!(hash_file(&p, &mut h).unwrap(), 3);
        assert_eq!(hex(&h.finalize()), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        let _ = fs::remove_file(p);
    }
}
