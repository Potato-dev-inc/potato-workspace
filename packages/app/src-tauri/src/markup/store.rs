//! The pictures waiting for a send. The window holds only a short id; the path stays here. A picture is dropped when it is
//! sent, when a newer one for the same pane is taken, or when 16 others came after it.

use once_cell::sync::Lazy;
use parking_lot::Mutex;
use rand::RngCore;
use std::path::PathBuf;

const MAX_WAITING: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Waiting {
    pub id: String,
    pub pane_id: String,
    pub abs_path: PathBuf,
    pub rel_path: String,
}

static WAITING: Lazy<Mutex<Vec<Waiting>>> = Lazy::new(|| Mutex::new(Vec::new()));

fn new_id() -> String {
    let mut b = [0u8; 8];
    rand::rngs::OsRng.fill_bytes(&mut b);
    format!("mk-{}", b.iter().map(|x| format!("{x:02x}")).collect::<String>())
}

/// Keeps a picture for the next send of this pane (an older one of the pane is dropped). Returns its id.
pub fn keep(pane_id: &str, abs_path: PathBuf, rel_path: String) -> String {
    let id = new_id();
    let mut w = WAITING.lock();
    w.retain(|x| x.pane_id != pane_id);
    w.push(Waiting { id: id.clone(), pane_id: pane_id.to_string(), abs_path, rel_path });
    while w.len() > MAX_WAITING {
        w.remove(0);
    }
    id
}

/// The picture with this id, only for the pane it was taken for.
pub fn get(pane_id: &str, id: &str) -> Option<Waiting> {
    WAITING.lock().iter().find(|x| x.id == id && x.pane_id == pane_id).cloned()
}

/// Forgets a picture (it was sent). The file stays until it is pruned.
pub fn drop_id(id: &str) {
    WAITING.lock().retain(|x| x.id != id);
}
