//! `potato-host install-service`: a systemd USER unit (no root) so the host starts at login and comes back after a crash. A box with
//! no `systemctl --user` gets a plain message and the `nohup` line instead; nothing is installed for it.

use std::path::{Path, PathBuf};
use std::process::Command;

pub const UNIT_NAME: &str = "potato-host.service";

/// One argument of `ExecStart=`, quoted for systemd: `\`, `"`, `%` and `$` are escaped; a control character is refused.
fn quote(arg: &str) -> Result<String, String> {
    if arg.chars().any(|c| c.is_control()) {
        return Err("The program's path has a control character in it.".into());
    }
    let mut out = String::from("\"");
    for c in arg.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '%' => out.push_str("%%"),
            '$' => out.push_str("$$"),
            _ => out.push(c),
        }
    }
    out.push('"');
    Ok(out)
}

/// The unit file for the program at `exe`. `PATH` is left to the user manager's own (a thin one); the host reads the login shell's.
pub fn unit_text(exe: &Path) -> Result<String, String> {
    let exe = exe.to_str().ok_or("The program's path is not text.")?;
    Ok(format!(
        "[Unit]\nDescription=Potato Workspace host (the PC link on this machine)\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart={} run\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n",
        quote(exe)?
    ))
}

pub fn unit_path(home: &Path) -> PathBuf {
    home.join(".config/systemd/user").join(UNIT_NAME)
}

fn systemctl(args: &[&str]) -> Result<(), String> {
    let out = Command::new("systemctl").arg("--user").args(args).output().map_err(|e| format!("systemctl could not run: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    Err(format!("systemctl --user {} failed: {}", args.join(" "), String::from_utf8_lossy(&out.stderr).trim()))
}

pub fn install() -> i32 {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        eprintln!("potato-host: HOME is not set.");
        return 1;
    };
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("potato-host: cannot find its own path: {e}");
            return 1;
        }
    };
    let text = match unit_text(&exe) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("potato-host: {e}");
            return 1;
        }
    };
    if systemctl(&["show-environment"]).is_err() {
        eprintln!("potato-host: this machine has no user service manager (systemctl --user). Start it at login with:");
        eprintln!("  nohup {} run >/dev/null 2>&1 &", exe.display());
        return 1;
    }
    let path = unit_path(&home);
    if let Some(dir) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(dir) {
            eprintln!("potato-host: could not make {}: {e}", dir.display());
            return 1;
        }
    }
    if let Err(e) = std::fs::write(&path, text) {
        eprintln!("potato-host: could not write {}: {e}", path.display());
        return 1;
    }
    for step in [&["daemon-reload"][..], &["enable", "--now", UNIT_NAME]] {
        if let Err(e) = systemctl(step) {
            eprintln!("potato-host: {e}");
            return 1;
        }
    }
    println!("potato-host: installed and started ({}).", path.display());
    println!("To keep it running when you are logged out (needs root once): sudo loginctl enable-linger $USER");
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_unit_runs_the_program_and_escapes_what_systemd_would_expand() {
        let text = unit_text(Path::new("/home/me/.local/share/potato-workspace/bin/potato-host")).unwrap();
        assert!(text.contains("ExecStart=\"/home/me/.local/share/potato-workspace/bin/potato-host\" run\n"));
        assert!(text.contains("WantedBy=default.target") && text.contains("Restart=on-failure") && !text.contains("User="));
        let odd = unit_text(Path::new("/a b/%h/$X/\"q\"")).unwrap();
        assert!(odd.contains("ExecStart=\"/a b/%%h/$$X/\\\"q\\\"\" run"), "{odd}");
        assert!(unit_text(Path::new("/a\nExecStart=/bin/evil")).is_err(), "a newline cannot start a second line");
    }

    #[test]
    fn the_unit_lives_in_the_users_own_systemd_folder() {
        assert_eq!(unit_path(Path::new("/home/me")), PathBuf::from("/home/me/.config/systemd/user/potato-host.service"));
    }
}
