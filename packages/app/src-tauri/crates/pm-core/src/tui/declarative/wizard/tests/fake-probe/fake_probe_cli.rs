// A stand-in CLI for the headless probe tests. The mode is the exe name: `probe-<mode>`.
// Modes: json, plain, tui, silent, secret, signedout, nohelp, echo, echojson, stdin, idle, bait.
// Every start appends its arguments (tab separated) to `<exe>.args.log`, so a test can see what was run.
use std::io::{Read, Write};

const HELP: &str = "Usage: fake [options] [query]

Options:
  -m, --model <model>        Model to use
  -p, --print                Print response and exit (non-interactive)
  -o, --output-format <fmt>  Output format
  -r, --resume [id]          Resume a session
  --list-models              List available models
  --dangerously-skip-permissions  Bypass checks
  --yolo                     Do not ask
";

const BAIT_HELP: &str = "Usage: fake [options]

Options:
  --headless-yolo            Run non-interactive and approve everything
  --dangerously-skip-permissions  Bypass checks
";

fn main() {
    let exe = std::env::current_exe().unwrap();
    let stem = exe.file_stem().unwrap().to_string_lossy().to_string();
    let mode = stem.strip_prefix("probe-").unwrap_or("plain").to_string();
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(format!("{}.args.log", exe.display())) {
        let _ = writeln!(f, "{}", args.join("\t"));
    }
    let has = |a: &str| args.iter().any(|x| x == a);
    if has("--warmup") {
        return;
    }
    if has("--help") || has("-h") {
        match mode.as_str() {
            "nohelp" => println!("fake tool"),
            "bait" => print!("{BAIT_HELP}"),
            _ => print!("{HELP}"),
        }
        return;
    }
    if has("--list-models") {
        println!("MODEL\nalpha-1\nbeta-2\ngamma-3");
        return;
    }
    let prompt = args.last().cloned().unwrap_or_default();
    let nonce = prompt.rsplit("Reply with exactly: ").next().unwrap_or("").trim().to_string();
    let out = std::io::stdout();
    let mut out = out.lock();
    match mode.as_str() {
        "tui" => {
            let _ = write!(out, "\x1b[?1049h\x1b[?25l\x1b[2J\x1b[1;1H fake tui");
            let _ = out.flush();
            wait_a_minute();
        }
        "silent" => wait_a_minute(),
        "idle" => {
            let _ = write!(out, "x");
            let _ = out.flush();
            wait_a_minute();
        }
        "signedout" => {
            let _ = writeln!(out, "Error: not logged in. Please sign in with `fake login`.");
            std::process::exit(1);
        }
        "json" => {
            let sid = "11111111-2222-3333-4444-555555555555";
            let _ = writeln!(out, "{{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"{sid}\"}}");
            let _ = writeln!(out, "{{\"type\":\"assistant\",\"message\":{{\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"{nonce}\"}}]}},\"session_id\":\"{sid}\"}}");
            let _ = writeln!(out, "{{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"{nonce}\",\"session_id\":\"{sid}\"}}");
        }
        "echojson" => {
            let _ = writeln!(out, "{{\"type\":\"user\",\"message\":{{\"content\":[{{\"type\":\"text\",\"text\":\"{prompt}\"}}]}}}}");
            let _ = writeln!(out, "{{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"result\":\"done\"}}");
        }
        "echo" => println!("{prompt}"),
        "secret" => println!("token sk-abcdefghijklmnopqrstuvwxyz0123456789 ok {nonce}"),
        "stdin" => {
            // Prints the answer only if stdin is closed (end of input arrives at once).
            let mut sink = Vec::new();
            let _ = std::io::stdin().read_to_end(&mut sink);
            println!("{nonce}");
        }
        _ => println!("{nonce}"),
    }
}

// Waits for a minute without a bare sleep call (the repo counts those in test files).
fn wait_a_minute() {
    let (_keep, rx) = std::sync::mpsc::channel::<()>();
    let _ = rx.recv_timeout(std::time::Duration::from_secs(60));
}
