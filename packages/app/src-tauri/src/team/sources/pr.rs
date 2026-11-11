//! "…and opened a PR": after a push, ask GitHub (through the person's own `gh` login, so Puppet
//! Master holds no GitHub secret) whether the pushed branch has an open pull request (plan §6.1
//! step 2). `gh pr create` often follows the push by a few seconds, so a miss is retried at
//! [`RETRY_AFTER_MS`]. Without `gh`, or for a remote that is not on GitHub, it quietly finds nothing.

use crate::team::event::{is_valid_branch, CiRef, PrRef};
use std::path::Path;
use std::process::Stdio;

/// Delays after a push at which the lookup is retried.
pub const RETRY_AFTER_MS: [u64; 2] = [30_000, 120_000];

/// The open pull request for a branch, with what its card shows besides the PR itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FoundPr {
    pub pr: PrRef,
    /// The branch it merges into.
    pub base: Option<String>,
    /// Its checks right now (usually pending, a moment after `gh pr create`).
    pub ci: Option<CiRef>,
}

/// Looks up the open pull request for a branch (a fake in tests).
pub trait PrLookup: Send + Sync {
    fn open_pr_for(&self, repo: &Path, branch: &str) -> Option<FoundPr>;
}

/// `gh pr list --head <branch> --state open --json …` in the repository.
pub struct GhCli;

impl PrLookup for GhCli {
    fn open_pr_for(&self, repo: &Path, branch: &str) -> Option<FoundPr> {
        if !is_valid_branch(branch) {
            return None;
        }
        let mut cmd = crate::proc_util::hidden_command("gh");
        cmd.args([
            "pr", "list", "--head", branch, "--state", "open", "--limit", "1",
            "--json", "number,title,url,isDraft,state,changedFiles,additions,deletions,baseRefName,statusCheckRollup",
        ])
        .current_dir(repo)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
        let out = cmd.output().ok()?;
        if !out.status.success() {
            return None;
        }
        parse_found_pr(&String::from_utf8_lossy(&out.stdout))
    }
}

/// [`parse_pr_list`] plus the base branch and the checks (`statusCheckRollup`).
pub fn parse_found_pr(json: &str) -> Option<FoundPr> {
    let pr = parse_pr_list(json)?;
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    let first = value.as_array()?.first()?;
    let base = first.get("baseRefName").and_then(|v| v.as_str()).filter(|b| is_valid_branch(b)).map(str::to_string);
    let ci = first.get("statusCheckRollup").and_then(|v| v.as_array()).map(|checks| {
        // Check runs carry `status` + `conclusion`; commit statuses carry `state`.
        let verdict = |c: &serde_json::Value| {
            let word = c.get("conclusion").or_else(|| c.get("state")).and_then(|v| v.as_str()).unwrap_or("").to_ascii_uppercase();
            let done = c.get("status").and_then(|v| v.as_str()).map_or(true, |s| s.eq_ignore_ascii_case("completed"));
            (word, done)
        };
        let failed = checks.iter().any(|c| matches!(verdict(c).0.as_str(), "FAILURE" | "ERROR" | "TIMED_OUT" | "STARTUP_FAILURE"));
        let pending = checks.iter().any(|c| {
            let (word, done) = verdict(c);
            !done || matches!(word.as_str(), "" | "PENDING" | "EXPECTED")
        });
        let conclusion = if checks.is_empty() {
            "none"
        } else if failed {
            "failure"
        } else if pending {
            "pending"
        } else {
            "success"
        };
        CiRef { conclusion: conclusion.into(), failed_jobs: Vec::new(), url: String::new() }
    });
    Some(FoundPr { pr, base, ci })
}

/// The first entry of `gh pr list --json …` output.
pub fn parse_pr_list(json: &str) -> Option<PrRef> {
    let value: serde_json::Value = serde_json::from_str(json).ok()?;
    let first = value.as_array()?.first()?;
    let number = first.get("number")?.as_u64().filter(|n| *n > 0)?;
    let url = first.get("url").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let as_u32 = |key: &str| first.get(key).and_then(|v| v.as_u64()).map(|n| n.min(u64::from(u32::MAX)) as u32);
    Some(PrRef {
        number,
        title: first.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string(),
        url: if url.starts_with("https://") { url } else { String::new() },
        state: first.get("state").and_then(|v| v.as_str()).unwrap_or("OPEN").to_ascii_lowercase(),
        draft: first.get("isDraft").and_then(|v| v.as_bool()).unwrap_or(false),
        files: as_u32("changedFiles"),
        additions: as_u32("additions"),
        deletions: as_u32("deletions"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_first_open_pr() {
        let json = r#"[{"number":142,"title":"Add OAuth token refresh","url":"https://github.com/acme/billing/pull/142","isDraft":false,"state":"OPEN","changedFiles":6,"additions":212,"deletions":34}]"#;
        let pr = parse_pr_list(json).unwrap();
        assert_eq!(pr.number, 142);
        assert_eq!(pr.title, "Add OAuth token refresh");
        assert_eq!(pr.files, Some(6));
        assert_eq!(pr.state, "open");
        assert!(!pr.draft);
    }

    #[test]
    fn a_new_pr_carries_its_base_and_checks() {
        let json = r#"[{"number":482,"title":"Relay rooms","url":"https://github.com/potato-workspace/app/pull/482","isDraft":false,"state":"OPEN","changedFiles":14,"additions":612,"deletions":88,"baseRefName":"main","statusCheckRollup":[{"__typename":"CheckRun","name":"build","status":"IN_PROGRESS","conclusion":null},{"__typename":"CheckRun","name":"lint","status":"COMPLETED","conclusion":"SUCCESS"}]}]"#;
        let found = parse_found_pr(json).unwrap();
        assert_eq!(found.pr.files, Some(14));
        assert_eq!(found.base.as_deref(), Some("main"));
        assert_eq!(found.ci.unwrap().conclusion, "pending");
        let red = r#"[{"number":482,"statusCheckRollup":[{"status":"COMPLETED","conclusion":"FAILURE"},{"state":"SUCCESS"}]}]"#;
        assert_eq!(parse_found_pr(red).unwrap().ci.unwrap().conclusion, "failure");
        let none = r#"[{"number":3,"statusCheckRollup":[]}]"#;
        assert_eq!(parse_found_pr(none).unwrap().ci.unwrap().conclusion, "none");
    }

    #[test]
    fn no_pr_and_bad_output_find_nothing() {
        assert_eq!(parse_pr_list("[]"), None);
        assert_eq!(parse_pr_list("not json"), None);
        assert_eq!(parse_pr_list(r#"[{"number":0}]"#), None);
        let odd = parse_pr_list(r#"[{"number":3,"url":"javascript:alert(1)"}]"#).unwrap();
        assert_eq!(odd.url, "", "only https links are kept");
    }
}
