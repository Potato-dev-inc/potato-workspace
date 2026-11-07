//! The reviewed adapter catalog: `resources/adapters/<id>/adapter.toml` plus the script it names.
//!
//! An adapter is a script we ship for an installed CLI agent that has importable code (for example Python). It runs
//! with the Python the agent itself was installed with (`acp::agent_python`), so it can import the agent. Each entry
//! is checked when the catalog is read: the script must exist and its SHA-256 must match `sha256` in the TOML. An
//! entry that fails any check is left out (and the reason is returned by [`load_dir`]).
//!
//! Nothing here names an agent: the agents are whatever the data files say.

use std::path::{Path, PathBuf};

use serde::Deserialize;

/// The fields of one `adapter.toml`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AdapterMeta {
    pub id: String,
    pub label: String,
    /// The CLI program the adapter attaches to, by file name without `.exe`.
    pub program: String,
    pub runtime: String,
    /// The script file, next to `adapter.toml`.
    pub script: String,
    pub sha256: String,
    pub tested_version: String,
    /// The module the agent's Python must be able to import (checked once, when the adapter is installed).
    pub import_name: String,
    /// Keys the adapter may receive. The person approves each one; only approved names reach the child.
    #[serde(default)]
    pub env_keys: Vec<EnvKey>,
    /// Plain settings the adapter reads (never secret). The person may change the value; `default` is used otherwise.
    #[serde(default)]
    pub env_settings: Vec<EnvSetting>,
    /// Key groups: each group needs at least one of its keys saved before the chat can be added. Names from `env_keys`.
    #[serde(default)]
    pub key_groups: Vec<Vec<String>>,
    /// How a chat continues in the agent's terminal. Only `"none"` today.
    #[serde(default = "no_resume")]
    pub resume: String,
}

fn no_resume() -> String {
    "none".into()
}

/// One key the adapter may receive: `env` is the variable name, `slot` (optional) the Keys-settings slot that already
/// holds it. Without `slot` the key is kept in a per-adapter slot (`acp::adapter_keys`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EnvKey {
    pub env: String,
    pub label: String,
    #[serde(default)]
    pub slot: Option<String>,
}

/// One plain setting the adapter reads. `default` is a public value (a model id), never a secret. `options` (optional)
/// are public choices the screen offers; the person may also type another value.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EnvSetting {
    pub env: String,
    pub label: String,
    pub default: String,
    #[serde(default)]
    pub options: Vec<EnvOption>,
}

/// One public choice for a setting. `needs_key` (optional) names a key of the adapter; the choice works when that key
/// is saved. The screen preselects the first choice whose key is saved.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EnvOption {
    pub value: String,
    pub label: String,
    #[serde(default)]
    pub needs_key: Option<String>,
}

const MAX_ENV_ITEMS: usize = 8;

/// A variable name the app may set for an adapter: plain letters, digits and `_`, and not a denied name.
pub fn env_name_ok(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        && name.len() <= 64
        && !crate::tui::declarative::validate::denied_env_name(name)
}

fn env_lists_problem(meta: &AdapterMeta) -> Option<String> {
    if meta.env_keys.len() > MAX_ENV_ITEMS || meta.env_settings.len() > MAX_ENV_ITEMS {
        return Some(format!("at most {MAX_ENV_ITEMS} keys and {MAX_ENV_ITEMS} settings"));
    }
    let names = meta.env_keys.iter().map(|k| k.env.as_str()).chain(meta.env_settings.iter().map(|s| s.env.as_str()));
    let mut seen = std::collections::BTreeSet::new();
    for name in names {
        if !env_name_ok(name) || !seen.insert(name.to_ascii_uppercase()) {
            return Some(format!("{name:?} is not a usable or unique variable name"));
        }
    }
    for key in &meta.env_keys {
        if key.label.trim().is_empty() || key.label.chars().count() > 60 {
            return Some(format!("the label of {} must be 1 to 60 characters", key.env));
        }
        if key.slot.as_deref().is_some_and(|s| !crate::secrets::is_provider_secret(s)) {
            return Some(format!("the slot of {} must be a known key slot", key.env));
        }
    }
    for group in &meta.key_groups {
        if group.is_empty() || group.iter().any(|name| !meta.env_keys.iter().any(|k| k.env == *name)) {
            return Some("each key group must be non-empty and name only keys the adapter asks for".into());
        }
    }
    for setting in &meta.env_settings {
        if setting.options.len() > MAX_ENV_ITEMS {
            return Some(format!("at most {MAX_ENV_ITEMS} options for {}", setting.env));
        }
        for option in &setting.options {
            let plain = option.value.chars().count() <= 128 && !option.value.chars().any(char::is_control) && !option.value.contains(['{', '}']);
            let label_ok = !option.label.trim().is_empty() && option.label.chars().count() <= 60;
            let key_ok = option.needs_key.as_deref().is_none_or(|k| meta.env_keys.iter().any(|key| key.env == k));
            if !plain || !label_ok || !key_ok || crate::redact::text_with(&option.value, &crate::redact::RedactContext::default()).into_inner() != option.value {
                return Some(format!("an option of {} must be a plain public value, a label, and a key the adapter asks for", setting.env));
            }
        }
        let value = &setting.default;
        let plain = value.chars().count() <= 128 && !value.chars().any(char::is_control) && !value.contains(['{', '}']);
        // `text_with` (no gathered context): the catalog is read while redaction gathers its own context.
        if !plain || crate::redact::text_with(value, &crate::redact::RedactContext::default()).into_inner() != *value {
            return Some(format!("the default of {} must be a plain public value", setting.env));
        }
    }
    None
}

/// A catalog entry whose script passed the checks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdapterEntry {
    pub meta: AdapterMeta,
    pub dir: PathBuf,
}

impl AdapterEntry {
    pub fn script_path(&self) -> PathBuf {
        self.dir.join(&self.meta.script)
    }

    /// The folder name the adapter is copied into, under the adapters folder.
    pub fn install_folder(&self) -> String {
        format!("pm-adapter-{}", self.meta.id)
    }

    /// The script's path inside the adapters folder, with `/`: `pm-adapter-<id>/<script>`.
    pub fn installed_script(&self) -> String {
        format!("{}/{}", self.install_folder(), self.meta.script)
    }
}

/// Lower-case file name of a program without its `.exe`: `C:/x/Tool.EXE` gives `tool`.
pub fn program_stem(program: &str) -> String {
    let file = program.rsplit(['/', '\\']).next().unwrap_or(program);
    let lower = file.to_ascii_lowercase();
    lower.strip_suffix(".exe").unwrap_or(&lower).to_string()
}

fn plain_name(text: &str) -> bool {
    !text.is_empty() && text.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn hex64(text: &str) -> bool {
    text.len() == 64 && text.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Reads one `adapter.toml` in `dir` and checks it and its script. The error names the first problem.
pub fn load_entry(dir: &Path) -> Result<AdapterEntry, String> {
    let name = dir.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string();
    let text = std::fs::read_to_string(dir.join("adapter.toml")).map_err(|e| format!("{name}: no readable adapter.toml ({e})"))?;
    let meta: AdapterMeta = toml::from_str(&text).map_err(|e| format!("{name}: adapter.toml: {e}"))?;
    if meta.id != name || !plain_name(&meta.id) {
        return Err(format!("{name}: the id must be the folder name"));
    }
    if meta.runtime != "python" {
        return Err(format!("{name}: runtime {} is not supported", meta.runtime));
    }
    if !plain_name(&meta.program) || !plain_name(&meta.import_name) {
        return Err(format!("{name}: program and import_name must be plain names"));
    }
    if meta.resume != "none" {
        return Err(format!("{name}: resume {} is not supported", meta.resume));
    }
    if meta.script.is_empty() || meta.script.starts_with('.') || meta.script.contains(['/', '\\', ':']) {
        return Err(format!("{name}: script must be a file name in the same folder"));
    }
    if !hex64(&meta.sha256) {
        return Err(format!("{name}: sha256 must be a SHA-256"));
    }
    if let Some(problem) = env_lists_problem(&meta) {
        return Err(format!("{name}: {problem}"));
    }
    let entry = AdapterEntry { meta, dir: dir.to_path_buf() };
    let actual = crate::acp::pin::sha256_hex(&entry.script_path()).map_err(|_| format!("{name}: the script {} is missing", entry.meta.script))?;
    if !actual.eq_ignore_ascii_case(&entry.meta.sha256) {
        return Err(format!("{name}: the script does not match its pinned sha256"));
    }
    Ok(AdapterEntry { meta: AdapterMeta { sha256: entry.meta.sha256.to_ascii_lowercase(), ..entry.meta }, dir: entry.dir })
}

/// Every adapter folder under `root`: the good entries, and one error text per folder that failed.
pub fn load_dir(root: &Path) -> (Vec<AdapterEntry>, Vec<String>) {
    let mut good = Vec::new();
    let mut bad = Vec::new();
    let Ok(read) = std::fs::read_dir(root) else { return (good, bad) };
    let mut dirs: Vec<PathBuf> = read.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.is_dir()).collect();
    dirs.sort();
    for dir in dirs {
        match load_entry(&dir) {
            Ok(entry) => good.push(entry),
            Err(reason) => bad.push(reason),
        }
    }
    (good, bad)
}

/// The folders the catalog may live in: next to the app executable (an installed build), then the source tree (a dev
/// run). The first that exists is used.
pub fn catalog_root() -> Option<PathBuf> {
    let beside_exe = std::env::current_exe().ok().and_then(|exe| exe.parent().map(|d| d.join("resources").join("adapters")));
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources").join("adapters");
    [beside_exe, Some(source)].into_iter().flatten().find(|p| p.is_dir())
}

/// Every good entry of the shipped catalog.
pub fn load() -> Vec<AdapterEntry> {
    catalog_root().map(|root| load_dir(&root).0).unwrap_or_default()
}

/// The good entries whose `program` is the program's file name (`program_stem`).
pub fn for_program(program: &str) -> Vec<AdapterEntry> {
    let stem = program_stem(program);
    load().into_iter().filter(|e| e.meta.program.eq_ignore_ascii_case(&stem)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_entry(root: &Path, id: &str, sha: &str, runtime: &str) {
        let dir = root.join(id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("fake_adapter.py"), "print('adapter')\n").unwrap();
        let toml = format!(
            "id = \"{id}\"\nlabel = \"Fake\"\nprogram = \"fakeagent\"\nruntime = \"{runtime}\"\nscript = \"fake_adapter.py\"\nsha256 = \"{sha}\"\ntested_version = \"1.0.0\"\nimport_name = \"fakeagent\"\n"
        );
        std::fs::write(dir.join("adapter.toml"), toml).unwrap();
    }

    #[test]
    fn the_catalog_loads_good_entries_and_refuses_a_bad_sha_or_runtime() {
        let root = std::env::temp_dir().join(format!("pm-adapter-cat-{}", uuid::Uuid::new_v4()));
        let good_sha = crate::acp::pin::sha256_hex(&{
            std::fs::create_dir_all(&root).unwrap();
            let p = root.join("probe.py");
            std::fs::write(&p, "print('adapter')\n").unwrap();
            p
        })
        .unwrap();
        write_entry(&root, "fakeagent", &good_sha.to_uppercase(), "python");
        write_entry(&root, "badsha", &"00".repeat(32), "python");
        write_entry(&root, "badruntime", &good_sha, "node");
        let (good, bad) = load_dir(&root);
        assert_eq!(good.len(), 1, "{good:?}");
        assert_eq!(good[0].meta.id, "fakeagent");
        assert_eq!(good[0].meta.sha256, good_sha, "stored lower-case");
        assert_eq!(good[0].installed_script(), "pm-adapter-fakeagent/fake_adapter.py");
        assert_eq!(bad.len(), 2, "{bad:?}");
        assert!(bad.iter().any(|b| b.contains("badsha") && b.contains("sha256")));
        assert!(bad.iter().any(|b| b.contains("badruntime") && b.contains("runtime")));
        assert_eq!(program_stem("C:/Tools/FakeAgent.EXE"), "fakeagent");
        let _ = std::fs::remove_dir_all(root);
    }
}
