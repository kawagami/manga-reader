// Duplicate detection across a scanned root.
//
// Two archives are "identical" when their page sets — (CRC32, uncompressed
// size) of every page entry — are equal, which catches re-zipped and renamed
// copies that a whole-file hash would miss. "Overlap" pairs share most of their
// pages (a 総集編 containing a single volume, a re-release with one extra page).
//
// The page keys come straight out of the central directory, parsed here by
// hand: `zip::ZipArchive::by_index_raw` seeks to every entry's local header to
// find its data, which is ~150 seeks per archive — minutes on a spinning disk
// for a few thousand zips. This reads the EOCD and the directory, two reads per file.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::time::Instant;

use serde::Serialize;
use tauri::ipc::Channel;
use walkdir::WalkDir;

use super::{is_page_entry, natural_sort_cmp};

type PageKey = (u32, u64); // (crc32, uncompressed size)

const SIG_EOCD: u32 = 0x0605_4b50;
const SIG_EOCD64: u32 = 0x0606_4b50;
const SIG_EOCD64_LOCATOR: u32 = 0x0706_4b50;
const SIG_CENTRAL: u32 = 0x0201_4b50;
const EOCD_LEN: usize = 22;
// A real manga zip's directory is well under 1 MB; refuse to allocate for a
// corrupt header claiming gigabytes.
const MAX_CD_BYTES: u64 = 64 * 1024 * 1024;

// Overlap thresholds — see the module comment. A page found in more archives
// than COMMON_PAGE_DF is a scanlator credit / ad page and says nothing about
// whether two books are the same.
const OVERLAP_MIN_RATIO: f64 = 0.6;
const OVERLAP_MIN_SHARED: usize = 5;
const COMMON_PAGE_DF: usize = 15;

fn u16_at(b: &[u8], i: usize) -> u16 {
    u16::from_le_bytes([b[i], b[i + 1]])
}
fn u32_at(b: &[u8], i: usize) -> u32 {
    u32::from_le_bytes(b[i..i + 4].try_into().unwrap())
}
fn u64_at(b: &[u8], i: usize) -> u64 {
    u64::from_le_bytes(b[i..i + 8].try_into().unwrap())
}

fn read_at(f: &mut File, offset: u64, len: usize) -> std::io::Result<Vec<u8>> {
    f.seek(SeekFrom::Start(offset))?;
    let mut buf = vec![0; len];
    f.read_exact(&mut buf)?;
    Ok(buf)
}

/// Sorted (crc32, size) of every page entry, read from the central directory only.
pub(crate) fn read_page_keys(path: &Path) -> Result<Vec<PageKey>, String> {
    let mut f = File::open(path).map_err(|e| e.to_string())?;
    let len = f.metadata().map_err(|e| e.to_string())?.len();
    if len < EOCD_LEN as u64 {
        return Err("too small to be a zip".into());
    }

    // EOCD sits at the end, followed by a comment of at most 64 KiB
    let tail_len = len.min((EOCD_LEN + 0xFFFF) as u64) as usize;
    let tail_start = len - tail_len as u64;
    let tail = read_at(&mut f, tail_start, tail_len).map_err(|e| e.to_string())?;
    let eocd = (0..=tail_len - EOCD_LEN)
        .rev()
        .find(|&i| u32_at(&tail, i) == SIG_EOCD)
        // An incomplete download starts with PK\x03\x04 but has no directory
        .ok_or("no central directory (truncated or not a zip)")?;
    let eocd_pos = tail_start + eocd as u64;

    let mut entries = u64::from(u16_at(&tail, eocd + 10));
    let mut cd_size = u64::from(u32_at(&tail, eocd + 12));
    let mut cd_offset = u64::from(u32_at(&tail, eocd + 16));
    let mut cd_end = eocd_pos; // where the directory must end (start of EOCD / EOCD64)

    if entries == 0xFFFF || cd_size == 0xFFFF_FFFF || cd_offset == 0xFFFF_FFFF {
        let loc = eocd.checked_sub(20).ok_or("zip64 locator missing")?;
        if u32_at(&tail, loc) != SIG_EOCD64_LOCATOR {
            return Err("zip64 locator missing".into());
        }
        let eocd64_pos = u64_at(&tail, loc + 8);
        let rec = read_at(&mut f, eocd64_pos, 56).map_err(|e| e.to_string())?;
        if u32_at(&rec, 0) != SIG_EOCD64 {
            return Err("bad zip64 end record".into());
        }
        entries = u64_at(&rec, 32);
        cd_size = u64_at(&rec, 40);
        cd_offset = u64_at(&rec, 48);
        cd_end = eocd64_pos;
    }
    if cd_size > MAX_CD_BYTES || cd_size > cd_end {
        return Err("central directory size out of range".into());
    }

    // Archives with data prepended (self-extractors, some re-packers) record
    // offsets relative to the original start; the directory always ends right
    // before the end record, so fall back to that.
    let mut cd = read_at(&mut f, cd_offset, cd_size as usize).unwrap_or_default();
    if cd.len() < 4 || u32_at(&cd, 0) != SIG_CENTRAL {
        cd = read_at(&mut f, cd_end - cd_size, cd_size as usize).map_err(|e| e.to_string())?;
    }

    let mut keys = Vec::with_capacity(entries.min(100_000) as usize);
    let mut i = 0;
    while i + 46 <= cd.len() && u32_at(&cd, i) == SIG_CENTRAL {
        let crc = u32_at(&cd, i + 16);
        let mut size = u64::from(u32_at(&cd, i + 24));
        let name_len = usize::from(u16_at(&cd, i + 28));
        let extra_len = usize::from(u16_at(&cd, i + 30));
        let comment_len = usize::from(u16_at(&cd, i + 32));
        let name_end = i + 46 + name_len;
        let extra_end = name_end + extra_len;
        if extra_end > cd.len() {
            return Err("central directory entry out of bounds".into());
        }
        if size == 0xFFFF_FFFF {
            // zip64 extended info: uncompressed size is the first field
            let mut x = name_end;
            while x + 4 <= extra_end {
                let id = u16_at(&cd, x);
                let n = usize::from(u16_at(&cd, x + 2));
                if id == 0x0001 && n >= 8 && x + 12 <= extra_end {
                    size = u64_at(&cd, x + 4);
                    break;
                }
                x += 4 + n;
            }
        }
        // Non-UTF-8 (CP437/Shift-JIS) names lose characters here, but the
        // extension and junk markers is_page_entry looks at are ASCII
        let name = String::from_utf8_lossy(&cd[i + 46..name_end]);
        if is_page_entry(&name) {
            keys.push((crc, size));
        }
        i = extra_end + comment_len;
    }
    keys.sort_unstable();
    Ok(keys)
}

#[derive(Serialize, Clone)]
pub struct DupeItem {
    pub path: String,
    pub name: String,
    pub folder: String,
    pub size: u64,
    pub mtime: u64,
    pub pages: usize,
}

#[derive(Serialize)]
pub struct OverlapPair {
    pub a: usize, // index into DupeReport::items — always the archive with more pages
    pub b: usize,
    pub shared: usize,
    /// Distinct pages in each — `DupeItem::pages` counts entries, and an
    /// archive with the same blank page twice would make a subset look short
    pub a_unique: usize,
    pub b_unique: usize,
    /// every page of `b` is in `a`
    pub subset: bool,
}

#[derive(Serialize)]
pub struct BrokenItem {
    pub item: usize,
    pub error: String,
}

#[derive(Serialize)]
pub struct DupeReport {
    /// Only archives that appear in some result, referenced by index below
    pub items: Vec<DupeItem>,
    pub identical: Vec<Vec<usize>>,
    pub overlaps: Vec<OverlapPair>,
    pub broken: Vec<BrokenItem>,
    pub no_images: Vec<usize>,
    pub scanned: usize,
    pub elapsed_ms: u64,
}

#[derive(Serialize, Clone)]
pub struct DupeProgress {
    pub done: usize,
    pub total: usize,
}

struct Pair {
    big: usize, // index into the scan
    small: usize,
    big_n: usize, // distinct pages
    small_n: usize,
    shared: usize,
    ratio: f64,
}

struct Scanned {
    item: DupeItem,
    keys: Result<Vec<PageKey>, String>,
}

fn list_archives(root: &Path) -> Vec<(std::path::PathBuf, u64, u64)> {
    let mut out = Vec::new();
    for entry in WalkDir::new(root).into_iter().filter_map(|e| e.ok()) {
        if !entry.file_type().is_file() {
            continue;
        }
        let p = entry.path();
        let ext = p.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase());
        if !matches!(ext.as_deref(), Some("zip") | Some("cbz")) {
            continue;
        }
        let meta = entry.metadata().ok();
        let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
        let mtime = meta
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        out.push((p.to_path_buf(), size, mtime));
    }
    out
}

pub(crate) fn find_duplicates_blocking(
    root: &Path,
    progress: Option<&Channel<DupeProgress>>,
) -> Result<DupeReport, String> {
    if !root.is_dir() {
        return Err(format!("not a directory: {}", root.display()));
    }
    let t0 = Instant::now();
    let files = list_archives(root);
    let total = files.len();

    // Sequential on purpose: the library is usually on one disk, and parallel
    // reads of scattered tails would only add seeking.
    let mut scanned: Vec<Scanned> = Vec::with_capacity(total);
    for (n, (path, size, mtime)) in files.into_iter().enumerate() {
        let keys = read_page_keys(&path);
        let item = DupeItem {
            name: path.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
            folder: path
                .parent()
                .and_then(|p| p.file_name())
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default(),
            path: path.to_string_lossy().into_owned(),
            size,
            mtime,
            pages: keys.as_ref().map(|k| k.len()).unwrap_or(0),
        };
        scanned.push(Scanned { item, keys });
        if let Some(ch) = progress {
            if (n + 1) % 50 == 0 || n + 1 == total {
                let _ = ch.send(DupeProgress { done: n + 1, total });
            }
        }
    }

    let mut report = analyze(&scanned);
    report.scanned = total;
    report.elapsed_ms = t0.elapsed().as_millis() as u64;
    Ok(report)
}

fn analyze(scanned: &[Scanned]) -> DupeReport {
    // Archives that make it into the report get a slot in `items`
    let mut items: Vec<DupeItem> = Vec::new();
    let mut slot: HashMap<usize, usize> = HashMap::new();
    let mut idx_of = |i: usize, items: &mut Vec<DupeItem>| -> usize {
        *slot.entry(i).or_insert_with(|| {
            items.push(scanned[i].item.clone());
            items.len() - 1
        })
    };

    let mut broken = Vec::new();
    let mut no_images = Vec::new();
    for (i, s) in scanned.iter().enumerate() {
        match &s.keys {
            Err(e) => {
                let item = idx_of(i, &mut items);
                broken.push(BrokenItem { item, error: e.clone() });
            }
            Ok(k) if k.is_empty() => no_images.push(idx_of(i, &mut items)),
            Ok(_) => {}
        }
    }

    // --- identical page sets ---
    let mut by_keys: HashMap<&[PageKey], Vec<usize>> = HashMap::new();
    for (i, s) in scanned.iter().enumerate() {
        if let Ok(k) = &s.keys {
            if !k.is_empty() {
                by_keys.entry(k.as_slice()).or_default().push(i);
            }
        }
    }
    let mut groups: Vec<Vec<usize>> = by_keys.into_values().filter(|g| g.len() > 1).collect();
    let wasted = |g: &Vec<usize>| -> u64 {
        let sizes = g.iter().map(|&i| scanned[i].item.size);
        sizes.clone().sum::<u64>() - sizes.max().unwrap_or(0)
    };
    groups.sort_by(|a, b| wasted(b).cmp(&wasted(a)));
    let identical = groups
        .iter()
        .map(|g| {
            let mut g = g.clone();
            g.sort_by(|&a, &b| natural_sort_cmp(&scanned[a].item.path, &scanned[b].item.path));
            g.into_iter().map(|i| idx_of(i, &mut items)).collect()
        })
        .collect();

    // --- high overlap ---
    // keys are sorted and may repeat (the same blank page twice), so dedup per archive
    let sets: Vec<(usize, Vec<PageKey>)> = scanned
        .iter()
        .enumerate()
        .filter_map(|(i, s)| match &s.keys {
            Ok(k) if !k.is_empty() => {
                let mut k = k.clone();
                k.dedup();
                Some((i, k))
            }
            _ => None,
        })
        .collect();
    let mut df: HashMap<PageKey, usize> = HashMap::new();
    for (_, k) in &sets {
        for key in k {
            *df.entry(*key).or_default() += 1;
        }
    }
    let mut index: HashMap<PageKey, Vec<usize>> = HashMap::new(); // key -> positions in `sets`
    for (pos, (_, k)) in sets.iter().enumerate() {
        for key in k {
            if df[key] <= COMMON_PAGE_DF {
                index.entry(*key).or_default().push(pos);
            }
        }
    }
    let mut pairs = Vec::new();
    let mut shared_with: HashMap<usize, usize> = HashMap::new();
    for (pa, (ia, ka)) in sets.iter().enumerate() {
        shared_with.clear();
        for key in ka {
            if let Some(list) = index.get(key) {
                for &pb in list {
                    if pb > pa {
                        *shared_with.entry(pb).or_default() += 1;
                    }
                }
            }
        }
        for (&pb, &shared) in &shared_with {
            let (ib, kb) = &sets[pb];
            if ka == kb {
                continue; // already an identical group
            }
            let smaller = ka.len().min(kb.len());
            let ratio = shared as f64 / smaller as f64;
            if shared >= OVERLAP_MIN_SHARED && ratio >= OVERLAP_MIN_RATIO {
                let ((big, big_n), (small, small_n)) = if ka.len() >= kb.len() {
                    ((*ia, ka.len()), (*ib, kb.len()))
                } else {
                    ((*ib, kb.len()), (*ia, ka.len()))
                };
                pairs.push(Pair { big, small, big_n, small_n, shared, ratio });
            }
        }
    }
    // subsets first, then by ratio, then by how many pages are at stake
    pairs.sort_by(|x, y| {
        (y.shared == y.small_n)
            .cmp(&(x.shared == x.small_n))
            .then_with(|| y.ratio.total_cmp(&x.ratio))
            .then_with(|| y.shared.cmp(&x.shared))
    });
    let overlaps = pairs
        .into_iter()
        .map(|p| OverlapPair {
            a: idx_of(p.big, &mut items),
            b: idx_of(p.small, &mut items),
            shared: p.shared,
            a_unique: p.big_n,
            b_unique: p.small_n,
            subset: p.shared == p.small_n,
        })
        .collect();

    DupeReport { items, identical, overlaps, broken, no_images, scanned: 0, elapsed_ms: 0 }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_zip(name: &str, pages: &[(&str, &[u8])], deflate: bool) -> std::path::PathBuf {
        let path = std::env::temp_dir()
            .join(format!("manga-reader-dupes-{}-{}", std::process::id(), name));
        let file = File::create(&path).unwrap();
        let mut w = zip::ZipWriter::new(file);
        let method = if deflate { zip::CompressionMethod::Deflated } else { zip::CompressionMethod::Stored };
        let opts: zip::write::FileOptions<'_, ()> =
            zip::write::FileOptions::default().compression_method(method);
        for (n, data) in pages {
            w.start_file(*n, opts).unwrap();
            w.write_all(data).unwrap();
        }
        w.set_comment("trailing comment so the EOCD isn't the last 22 bytes");
        w.finish().unwrap();
        path
    }

    // Manual check against a real library:
    // DUPES_ROOT=D:\comic cargo test --lib dupes::tests::real_library -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_library() {
        let root = std::env::var("DUPES_ROOT").expect("set DUPES_ROOT");
        let r = find_duplicates_blocking(Path::new(&root), None).unwrap();
        println!(
            "scanned {} in {}ms: identical {} groups, overlaps {} ({} subset), broken {}, no images {}",
            r.scanned,
            r.elapsed_ms,
            r.identical.len(),
            r.overlaps.len(),
            r.overlaps.iter().filter(|o| o.subset).count(),
            r.broken.len(),
            r.no_images.len()
        );
        for b in &r.broken {
            println!("  broken: {} — {}", r.items[b.item].name, b.error);
        }
    }

    #[test]
    fn page_keys_match_the_zip_crate() {
        let p = write_zip(
            "keys.zip",
            &[("b/002.png", b"second page"), ("b/001.jpg", b"first"), ("__MACOSX/b/._001.jpg", b"x"), ("info.txt", b"t")],
            true,
        );
        let keys = read_page_keys(&p).unwrap();
        let mut a = zip::ZipArchive::new(File::open(&p).unwrap()).unwrap();
        let mut expected: Vec<PageKey> = ["b/002.png", "b/001.jpg"]
            .iter()
            .map(|n| {
                let e = a.by_name(n).unwrap();
                (e.crc32(), e.size())
            })
            .collect();
        expected.sort_unstable();
        assert_eq!(keys, expected);
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn truncated_zip_is_reported() {
        let p = write_zip("trunc.zip", &[("001.jpg", &[7u8; 4096])], false);
        let bytes = std::fs::read(&p).unwrap();
        std::fs::write(&p, &bytes[..2048]).unwrap();
        assert!(read_page_keys(&p).is_err());
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn prepended_data_falls_back_to_eocd_relative_directory() {
        let p = write_zip("sfx.zip", &[("001.jpg", b"page")], false);
        let mut bytes = b"MZ fake stub".to_vec();
        bytes.extend(std::fs::read(&p).unwrap());
        std::fs::write(&p, &bytes).unwrap();
        assert_eq!(read_page_keys(&p).unwrap().len(), 1);
        let _ = std::fs::remove_file(p);
    }

    #[test]
    fn groups_identical_and_overlapping_archives() {
        let pages: Vec<(String, Vec<u8>)> =
            (0..10).map(|i| (format!("{:03}.jpg", i), format!("page {}", i).into_bytes())).collect();
        let as_refs = |r: std::ops::Range<usize>| -> Vec<(&str, &[u8])> {
            pages[r].iter().map(|(n, d)| (n.as_str(), d.as_slice())).collect()
        };
        let dir = std::env::temp_dir().join(format!("manga-reader-dupes-root-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("x")).unwrap();
        std::fs::create_dir_all(dir.join("y")).unwrap();
        let mv = |src: std::path::PathBuf, dst: &str| std::fs::rename(src, dir.join(dst)).unwrap();
        // same pages, different compression and names → identical
        mv(write_zip("a.zip", &as_refs(0..10), true), "x/full.zip");
        mv(write_zip("b.zip", &as_refs(0..10), false), "y/full copy.zip");
        // first 8 pages only → subset of the above
        mv(write_zip("c.zip", &as_refs(0..8), true), "y/part.zip");
        // unrelated
        mv(write_zip("d.zip", &[("001.jpg", b"other")], true), "x/other.zip");
        std::fs::write(dir.join("x/broken.zip"), b"PK\x03\x04 not really").unwrap();

        let r = find_duplicates_blocking(&dir, None).unwrap();
        assert_eq!(r.scanned, 5);
        assert_eq!(r.identical.len(), 1);
        let names: Vec<&str> = r.identical[0].iter().map(|&i| r.items[i].name.as_str()).collect();
        assert_eq!(names, vec!["full.zip", "full copy.zip"]);
        // part.zip overlaps both copies of full
        assert_eq!(r.overlaps.len(), 2);
        for o in &r.overlaps {
            assert!(o.subset);
            assert_eq!(o.shared, 8);
            assert_eq!(r.items[o.b].name, "part.zip");
        }
        assert_eq!(r.broken.len(), 1);
        assert_eq!(r.items[r.broken[0].item].name, "broken.zip");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
