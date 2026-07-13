use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use serde::{Deserialize, Serialize};
use tauri::ipc::Response;
use tokio::sync::Semaphore;
use walkdir::WalkDir;

static THUMB_SEM: OnceLock<Semaphore> = OnceLock::new();
fn thumb_sem() -> &'static Semaphore {
    THUMB_SEM.get_or_init(|| Semaphore::new(4))
}

// Pool of parsed archive handles for the current zip — avoids reopening the file
// and reparsing the central directory on every load_image call. Up to 4 handles
// (matching frontend load concurrency) so parallel reads stay parallel.
type PooledArchive = (String, zip::ZipArchive<File>);
static ARCHIVE_POOL: OnceLock<Mutex<Vec<PooledArchive>>> = OnceLock::new();
fn archive_pool() -> &'static Mutex<Vec<PooledArchive>> {
    ARCHIVE_POOL.get_or_init(|| Mutex::new(Vec::new()))
}

// Path of the zip currently being read; set by list_zip_images. A stale
// load_image finishing after a zip switch must not flush the new zip's pool.
static CURRENT_ZIP: OnceLock<Mutex<String>> = OnceLock::new();
fn current_zip() -> &'static Mutex<String> {
    CURRENT_ZIP.get_or_init(|| Mutex::new(String::new()))
}

fn take_archive(zip_path: &str) -> Result<zip::ZipArchive<File>, String> {
    {
        let mut pool = archive_pool().lock().unwrap();
        if let Some(pos) = pool.iter().position(|(p, _)| p == zip_path) {
            return Ok(pool.remove(pos).1);
        }
    }
    let file = File::open(zip_path).map_err(|e| format!("{}: {}", zip_path, e))?;
    zip::ZipArchive::new(file).map_err(|e| format!("{}: {}", zip_path, e))
}

fn return_archive(zip_path: &str, archive: zip::ZipArchive<File>) {
    if *current_zip().lock().unwrap() != zip_path {
        return; // stale handle from a previous zip — drop it
    }
    let mut pool = archive_pool().lock().unwrap();
    pool.retain(|(p, _)| p == zip_path); // cache only the current zip
    if pool.len() < 4 {
        pool.push((zip_path.to_string(), archive));
    }
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ZipFileEntry {
    pub name: String,
    pub path: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct FolderEntry {
    pub name: String,
    pub path: String,
    pub zip_files: Vec<ZipFileEntry>,
}

fn natural_sort_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let mut a_iter = a.chars().peekable();
    let mut b_iter = b.chars().peekable();
    loop {
        let a_digit = a_iter.peek().map(|c| c.is_ascii_digit()).unwrap_or(false);
        let b_digit = b_iter.peek().map(|c| c.is_ascii_digit()).unwrap_or(false);
        if a_digit && b_digit {
            let mut a_num = String::new();
            let mut b_num = String::new();
            while a_iter.peek().map(|c| c.is_ascii_digit()).unwrap_or(false) {
                a_num.push(a_iter.next().unwrap());
            }
            while b_iter.peek().map(|c| c.is_ascii_digit()).unwrap_or(false) {
                b_num.push(b_iter.next().unwrap());
            }
            // Compare digit runs as trimmed length + lexical — handles numbers
            // beyond u64 and avoids parse
            let a_trim = a_num.trim_start_matches('0');
            let b_trim = b_num.trim_start_matches('0');
            let ord = a_trim.len().cmp(&b_trim.len()).then_with(|| a_trim.cmp(b_trim));
            if ord != std::cmp::Ordering::Equal {
                return ord;
            }
        } else {
            match (a_iter.next(), b_iter.next()) {
                // Full-string tiebreak keeps order deterministic when runs differ
                // only in leading zeros ("01" vs "1")
                (None, None) => return a.cmp(b),
                (None, _) => return std::cmp::Ordering::Less,
                (_, None) => return std::cmp::Ordering::Greater,
                (Some(ac), Some(bc)) => {
                    let ord = ac.to_ascii_lowercase().cmp(&bc.to_ascii_lowercase());
                    if ord != std::cmp::Ordering::Equal {
                        return ord;
                    }
                }
            }
        }
    }
}

fn is_image_file(name: &str) -> bool {
    matches!(
        Path::new(name)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_lowercase())
            .as_deref(),
        // avif decodes in the webview; cover thumbs for avif may fail (image
        // crate needs a native decoder) and fall back to the placeholder
        Some("jpg") | Some("jpeg") | Some("png") | Some("webp") | Some("gif")
            | Some("bmp") | Some("avif")
    )
}

#[tauri::command]
async fn scan_directory(path: String) -> Result<Vec<FolderEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || scan_directory_blocking(&path))
        .await
        .map_err(|e| e.to_string())?
}

fn scan_directory_blocking(path: &str) -> Result<Vec<FolderEntry>, String> {
    let root = Path::new(path);
    if !root.is_dir() {
        return Err(format!("not a directory: {}", path));
    }
    let mut folder_map: HashMap<String, FolderEntry> = HashMap::new();

    for entry in WalkDir::new(root).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let file_path = entry.path();
        let ext = file_path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_lowercase());
        if !matches!(ext.as_deref(), Some("zip") | Some("cbz")) {
            continue;
        }
        let parent = match file_path.parent() {
            Some(p) => p,
            None => continue,
        };
        let folder_path = parent.to_string_lossy().to_string();
        let folder_name = parent
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("(root)")
            .to_string();
        let zip_name = file_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();

        let folder = folder_map.entry(folder_path.clone()).or_insert_with(|| FolderEntry {
            name: folder_name,
            path: folder_path,
            zip_files: Vec::new(),
        });
        folder.zip_files.push(ZipFileEntry {
            name: zip_name,
            path: file_path.to_string_lossy().to_string(),
        });
    }

    let mut folders: Vec<FolderEntry> = folder_map.into_values().collect();
    for folder in &mut folders {
        folder.zip_files.sort_by(|a, b| natural_sort_cmp(&a.name, &b.name));
    }
    folders.sort_by(|a, b| natural_sort_cmp(&a.name, &b.name).then_with(|| a.path.cmp(&b.path)));
    Ok(folders)
}

#[tauri::command]
async fn list_zip_images(zip_path: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        *current_zip().lock().unwrap() = zip_path.clone();
        // Drop the previous zip's pooled handles now — if opening the new zip
        // fails below, release_zip_handles(old) becomes a no-op (CURRENT_ZIP
        // moved on) and the old file would stay locked on Windows
        archive_pool().lock().unwrap().retain(|(p, _)| p == &zip_path);
        let archive = take_archive(&zip_path)?;
        let mut names: Vec<String> = archive
            .file_names()
            .filter(|n| is_image_file(n))
            .map(|s| s.to_string())
            .collect();
        return_archive(&zip_path, archive); // prewarm pool for the load_image calls that follow
        names.sort_by(|a, b| natural_sort_cmp(a, b));
        Ok(names)
    })
    .await
    .map_err(|e| e.to_string())?
}

// Thumbs are keyed by zip path+mtime, so a changed zip leaves its old thumb
// orphaned forever. Age-based sweep on startup; evicted thumbs regenerate on view.
fn clean_thumb_cache(thumbs_dir: &Path) {
    const MAX_AGE: std::time::Duration = std::time::Duration::from_secs(30 * 24 * 3600);
    let Some(cutoff) = std::time::SystemTime::now().checked_sub(MAX_AGE) else { return };
    let Ok(entries) = std::fs::read_dir(thumbs_dir) else { return };
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .map(|t| t < cutoff)
            .unwrap_or(false);
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

fn thumb_cache_key(path: &str, mtime_secs: u64) -> String {
    // FNV-1a — DefaultHasher's algorithm isn't guaranteed stable across Rust
    // versions, and a toolchain upgrade would silently invalidate every thumb
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in path.as_bytes().iter().chain(mtime_secs.to_le_bytes().iter()) {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{:016x}", h)
}

// Returns a resized JPEG thumbnail (≤150×200). Cached to disk by path+mtime hash.
#[tauri::command]
async fn load_cover_thumb(app: tauri::AppHandle, zip_path: String) -> Result<Response, String> {
    use tauri::Manager;
    let cache_dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    let thumbs_dir = cache_dir.join("thumbs");

    // Cache check first — hits shouldn't queue behind slow decode jobs
    let (cache_file, cached) = {
        let zip_path = zip_path.clone();
        let thumbs_dir = thumbs_dir.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let mtime = std::fs::metadata(&zip_path)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let key = thumb_cache_key(&zip_path, mtime);
            let cache_file = thumbs_dir.join(format!("{}.jpg", key));
            let cached = std::fs::read(&cache_file).ok();
            if let Some(bytes) = &cached {
                // Refresh mtime occasionally so frequently viewed thumbs survive
                // the 30-day sweep (rewrite is cheap; only when >7 days old)
                let is_stale = cache_file
                    .metadata()
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.elapsed().ok())
                    .map(|age| age > std::time::Duration::from_secs(7 * 24 * 3600))
                    .unwrap_or(false);
                if is_stale {
                    let _ = std::fs::write(&cache_file, bytes);
                }
            }
            (cache_file, cached)
        })
        .await
        .map_err(|e| e.to_string())?
    };
    if let Some(bytes) = cached {
        return Ok(Response::new(bytes));
    }

    let _permit = thumb_sem().acquire().await.map_err(|e| e.to_string())?;

    let bytes = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        std::fs::create_dir_all(&thumbs_dir).map_err(|e| e.to_string())?;

        let file = File::open(&zip_path).map_err(|e| format!("{}: {}", zip_path, e))?;
        let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;

        let mut names: Vec<String> = archive
            .file_names()
            .filter(|n| is_image_file(n))
            .map(|s| s.to_string())
            .collect();
        names.sort_by(|a, b| natural_sort_cmp(a, b));

        let first = names.into_iter().next().ok_or("no images in zip")?;
        let mut entry = archive.by_name(&first).map_err(|e| e.to_string())?;
        let mut raw = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut raw).map_err(|e| e.to_string())?;

        let img = image::load_from_memory(&raw).map_err(|e| e.to_string())?;
        let thumb = img.thumbnail(150, 200);

        let mut out: Vec<u8> = Vec::new();
        {
            let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(
                std::io::Cursor::new(&mut out), 80,
            );
            thumb.write_with_encoder(encoder).map_err(|e| e.to_string())?;
        }

        let _ = std::fs::write(&cache_file, &out);
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())??;

    Ok(Response::new(bytes))
}

#[tauri::command]
async fn load_image(zip_path: String, name: String) -> Result<Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let mut archive = take_archive(&zip_path)?;
        let bytes = {
            let mut entry = archive.by_name(&name).map_err(|e| e.to_string())?;
            let mut bytes = Vec::with_capacity(entry.size() as usize);
            entry.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
            bytes
        };
        return_archive(&zip_path, archive);
        Ok(bytes)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(Response::new(bytes))
}

// Called by the frontend whenever its load queue drains. Idle pooled handles
// lock the zip file on Windows (blocks delete/rename in Explorer). CURRENT_ZIP
// stays set so the pool re-warms on the next load burst for the same zip.
#[tauri::command]
fn release_zip_handles(zip_path: String) {
    if *current_zip().lock().unwrap() != zip_path {
        return; // another zip is already loading; leave its pool alone
    }
    archive_pool().lock().unwrap().clear();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .setup(|app| {
            use tauri::Manager;
            if let Ok(cache_dir) = app.path().app_cache_dir() {
                std::thread::spawn(move || clean_thumb_cache(&cache_dir.join("thumbs")));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![scan_directory, list_zip_images, load_image, load_cover_thumb, release_zip_handles])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
