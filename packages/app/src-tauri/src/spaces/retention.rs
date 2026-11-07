//! Keep a space small: 90 days or 200 MB, whichever comes first (founder decision 13).
//! Control ops are never touched: the roster must always replay from genesis.
use std::collections::BTreeMap;

use rusqlite::params;

use super::ids::DeviceKey;
use super::limits::{KEEP_BYTES, KEEP_MS, TRIM_TO_BYTES};
use super::store::SpaceStore;

/// Entries deleted per round when the size rule applies.
const SIZE_BATCH: i64 = 500;

#[derive(Debug, Default, PartialEq, Eq)]
pub struct PruneReport {
    pub old_entries: u64,
    pub size_entries: u64,
    pub files: u64,
    pub bytes_after: u64,
}

pub fn used_bytes(s: &SpaceStore) -> rusqlite::Result<u64> {
    let e: i64 = s.conn.query_row("SELECT COALESCE(SUM(size), 0) FROM entries", [], |r| r.get(0))?;
    let f: i64 = s.conn.query_row("SELECT COALESCE(SUM(size), 0) FROM files WHERE have = 1", [], |r| r.get(0))?;
    Ok((e + f) as u64)
}

/// `delete_file` removes a cached file from disk (the service passes a closure; tests pass a recorder).
/// Steps 1 to 4 run in one transaction; the incremental vacuum runs after it commits.
pub fn prune(s: &SpaceStore, now_ms: u64, delete_file: &dyn Fn(&[u8; 32])) -> rusqlite::Result<PruneReport> {
    let mut report = PruneReport::default();
    s.in_tx(|s| {
        report.old_entries = prune_by_age(s, now_ms)?;
        report.files = prune_files(s, delete_file)?;
        report.size_entries = prune_by_size(s)?;
        s.conn.execute("DELETE FROM reactions WHERE target NOT IN (SELECT id FROM entries)", [])?;
        s.conn.execute("DELETE FROM files WHERE offer NOT IN (SELECT id FROM entries) AND have = 0", [])?;
        Ok(())
    })?;
    s.conn.execute_batch("PRAGMA incremental_vacuum(2000);")?;
    report.bytes_after = used_bytes(s)?;
    Ok(report)
}

/// 1. Anything older than KEEP_MS goes, and each author's floor rises to the newest seq that went, so sync never
/// asks for it again. "Gone" placeholders (created_ms 0) stay: they cost nothing and keep deleted seqs answered.
fn prune_by_age(s: &SpaceStore, now_ms: u64) -> rusqlite::Result<u64> {
    let cutoff = now_ms.saturating_sub(KEEP_MS) as i64;
    s.conn.execute(
        "UPDATE authors SET floor = MAX(floor, COALESCE((SELECT MAX(seq) FROM entries \
         WHERE device = authors.device AND created_ms > 0 AND created_ms < ?1), 0))",
        params![cutoff],
    )?;
    let n = s.conn.execute("DELETE FROM entries WHERE created_ms > 0 AND created_ms < ?1", params![cutoff])?;
    Ok(n as u64)
}

/// 2. Over the limit: cached files go first, oldest first, until the space is back under the trim size.
fn prune_files(s: &SpaceStore, delete_file: &dyn Fn(&[u8; 32])) -> rusqlite::Result<u64> {
    if used_bytes(s)? <= KEEP_BYTES { return Ok(0); }
    let shas: Vec<Vec<u8>> = {
        let mut st = s.conn.prepare("SELECT sha FROM files WHERE have = 1 ORDER BY cached_ms ASC, sha")?;
        let rows = st.query_map([], |r| r.get::<_, Vec<u8>>(0))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let mut n = 0;
    for sha in shas {
        if used_bytes(s)? <= TRIM_TO_BYTES { break; }
        if let Ok(arr) = <[u8; 32]>::try_from(sha.as_slice()) { delete_file(&arr); }
        s.conn.execute("UPDATE files SET have = 0, cached_ms = NULL WHERE sha = ?1", params![sha])?;
        n += 1;
    }
    Ok(n)
}

/// 3. Still over the limit: the oldest entries go, 500 at a time, until the space is back under the trim size.
fn prune_by_size(s: &SpaceStore) -> rusqlite::Result<u64> {
    if used_bytes(s)? <= KEEP_BYTES { return Ok(0); }
    let mut total = 0u64;
    loop {
        let mut remaining = used_bytes(s)?;
        if remaining <= TRIM_TO_BYTES { break; }
        let rows: Vec<(Vec<u8>, Vec<u8>, i64, i64)> = {
            let mut st = s.conn.prepare(
                "SELECT id, device, seq, size FROM entries WHERE created_ms > 0 ORDER BY created_ms, id LIMIT ?1",
            )?;
            let it = st.query_map(params![SIZE_BATCH], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
            it.collect::<rusqlite::Result<Vec<_>>>()?
        };
        // Only as many as needed to get under the trim size, so nothing is deleted for no reason.
        let mut take = Vec::new();
        for row in rows {
            if remaining <= TRIM_TO_BYTES { break; }
            remaining = remaining.saturating_sub(row.3 as u64);
            take.push(row);
        }
        if take.is_empty() { break; }
        let mut newest: BTreeMap<DeviceKey, u64> = BTreeMap::new();
        for (_, device, seq, _) in &take {
            if let Ok(d) = <[u8; 32]>::try_from(device.as_slice()) {
                let e = newest.entry(DeviceKey(d)).or_insert(0);
                *e = (*e).max(*seq as u64);
            }
        }
        for (device, seq) in &newest { s.raise_floor(device, *seq)?; }
        let mut deleted = 0usize;
        for (id, _, _, _) in &take { deleted += s.conn.execute("DELETE FROM entries WHERE id = ?1", params![id])?; }
        if deleted == 0 { break; }
        total += deleted as u64;
    }
    Ok(total)
}
