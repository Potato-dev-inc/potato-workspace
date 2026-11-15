//! Windows shows an "allow this app through the firewall" window whenever a program listens on a non-loopback
//! address (all interfaces, or a LAN address) for TCP or UDP. Every rebuilt test program has a new name, so the
//! window comes back each time. This guard fails if any source file (tests and app code alike) binds such an
//! address. Loopback (127.0.0.1, ::1) never asks.

use std::path::{Path, PathBuf};

/// App code that may name a wildcard bind. Each entry is a path under `src/` and the reason. Keep it empty if you can.
const ALLOWED: &[(&str, &str)] = &[];

fn rust_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            rust_files(&p, out);
        } else if p.extension().is_some_and(|x| x == "rs") {
            out.push(p);
        }
    }
}

/// The wildcard spellings, built from pieces so this file does not match itself.
fn wildcards() -> Vec<String> {
    vec![
        ["0", "0", "0", "0"].join("."),
        ["[", "::", "]"].concat(),
        ["UNSPEC", "IFIED"].concat(),
        ["\"", "::", "\""].concat(),
        ["[0, ", "0, ", "0, ", "0]"].concat(),
        ["[0,", "0,", "0,", "0]"].concat(),
        ["Ipv4Addr::new(0, ", "0, ", "0, ", "0)"].concat(),
    ]
}

fn is_socket_call(line: &str) -> bool {
    ["bind", "TcpListener", "UdpSocket", "listen", "SocketAddr", "ServiceDaemon"].iter().any(|w| line.contains(w))
}

#[test]
fn no_source_file_binds_a_non_loopback_address() {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let mut files = Vec::new();
    rust_files(&root.join("src"), &mut files);
    rust_files(&root.join("tests"), &mut files);
    assert!(files.len() > 100, "the scan found only {} files", files.len());
    let words = wildcards();
    let mut bad = Vec::new();
    for f in files {
        let rel = f.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/");
        if rel == "src/opencode/native/no_wildcard_bind_tests.rs" || ALLOWED.iter().any(|(p, _)| rel == format!("src/{p}")) {
            continue;
        }
        let text = std::fs::read_to_string(&f).unwrap_or_default();
        for (n, line) in text.lines().enumerate() {
            let code = line.trim_start();
            if code.starts_with("//") {
                continue;
            }
            if is_socket_call(code) && words.iter().any(|w| code.contains(w.as_str())) {
                bad.push(format!("{rel}:{}: {}", n + 1, code.trim()));
            }
        }
    }
    assert!(bad.is_empty(), "these lines bind or name a non-loopback address; use 127.0.0.1:\n{}", bad.join("\n"));
}

#[test]
fn the_guard_notices_a_wildcard_bind() {
    let sample = format!("let l = TcpListener::bind((\"{}\", 0)).unwrap();", wildcards()[0]);
    assert!(is_socket_call(&sample) && wildcards().iter().any(|w| sample.contains(w.as_str())));
    let fine = "let l = TcpListener::bind((\"127.0.0.1\", 0)).unwrap();";
    assert!(!wildcards().iter().any(|w| fine.contains(w.as_str())));
}

#[test]
fn the_allow_list_has_a_reason_for_every_entry() {
    for (path, why) in ALLOWED {
        assert!(!why.trim().is_empty(), "{path} needs a reason");
    }
}
