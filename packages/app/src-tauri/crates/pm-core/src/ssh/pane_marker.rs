//! The folder marker of a chat on an SSH machine (the engine reads it; the app's `ssh::acp` re-exports it).

/// What a chat on an SSH machine is called everywhere on THIS PC as its folder (the pane list, the sidebar, rules, summaries). It starts
/// with a NUL, so it is no path on any OS: every `create_dir_all`, `is_dir`, `current_dir` or git call on it fails, and nothing is ever
/// created, read or excluded at a same-named folder of this PC. The real folder is `remote_folder_of`.
pub const PANE_FOLDER_PREFIX: &str = "\0ssh://";

pub fn pane_folder(host_id: &str, folder: &str) -> String {
    format!("{PANE_FOLDER_PREFIX}{host_id}{folder}")
}

/// `(host id, folder on that machine)` of a marker made by [`pane_folder`].
pub fn remote_folder_of(pane_folder: &str) -> Option<(&str, &str)> {
    let rest = pane_folder.strip_prefix(PANE_FOLDER_PREFIX)?;
    // A host id holds only letters, digits and `-`; the folder starts at the first other character (`/`, or `~` of `~/x`).
    let at = rest.find(|c: char| !(c.is_ascii_alphanumeric() || c == '-'))?;
    (at > 0).then(|| (&rest[..at], &rest[at..]))
}
