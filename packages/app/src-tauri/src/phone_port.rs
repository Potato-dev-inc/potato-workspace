//! "Port on this PC": the port the phone server on this computer asks for first. No choice means automatic (the app's own
//! usual port). It is read once, when the phone server starts, so a change takes effect after the app restarts. If the
//! chosen port is busy at that moment the server still moves to another one (the existing "moved" warning), so the app
//! always starts. Only the app window may change it (a Tauri command); nothing on the phone-facing side reads or writes it.

use std::net::TcpListener;
use std::path::PathBuf;

pub const MIN_PORT: u16 = 1024;

fn file() -> PathBuf {
    crate::tunnel_config::tunnel_file().with_file_name("potato-workspace.phone-port.json")
}

/// A number from the app window to a port. Anything below 1024 (kept for the system) or above 65535 is refused.
pub fn from_number(n: i64) -> Result<u16, String> {
    if (i64::from(MIN_PORT)..=65535).contains(&n) {
        Ok(n as u16)
    } else {
        Err("Use a port between 1024 and 65535, or leave it empty.".into())
    }
}

/// Every port the phone server tries, best first: the chosen one, then what it would use anyway. No repeats.
pub fn candidates(chosen: Option<u16>, usual: Vec<u16>) -> Vec<u16> {
    let mut out = Vec::with_capacity(usual.len() + 1);
    if let Some(p) = chosen {
        out.push(p);
    }
    for p in usual {
        if !out.contains(&p) {
            out.push(p);
        }
    }
    out
}

/// The chosen port, or none. A file that is missing, damaged or holds a port that is not allowed means automatic.
pub fn saved() -> Option<u16> {
    let text = std::fs::read_to_string(file()).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    from_number(v.get("port")?.as_i64()?).ok()
}

/// Save (or clear, with `None`) the chosen port. `bound` is the port the phone server uses right now: choosing it is
/// always fine. Any other port must be free on this computer at this moment.
pub fn save(port: Option<i64>, bound: Option<u16>) -> Result<Option<u16>, String> {
    let port = port.map(from_number).transpose()?;
    if let Some(p) = port {
        if Some(p) != bound && !is_free(p) {
            return Err("Another program is using that port. Pick a different one, or leave it empty.".into());
        }
    }
    let text = serde_json::json!({ "port": port }).to_string();
    crate::secure_file::write_private(&file(), &text)?;
    Ok(port)
}

/// Cheap check: can the phone server listen here right now?
fn is_free(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_from_the_window_are_checked_in_rust() {
        assert_eq!(from_number(1024), Ok(1024));
        assert_eq!(from_number(65535), Ok(65535));
        for bad in [i64::MIN, -1, 0, 443, 1023, 65536, 70000, i64::MAX] {
            assert!(from_number(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_chosen_port_goes_first_without_repeats() {
        assert_eq!(candidates(None, vec![1423]), vec![1423]);
        assert_eq!(candidates(Some(17425), vec![1423]), vec![17425, 1423]);
        assert_eq!(candidates(Some(1423), vec![1423]), vec![1423]);
        assert_eq!(candidates(Some(1460), vec![1450, 1460, 1451]), vec![1460, 1450, 1451]);
    }

    #[test]
    fn a_busy_port_is_refused_at_save_time_but_the_one_in_use_by_us_is_fine() {
        let l = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let busy = l.local_addr().unwrap().port();
        if busy >= MIN_PORT {
            assert!(!is_free(busy));
        }
    }
}
