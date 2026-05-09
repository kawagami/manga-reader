use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::Path;
use serde::{Deserialize, Serialize};
use tauri::ipc::Response;
use walkdir::WalkDir;

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
            let ord = a_num.parse::<u64>().unwrap_or(0).cmp(&b_num.parse::<u64>().unwrap_or(0));
            if ord != std::cmp::Ordering::Equal {
                return ord;
            }
        } else {
            match (a_iter.next(), b_iter.next()) {
                (None, None) => return std::cmp::Ordering::Equal,
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
        Some("jpg") | Some("jpeg") | Some("png") | Some("webp") | Some("gif")
    )
}

#[tauri::command]
fn scan_directory(path: String) -> Result<Vec<FolderEntry>, String> {
    let root = Path::new(&path);
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
    folders.sort_by(|a, b| natural_sort_cmp(&a.name, &b.name));
    Ok(folders)
}

#[tauri::command]
async fn list_zip_images(zip_path: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let file = File::open(&zip_path).map_err(|e| e.to_string())?;
        let archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
        let mut names: Vec<String> = archive
            .file_names()
            .filter(|n| is_image_file(n))
            .map(|s| s.to_string())
            .collect();
        names.sort_by(|a, b| natural_sort_cmp(a, b));
        Ok(names)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn load_image(zip_path: String, name: String) -> Result<Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let file = File::open(&zip_path).map_err(|e| e.to_string())?;
        let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
        let mut entry = archive.by_name(&name).map_err(|e| e.to_string())?;
        let mut bytes = Vec::with_capacity(entry.size() as usize);
        entry.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        Ok(bytes)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(Response::new(bytes))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .invoke_handler(tauri::generate_handler![scan_directory, list_zip_images, load_image])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
