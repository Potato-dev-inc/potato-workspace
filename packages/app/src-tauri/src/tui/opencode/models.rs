//! The models `opencode models` lists, for a picker. One line each, `provider/model`.

use std::io::Read;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const ASK_FOR: Duration = Duration::from_secs(8);
const KEEP_FOR: Duration = Duration::from_secs(120);
const MAX_MODELS: usize = 2000;

/// The ids in `opencode models` output: `provider/model` lines. Anything else (banners, errors, ANSI) is dropped.
pub(super) fn parse_models(output: &str) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    output
        .lines()
        .map(str::trim)
        .filter(|line| {
            let Some((provider, model)) = line.split_once('/') else { return false };
            !provider.is_empty()
                && !model.is_empty()
                && !line.contains(char::is_whitespace)
                && line.chars().all(|c| c.is_ascii_alphanumeric() || "/-_.:@[]".contains(c))
        })
        .filter(|line| seen.insert(line.to_string()))
        .take(MAX_MODELS)
        .map(String::from)
        .collect()
}

/// Runs `opencode models` (bounded) and caches the answer for a couple of minutes. Empty when it cannot run.
pub(super) fn listed() -> Vec<String> {
    static CACHE: Mutex<Option<(Instant, Vec<String>)>> = Mutex::new(None);
    if let Some((at, models)) = CACHE.lock().ok().as_deref().and_then(|c| c.as_ref()) {
        if at.elapsed() < KEEP_FOR {
            return models.clone();
        }
    }
    let models = run().unwrap_or_default();
    if let Ok(mut cache) = CACHE.lock() {
        *cache = Some((Instant::now(), models.clone()));
    }
    models
}

fn run() -> Option<Vec<String>> {
    let program = crate::tui::executable("opencode").ok()?;
    let mut child = crate::proc_util::hidden_command(program)
        .arg("models")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stdout.read_to_string(&mut text);
        text
    });
    let deadline = Instant::now() + ASK_FOR;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
        }
    }
    Some(parse_models(&reader.join().ok()?))
}

#[cfg(test)]
mod tests {
    use super::parse_models;

    #[test]
    fn keeps_provider_model_lines_once_and_drops_noise() {
        let out = "anthropic/claude-sonnet-4\nopenai/gpt-5.1\n\nanthropic/claude-sonnet-4\nUsing cache\n\u{1b}[0m\nopenrouter/meta/llama-3:free\nnot a model/x y\n";
        assert_eq!(parse_models(out), ["anthropic/claude-sonnet-4", "openai/gpt-5.1", "openrouter/meta/llama-3:free"]);
    }

    #[test]
    fn nothing_listed_is_empty() {
        assert!(parse_models("").is_empty());
        assert!(parse_models("Error: not logged in").is_empty());
    }
}
