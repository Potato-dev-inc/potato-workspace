//! The one bridge route that serves a share link: `GET /share/{secret}` (also as `/bridge/share/{secret}`).
//!
//! It is public (the secret is the credential) and it is the ONLY thing a public caller can read: the secret names one
//! version of one artifact (`share::resolve`), the path takes no id, no version and no query, and every other path or
//! method falls through to the bridge's normal rules. Pure: the caller gives the index file and the time.
//!
//! The page is served on the same address as the phone app, so it must never run with that address's power:
//! * `Content-Security-Policy: sandbox ...` gives the page an opaque origin (no storage, no tokens, no app calls),
//! * the rest of the policy is the one the app's own locked frame uses (no network except the short script-library list),
//! * `nosniff`, `no-store` and `no-referrer` keep it from being guessed, cached or leaked.

use std::path::Path;

use super::model::ArtifactKind;
use super::share::{resolve, token_shape_ok, ShareError, Shared};

/// The only addresses a shared page may load a script, style or font from. Same list as the app's locked frame
/// (`SandboxFrame.tsx`, `CDN_HOSTS`).
const CDN_HOSTS: [&str; 3] = ["https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net", "https://unpkg.com"];
/// The Mermaid script, pinned like the app's own (`lib/artifacts.ts`, `MERMAID_SRC`).
const MERMAID_SRC: &str = "https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.esm.min.mjs";

/// A finished reply: status, headers and body. The caller writes it as it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SharePage {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
    pub body: Vec<u8>,
}

impl SharePage {
    #[cfg(test)]
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

fn policy(scripts: bool) -> String {
    let hosts = CDN_HOSTS.join(" ");
    let mut parts = vec![
        "sandbox allow-scripts".to_string(),
        "default-src 'none'".to_string(),
        "img-src data: blob:".to_string(),
        "media-src data: blob:".to_string(),
        format!("font-src data: {hosts}"),
        format!("style-src 'unsafe-inline' {hosts}"),
        "form-action 'none'".to_string(),
        "base-uri 'none'".to_string(),
        "frame-ancestors 'none'".to_string(),
    ];
    if scripts {
        parts.push(format!("script-src 'unsafe-inline' {hosts}"));
    } else {
        // A page with no scripts is served with no `allow-scripts`, so even a script the policy missed would not run.
        parts[0] = "sandbox".to_string();
    }
    parts.join("; ")
}

fn page(status: u16, scripts: bool, body: String) -> SharePage {
    SharePage {
        status,
        headers: vec![
            ("Content-Type", "text/html; charset=utf-8".to_string()),
            ("Content-Security-Policy", policy(scripts)),
            ("X-Content-Type-Options", "nosniff".to_string()),
            ("Referrer-Policy", "no-referrer".to_string()),
            ("Cache-Control", "no-store".to_string()),
            ("X-Robots-Tag", "noindex, nofollow".to_string()),
            ("Cross-Origin-Resource-Policy", "same-origin".to_string()),
        ],
        body: body.into_bytes(),
    }
}

const STYLE: &str = "html,body{margin:0;padding:0}body{font:15px/1.55 system-ui,sans-serif;color:#1a1a1a;background:#fff}main{max-width:48rem;margin:0 auto;padding:20px 16px}pre{white-space:pre-wrap;word-wrap:break-word;font:inherit}h1{font-size:1.1rem}";

fn plain(status: u16, title: &str, message: &str) -> SharePage {
    page(status, false, format!("<!DOCTYPE html><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{t}</title><style>{STYLE}</style><main><h1>{t}</h1><p>{m}</p></main>", t = escape(title), m = escape(message)))
}

fn show(shared: &Shared) -> SharePage {
    let title = escape(&shared.title);
    let head = format!("<!DOCTYPE html><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><meta name=\"robots\" content=\"noindex\"><title>{title}</title>");
    match shared.kind {
        // The page as its author made it: the policy header is what keeps it in its box.
        ArtifactKind::Html => page(200, true, shared.content.clone()),
        ArtifactKind::Markdown => page(200, false, format!("{head}<style>{STYLE}</style><main><h1>{title}</h1><pre>{}</pre></main>", escape(&shared.content))),
        // The picture is inline text; the policy has no script source, so nothing in it can run.
        ArtifactKind::Svg => page(200, false, format!("{head}<style>{STYLE}svg{{max-width:100%;height:auto}}</style><main><h1>{title}</h1>{}</main>", shared.content)),
        ArtifactKind::Mermaid => page(
            200,
            true,
            format!(
                "{head}<style>{STYLE}pre.mermaid{{text-align:center;white-space:pre-wrap}}</style><main><h1>{title}</h1><pre class=\"mermaid\">{}</pre></main><script type=\"module\">import mermaid from '{MERMAID_SRC}';mermaid.initialize({{startOnLoad:false,securityLevel:'strict'}});try{{await mermaid.run({{querySelector:'.mermaid'}})}}catch(e){{}}</script>",
                escape(&shared.content)
            ),
        ),
    }
}

/// The reply for a request, or `None` when it is not a share request (the bridge goes on as usual). `segments` are the
/// path parts with a leading `bridge` already taken off. Only `GET /share/{secret}` is answered; a secret of the wrong
/// shape, an unknown one and a stopped one all get the same 404 page.
pub fn respond(index_file: &Path, method: &str, segments: &[&str], now_ms: u64) -> Option<SharePage> {
    let ["share", token] = segments else { return None };
    if method != "GET" {
        let mut refused = plain(405, "Read only", "This link can only be read.");
        refused.headers.push(("Allow", "GET".to_string()));
        return Some(refused);
    }
    if !token_shape_ok(token) {
        return Some(plain(404, "Not found", "This link does not exist, or it was stopped."));
    }
    Some(match resolve(index_file, token, now_ms) {
        Ok(shared) => show(&shared),
        Err(ShareError::Expired) => plain(410, "This link has ended", "The person who shared it can make a new one."),
        Err(_) => plain(404, "Not found", "This link does not exist, or it was stopped."),
    })
}
