use std::collections::{HashMap, VecDeque};
use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::http::{header, Response as HttpResponse, StatusCode};
use tauri::ipc::Response;
use tokio::sync::Semaphore;
use walkdir::WalkDir;

// A panicking reader would otherwise poison the lock and turn every later
// page request into a panic. The data behind these mutexes is a plain cache —
// recovering the inner value is always safe.
fn lock_ok<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

static THUMB_SEM: OnceLock<Semaphore> = OnceLock::new();
fn thumb_sem() -> &'static Semaphore {
    THUMB_SEM.get_or_init(|| Semaphore::new(4))
}

// The webview fires page requests as fast as it renders <img> tags; cap how
// many zip reads run at once so a scroll burst can't spawn dozens of them.
static PAGE_SEM: OnceLock<Semaphore> = OnceLock::new();
fn page_sem() -> &'static Semaphore {
    PAGE_SEM.get_or_init(|| Semaphore::new(6))
}

// Pool of parsed archive handles for the current zip — avoids reopening the file
// and reparsing the central directory on every page request. Up to 4 handles so
// parallel reads stay parallel.
type PooledArchive = (String, zip::ZipArchive<File>);
static ARCHIVE_POOL: OnceLock<Mutex<Vec<PooledArchive>>> = OnceLock::new();
fn archive_pool() -> &'static Mutex<Vec<PooledArchive>> {
    ARCHIVE_POOL.get_or_init(|| Mutex::new(Vec::new()))
}

// Path of the zip currently being read; set by list_zip_images. A stale
// page request finishing after a zip switch must not flush the new zip's pool.
static CURRENT_ZIP: OnceLock<Mutex<String>> = OnceLock::new();
fn current_zip() -> &'static Mutex<String> {
    CURRENT_ZIP.get_or_init(|| Mutex::new(String::new()))
}

// Zips the user has actually opened, most recent first. `serve_page` gates on
// this rather than on CURRENT_ZIP: the frontend keeps the *previous* zip on
// screen until the new listing and first-page decode land, so its <img> tags
// legitimately request the old zip after CURRENT_ZIP has already moved on.
// Gallery → double mode remounts the whole paged view during that window, so a
// single-value gate 403s every page that is currently being read.
static OPENED_ZIPS: OnceLock<Mutex<VecDeque<String>>> = OnceLock::new();
const OPENED_ZIPS_MAX: usize = 4;
fn opened_zips() -> &'static Mutex<VecDeque<String>> {
    OPENED_ZIPS.get_or_init(|| Mutex::new(VecDeque::new()))
}

fn remember_opened(zip_path: &str) {
    let mut q = lock_ok(opened_zips());
    if let Some(pos) = q.iter().position(|p| p == zip_path) {
        q.remove(pos);
    }
    q.push_front(zip_path.to_string());
    while q.len() > OPENED_ZIPS_MAX {
        q.pop_back();
    }
}

fn is_opened(zip_path: &str) -> bool {
    lock_ok(opened_zips()).iter().any(|p| p == zip_path)
}

// When the last page read finished. Idle pooled handles keep the zip file
// locked on Windows (blocks delete/rename in Explorer), and with the webview
// driving requests there is no frontend "queue drained" moment to hook — so a
// background thread drops them once reads go quiet.
static LAST_READ: OnceLock<Mutex<Instant>> = OnceLock::new();
fn last_read() -> &'static Mutex<Instant> {
    LAST_READ.get_or_init(|| Mutex::new(Instant::now()))
}
const POOL_IDLE_TIMEOUT: Duration = Duration::from_millis(1500);

fn take_archive(zip_path: &str) -> Result<zip::ZipArchive<File>, String> {
    {
        let mut pool = lock_ok(archive_pool());
        if let Some(pos) = pool.iter().position(|(p, _)| p == zip_path) {
            return Ok(pool.remove(pos).1);
        }
    }
    let file = File::open(zip_path).map_err(|e| format!("{}: {}", zip_path, e))?;
    zip::ZipArchive::new(file).map_err(|e| format!("{}: {}", zip_path, e))
}

fn return_archive(zip_path: &str, archive: zip::ZipArchive<File>) {
    *lock_ok(last_read()) = Instant::now();
    if *lock_ok(current_zip()) != zip_path {
        return; // stale handle from a previous zip — drop it
    }
    let mut pool = lock_ok(archive_pool());
    pool.retain(|(p, _)| p == zip_path); // cache only the current zip
    if pool.len() < 4 {
        pool.push((zip_path.to_string(), archive));
    }
}

fn spawn_pool_reaper() {
    std::thread::spawn(|| loop {
        std::thread::sleep(POOL_IDLE_TIMEOUT);
        if lock_ok(last_read()).elapsed() < POOL_IDLE_TIMEOUT {
            continue;
        }
        let mut pool = lock_ok(archive_pool());
        if !pool.is_empty() {
            pool.clear(); // releases the Windows file lock
        }
    });
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

#[derive(Serialize)]
pub struct ZipListing {
    pub names: Vec<String>,
    // Zip mtime, used by the frontend as a cache-busting version in page URLs
    // so responses can be cached forever yet never go stale.
    pub mtime: u64,
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

// Pre-allocation hint for reading a zip entry. The size in the central
// directory is attacker-controlled (a corrupt/malicious zip can claim
// gigabytes), so cap it — read_to_end grows the Vec as needed anyway.
fn alloc_hint(claimed: u64) -> usize {
    claimed.min(64 * 1024 * 1024) as usize
}

// Hard ceiling on a decompressed entry. `alloc_hint` only bounds the initial
// allocation — the decompressed stream itself is unbounded, so a 1 KB entry can
// inflate to gigabytes and OOM the process. No real manga page comes close.
const MAX_ENTRY_BYTES: u64 = 128 * 1024 * 1024;

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

// Archives zipped on macOS carry an `__MACOSX/` shadow tree whose `._name`
// AppleDouble entries keep the original extension — they pass the extension
// check, so every page would show up twice and `._001.jpg` (which sorts first)
// would be picked as the cover and fail to decode.
fn is_junk_entry(name: &str) -> bool {
    if name.ends_with('/') || name.ends_with('\\') {
        return true; // directory entry
    }
    if name.split(['/', '\\']).any(|s| s == "__MACOSX") {
        return true;
    }
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    base.starts_with("._")
        || base.eq_ignore_ascii_case("thumbs.db")
        || base.eq_ignore_ascii_case(".ds_store")
}

fn is_page_entry(name: &str) -> bool {
    is_image_file(name) && !is_junk_entry(name)
}

fn sorted_page_names(archive: &zip::ZipArchive<File>) -> Vec<String> {
    let mut names: Vec<String> = archive
        .file_names()
        .filter(|n| is_page_entry(n))
        .map(|s| s.to_string())
        .collect();
    names.sort_by(|a, b| natural_sort_cmp(a, b));
    names
}

fn read_entry(archive: &mut zip::ZipArchive<File>, name: &str) -> Result<Vec<u8>, String> {
    let entry = archive.by_name(name).map_err(|e| e.to_string())?;
    let mut buf = Vec::with_capacity(alloc_hint(entry.size()));
    // Read one byte past the ceiling so an oversized entry is detected rather
    // than silently truncated into a corrupt image.
    let mut limited = entry.take(MAX_ENTRY_BYTES + 1);
    limited.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    if buf.len() as u64 > MAX_ENTRY_BYTES {
        return Err(format!("entry too large: {}", name));
    }
    Ok(buf)
}

fn mtime_secs(path: &str) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
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
async fn list_zip_images(zip_path: String) -> Result<ZipListing, String> {
    tauri::async_runtime::spawn_blocking(move || {
        *lock_ok(current_zip()) = zip_path.clone();
        remember_opened(&zip_path);
        // Drop the previous zip's pooled handles now — if opening the new zip
        // fails below, the reaper would leave the old file locked for another
        // idle interval while CURRENT_ZIP has already moved on
        lock_ok(archive_pool()).retain(|(p, _)| p == &zip_path);
        let archive = take_archive(&zip_path)?;
        let names = sorted_page_names(&archive);
        return_archive(&zip_path, archive); // prewarm pool for the page requests that follow
        Ok(ZipListing { names, mtime: mtime_secs(&zip_path) })
    })
    .await
    .map_err(|e| e.to_string())?
}

// Thumbs are keyed by zip path+mtime, so a changed zip leaves its old thumb
// orphaned forever. Age-based sweep on startup; evicted thumbs regenerate on view.
fn clean_thumb_cache(thumbs_dir: &Path) {
    const MAX_AGE: Duration = Duration::from_secs(30 * 24 * 3600);
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

// Guards the full-size decode that precedes downscaling: a 4000x6000 source is
// ~96 MB as RGBA, and four of those in parallel would spike past 400 MB.
fn decode_limited(raw: &[u8]) -> Result<image::DynamicImage, String> {
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(256 * 1024 * 1024);
    limits.max_image_width = Some(20_000);
    limits.max_image_height = Some(20_000);

    let mut reader = image::ImageReader::new(std::io::Cursor::new(raw))
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    reader.limits(limits);
    reader.decode().map_err(|e| e.to_string())
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
            let key = thumb_cache_key(&zip_path, mtime_secs(&zip_path));
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
                    .map(|age| age > Duration::from_secs(7 * 24 * 3600))
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

        let first = sorted_page_names(&archive)
            .into_iter()
            .next()
            .ok_or("no images in zip")?;
        let raw = read_entry(&mut archive, &first)?;

        let thumb = {
            let img = decode_limited(&raw)?;
            img.thumbnail(150, 200) // full-size decode dropped right after
        };
        drop(raw);

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

// ---------------------------------------------------------------------------
// manga:// page protocol
//
// Pages go straight to <img src> instead of being shipped over IPC as
// ArrayBuffers. The webview then owns fetching, decode scheduling and memory
// eviction — which is what makes `loading="lazy"` viable in scroll mode and
// removes the need for a hand-rolled load window on the frontend.
// ---------------------------------------------------------------------------

fn mime_for(name: &str) -> &'static str {
    match Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("avif") => "image/avif",
        Some("bmp") => "image/bmp",
        _ => "image/jpeg",
    }
}

fn query_param(query: &str, key: &str) -> Option<String> {
    for pair in query.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            if k == key {
                return percent_encoding::percent_decode_str(v)
                    .decode_utf8()
                    .ok()
                    .map(|s| s.into_owned());
            }
        }
    }
    None
}

fn error_response(status: StatusCode, msg: &str) -> HttpResponse<Vec<u8>> {
    HttpResponse::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(msg.as_bytes().to_vec())
        .unwrap_or_else(|_| HttpResponse::new(Vec::new()))
}

fn serve_page(query: &str) -> HttpResponse<Vec<u8>> {
    let (Some(zip_path), Some(name)) = (query_param(query, "zip"), query_param(query, "name"))
    else {
        return error_response(StatusCode::BAD_REQUEST, "missing zip/name");
    };
    // Only entries the listing itself would have exposed are readable here
    if !is_page_entry(&name) {
        return error_response(StatusCode::FORBIDDEN, "not a page entry");
    }
    // ...and only out of a zip the user actually opened. Without this the
    // scheme is a read primitive for any zip on disk: the webview (or anything
    // that ends up running in it) could name an arbitrary path here.
    if !is_opened(&zip_path) {
        return error_response(StatusCode::FORBIDDEN, "zip not opened");
    }

    let mut archive = match take_archive(&zip_path) {
        Ok(a) => a,
        Err(e) => return error_response(StatusCode::NOT_FOUND, &e),
    };
    // Read, then hand the archive back before branching — an in-scope ZipFile
    // keeps the archive borrowed and blocks the pool return
    let read = read_entry(&mut archive, &name);
    return_archive(&zip_path, archive);
    let bytes = match read {
        Ok(b) => b,
        Err(e) => return error_response(StatusCode::NOT_FOUND, &e),
    };

    HttpResponse::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime_for(&name))
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        // The URL carries the zip's mtime, so a given URL always maps to the
        // same bytes — editing the zip mints new URLs instead of going stale.
        .header(header::CACHE_CONTROL, "max-age=31536000, immutable")
        .body(bytes)
        .unwrap_or_else(|_| {
            error_response(StatusCode::INTERNAL_SERVER_ERROR, "response build failed")
        })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .register_asynchronous_uri_scheme_protocol("manga", |_ctx, request, responder| {
            let query = request.uri().query().unwrap_or("").to_string();
            tauri::async_runtime::spawn(async move {
                let Ok(_permit) = page_sem().acquire().await else {
                    responder.respond(error_response(
                        StatusCode::SERVICE_UNAVAILABLE,
                        "shutting down",
                    ));
                    return;
                };
                let resp = tauri::async_runtime::spawn_blocking(move || serve_page(&query))
                    .await
                    .unwrap_or_else(|e| {
                        error_response(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string())
                    });
                responder.respond(resp);
            });
        })
        .setup(|app| {
            use tauri::Manager;
            if let Ok(cache_dir) = app.path().app_cache_dir() {
                std::thread::spawn(move || clean_thumb_cache(&cache_dir.join("thumbs")));
            }
            spawn_pool_reaper();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan_directory,
            list_zip_images,
            load_cover_thumb
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn junk_entries_are_rejected() {
        assert!(is_junk_entry("__MACOSX/._001.jpg"));
        assert!(is_junk_entry("book/__MACOSX/001.jpg"));
        assert!(is_junk_entry("._001.jpg"));
        assert!(is_junk_entry("book/Thumbs.db"));
        assert!(is_junk_entry("book/"));
        assert!(!is_junk_entry("book/001.jpg"));
        assert!(!is_junk_entry("001.jpg"));
    }

    #[test]
    fn page_entries_need_an_image_extension() {
        assert!(is_page_entry("book/001.JPG"));
        assert!(!is_page_entry("book/info.txt"));
        assert!(!is_page_entry("__MACOSX/._001.jpg"));
    }

    #[test]
    fn natural_sort_is_numeric_aware() {
        let mut v = vec!["10.jpg", "9.jpg", "1.jpg", "002.jpg"];
        v.sort_by(|a, b| natural_sort_cmp(a, b));
        assert_eq!(v, vec!["1.jpg", "002.jpg", "9.jpg", "10.jpg"]);
    }

    // Builds a zip holding one real page plus the macOS shadow entries that
    // used to slip through the extension check.
    fn write_fixture_zip() -> std::path::PathBuf {
        use std::io::Write;
        let path = std::env::temp_dir().join(format!(
            "manga-reader-test-{}.zip",
            std::process::id()
        ));
        let file = File::create(&path).unwrap();
        let mut w = zip::ZipWriter::new(file);
        let opts: zip::write::FileOptions<'_, ()> =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);
        w.start_file("book/002.png", opts).unwrap();
        w.write_all(b"second").unwrap();
        w.start_file("book/001.jpg", opts).unwrap();
        w.write_all(b"first").unwrap();
        w.start_file("__MACOSX/book/._001.jpg", opts).unwrap();
        w.write_all(b"junk").unwrap();
        w.finish().unwrap();
        path
    }

    #[test]
    fn listing_and_protocol_round_trip() {
        let zip_path = write_fixture_zip();
        let zip_str = zip_path.to_string_lossy().to_string();
        // list_zip_images does both of these in production
        *lock_ok(current_zip()) = zip_str.clone();
        remember_opened(&zip_str);

        let archive = take_archive(&zip_str).unwrap();
        let names = sorted_page_names(&archive);
        drop(archive);
        assert_eq!(names, vec!["book/001.jpg", "book/002.png"]);

        let enc = |s: &str| {
            percent_encoding::utf8_percent_encode(s, percent_encoding::NON_ALPHANUMERIC).to_string()
        };
        let ok = serve_page(&format!("zip={}&name={}", enc(&zip_str), enc(&names[0])));
        assert_eq!(ok.status(), StatusCode::OK);
        assert_eq!(ok.headers()[header::CONTENT_TYPE], "image/jpeg");
        assert_eq!(ok.body(), b"first");

        let png = serve_page(&format!("zip={}&name={}", enc(&zip_str), enc(&names[1])));
        assert_eq!(png.headers()[header::CONTENT_TYPE], "image/png");

        // Junk entries are unreachable even when asked for by name
        let junk = serve_page(&format!(
            "zip={}&name={}",
            enc(&zip_str),
            enc("__MACOSX/book/._001.jpg")
        ));
        assert_eq!(junk.status(), StatusCode::FORBIDDEN);

        let missing = serve_page(&format!("zip={}&name=nope.jpg", enc(&zip_str)));
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);

        // A zip the user never opened is off limits, however well-formed the
        // request looks
        let other = serve_page(&format!(
            "zip={}&name={}",
            enc(r"C:\somewhere\else.zip"),
            enc("001.jpg")
        ));
        assert_eq!(other.status(), StatusCode::FORBIDDEN);

        // A previously opened zip stays readable after CURRENT_ZIP moves on —
        // the frontend keeps its pages on screen through the swap window
        *lock_ok(current_zip()) = String::from(r"C:\some\other.zip");
        remember_opened(r"C:\some\other.zip");
        let prev = serve_page(&format!("zip={}&name={}", enc(&zip_str), enc(&names[0])));
        assert_eq!(prev.status(), StatusCode::OK);

        // ...but only for OPENED_ZIPS_MAX zips back
        for i in 0..OPENED_ZIPS_MAX {
            remember_opened(&format!(r"C:\some\filler{}.zip", i));
        }
        let evicted = serve_page(&format!("zip={}&name={}", enc(&zip_str), enc(&names[0])));
        assert_eq!(evicted.status(), StatusCode::FORBIDDEN);

        assert_eq!(serve_page("").status(), StatusCode::BAD_REQUEST);

        lock_ok(archive_pool()).clear();
        let _ = std::fs::remove_file(&zip_path);
    }

    #[test]
    fn query_params_are_percent_decoded() {
        let q = "zip=C%3A%5Cbooks%5Ca%20b.zip&name=001.jpg";
        assert_eq!(query_param(q, "zip").as_deref(), Some(r"C:\books\a b.zip"));
        assert_eq!(query_param(q, "name").as_deref(), Some("001.jpg"));
        assert_eq!(query_param(q, "missing"), None);
    }
}
