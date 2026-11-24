//! The Python that an installed CLI agent was installed with: the one an adapter must run with, so that it can import
//! the agent's own code. Generic: no agent is named here.
//!
//! Where it is found, in order (the first that answers wins):
//! 1. a Python beside the program (a venv `Scripts\` or `bin/` folder holds `python.exe` or `python`);
//! 2. the shebang of the program: a pip, pipx or uv launcher `.exe` carries `#!"...\python.exe"` near its end, and a
//!    script starts with `#!/abs/python`. Read as bytes; nothing is run.
//!
//! Never a system Python: a shebang that goes through `env` (`#!/usr/bin/env python3`) names no file, so it is not
//! followed; a path that does not exist is `None`.

use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

/// How far from the end of a launcher `.exe` the shebang is searched.
const EXE_TAIL: u64 = 256 * 1024;
const HEAD: usize = 1024;
const IMPORT_TIMEOUT: Duration = Duration::from_secs(10);

/// The agent's own Python for `program` (the located program file), or `None`.
pub fn find(program: &Path) -> Option<PathBuf> {
    if !program.is_file() {
        return None;
    }
    if let Some(python) = python_beside(program) {
        return Some(python);
    }
    let is_exe = program.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe"));
    if let Some(python) = shebang_in_head(program).and_then(|line| python_from_shebang(&line)) {
        return Some(python);
    }
    if is_exe {
        return shebang_in_tail(program).and_then(|line| python_from_shebang(&line));
    }
    None
}

fn python_beside(program: &Path) -> Option<PathBuf> {
    let dir = program.parent()?;
    ["python.exe", "python"].iter().map(|name| dir.join(name)).find(|p| p.is_file())
}

fn read_head(path: &Path) -> Option<Vec<u8>> {
    let mut file = std::fs::File::open(path).ok()?;
    let mut buf = vec![0u8; HEAD];
    let n = file.read(&mut buf).ok()?;
    buf.truncate(n);
    Some(buf)
}

fn shebang_in_head(path: &Path) -> Option<String> {
    let head = read_head(path)?;
    if !head.starts_with(b"#!") {
        return None;
    }
    let line_end = head.iter().position(|b| *b == b'\n').unwrap_or(head.len());
    Some(String::from_utf8_lossy(&head[..line_end]).into_owned())
}

/// The last shebang line in the tail of a launcher `.exe`, the way a pip launcher stores its script.
fn shebang_in_tail(path: &Path) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let len = file.metadata().ok()?.len();
    let start = len.saturating_sub(EXE_TAIL);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut tail = Vec::new();
    file.read_to_end(&mut tail).ok()?;
    let mut found: Option<String> = None;
    for at in tail.windows(2).enumerate().filter(|(_, w)| w[0] == b'#' && w[1] == b'!').map(|(i, _)| i) {
        let rest = &tail[at..];
        let end = rest.iter().position(|b| *b == b'\n' || *b == b'\r').unwrap_or(rest.len()).min(1024);
        let line = String::from_utf8_lossy(&rest[..end]).into_owned();
        if python_from_shebang(&line).is_some() {
            found = Some(line);
        }
    }
    found
}

/// The Python file a shebang line names, if it is an absolute path to an existing file called `python...`.
/// `#!"C:\a b\python.exe"` (quoted), `#!C:\a\python.exe` and `#!/usr/bin/python3` are all read.
pub(crate) fn python_from_shebang(line: &str) -> Option<PathBuf> {
    let body = line.strip_prefix("#!")?.trim_start();
    let token = if let Some(quoted) = body.strip_prefix('"') {
        quoted.split('"').next()?.to_string()
    } else {
        body.split_whitespace().next()?.to_string()
    };
    let path = PathBuf::from(token.trim());
    if !path.is_absolute() {
        return None;
    }
    let stem = path.file_name()?.to_str()?.to_ascii_lowercase();
    if !stem.starts_with("python") {
        return None;
    }
    path.is_file().then_some(path)
}

/// One quick run of the agent's Python: `python -c "import <name>"`, no window, a short time limit, a small
/// environment. Returns why it failed. Only called when an adapter is installed (never during a read).
pub fn confirm_import(python: &Path, import_name: &str) -> Result<(), String> {
    if !import_name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.') || import_name.is_empty() {
        return Err("the import name is not a plain module name".into());
    }
    let mut cmd = crate::proc_util::hidden_command(python);
    cmd.arg("-c").arg(format!("import {import_name}")).env_clear().stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    for key in ["SYSTEMROOT", "TEMP", "TMP", "USERPROFILE", "HOME"] {
        if let Some(value) = std::env::var_os(key) {
            cmd.env(key, value);
        }
    }
    if let Some(dir) = python.parent() {
        cmd.current_dir(dir);
    }
    let mut child = cmd.spawn().map_err(|e| format!("could not start the agent's Python ({e})"))?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(_)) => return Err(format!("the agent's Python cannot import {import_name}")),
            Ok(None) if started.elapsed() < IMPORT_TIMEOUT => std::thread::sleep(Duration::from_millis(50)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("importing {import_name} took longer than 10 seconds"));
            }
            Err(e) => return Err(format!("could not check the agent's Python ({e})")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> PathBuf {
        std::env::temp_dir().join(format!("pm-agent-python-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn a_launcher_shebang_with_a_quoted_path_and_spaces_is_read() {
        let root = temp();
        let python = root.join("my py home").join("python.exe");
        std::fs::create_dir_all(python.parent().unwrap()).unwrap();
        std::fs::write(&python, b"x").unwrap();
        let program = root.join("bin").join("tool.exe");
        std::fs::create_dir_all(program.parent().unwrap()).unwrap();
        let mut bytes = vec![b'M', b'Z', 0, 1, 2, 3];
        bytes.extend_from_slice(format!("\r\n#!\"{}\"\r\nPK\x03\x04", python.display()).as_bytes());
        std::fs::write(&program, bytes).unwrap();
        assert_eq!(find(&program), Some(python.clone()));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn an_unquoted_unix_shebang_is_read_and_env_is_not_followed() {
        let root = temp();
        std::fs::create_dir_all(&root).unwrap();
        let python = root.join("venv").join("python3");
        std::fs::create_dir_all(python.parent().unwrap()).unwrap();
        std::fs::write(&python, b"x").unwrap();
        let script = root.join("tool");
        std::fs::write(&script, format!("#!{} -s\nprint(1)\n", python.display())).unwrap();
        assert_eq!(find(&script), Some(python));
        let via_env = root.join("env-tool");
        std::fs::write(&via_env, "#!/usr/bin/env python3\nprint(1)\n").unwrap();
        assert_eq!(find(&via_env), None, "env names no file: no system Python");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_python_beside_the_program_is_the_agents_own() {
        let root = temp();
        let scripts = root.join("venv").join("Scripts");
        std::fs::create_dir_all(&scripts).unwrap();
        std::fs::write(scripts.join("python.exe"), b"x").unwrap();
        std::fs::write(scripts.join("tool.exe"), b"MZ no shebang here").unwrap();
        assert_eq!(find(&scripts.join("tool.exe")), Some(scripts.join("python.exe")));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn missing_python_or_program_gives_none_and_a_system_python_is_never_returned() {
        let root = temp();
        std::fs::create_dir_all(&root).unwrap();
        assert_eq!(find(&root.join("no-such-tool.exe")), None);
        // a shebang naming a python that is not there
        let gone = root.join("gone.exe");
        std::fs::write(&gone, format!("MZ\r\n#!\"{}\"\r\n", root.join("nope").join("python.exe").display())).unwrap();
        assert_eq!(find(&gone), None);
        // a program with no python beside it and no shebang
        let bare = root.join("bare.exe");
        std::fs::write(&bare, b"MZ bare").unwrap();
        assert_eq!(find(&bare), None);
        // a relative shebang and a non-python shebang are not followed
        assert_eq!(python_from_shebang("#!python.exe"), None);
        assert_eq!(python_from_shebang("#!/bin/sh"), None);
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn the_confirm_run_reports_a_python_that_cannot_run() {
        let root = temp();
        std::fs::create_dir_all(&root).unwrap();
        let fake = root.join("python.exe");
        std::fs::write(&fake, b"not an executable").unwrap();
        assert!(confirm_import(&fake, "fakeagent").is_err());
        assert!(confirm_import(&fake, "fake; rm").unwrap_err().contains("plain module name"));
        let _ = std::fs::remove_dir_all(root);
    }
}
