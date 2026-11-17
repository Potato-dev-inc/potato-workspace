//! The start page of the person's browser window (the globe button). The page is served by the app itself (custom
//! scheme `potato-start`, like the artifact tab address), so the window is never empty: it always says "Type an
//! address", the address box of the browser bar is focused, and a refused address is explained in a plain sentence.
//!
//! The page holds no script and reads nothing from the web. The only input is a reason word from a fixed list
//! (`?why=`), the language comes from the request header. Nothing a page says ever reaches it.

use serde_json::{json, Value};

/// Windows shows a custom scheme as `http://<scheme>.localhost/`; other systems keep the scheme itself.
#[cfg(windows)]
pub const ADDRESS_HOST: &str = "potato-start.localhost";
#[cfg(not(windows))]
pub const ADDRESS_HOST: &str = "localhost";
#[cfg(windows)]
const ADDRESS_START: &str = "http://potato-start.localhost/";
#[cfg(not(windows))]
const ADDRESS_START: &str = "potato-start://localhost/";

/// The reason words the page knows (the bar's error words, `chrome::error_word`).
const REASONS: [&str; 4] = ["errBad", "errPrivate", "errNotFound", "errOwn"];

/// The address of the start page, with the reason a typed address was refused (a word from the list, or none).
pub fn address(why: Option<&str>) -> String {
    match why.filter(|w| REASONS.contains(w)) {
        Some(word) => format!("{ADDRESS_START}?why={word}"),
        None => ADDRESS_START.to_string(),
    }
}

/// Whether `url` is the start page (with or without a known reason): the one narrow allowance of the window's guard.
pub fn is_start_address(url: &str) -> bool {
    let Some(rest) = url.strip_prefix(ADDRESS_START) else { return false };
    rest.is_empty() || rest.strip_prefix("?why=").is_some_and(|w| REASONS.contains(&w))
}

/// The reason word inside a start address, if it has a known one.
pub fn reason_of(url: &str) -> Option<&'static str> {
    let word = url.strip_prefix(ADDRESS_START)?.strip_prefix("?why=")?;
    REASONS.iter().copied().find(|r| *r == word)
}

/// The words of the page. One plain sentence per refusal, with the reason in it.
pub fn strings() -> Value {
    json!({
        "en": {
            "title": "Browser",
            "lead": "Type an address",
            "hint": "Type a web address in the box at the top, then press Enter. You can also open pages on this computer, such as localhost:5173.",
            "errBad": "That is not a web address, so it was not opened. Try something like example.com.",
            "errPrivate": "That address is on a private network (a router, a printer or another computer), so it was not opened. Public web pages and this computer's own pages are fine.",
            "errNotFound": "That address could not be found, so nothing was opened. Check the spelling.",
            "errOwn": "That page belongs to Potato Workspace itself, so it was not opened.",
        },
        "zh-TW": {
            "title": "瀏覽器",
            "lead": "輸入網址",
            "hint": "在上方的欄位輸入網址，再按 Enter。也可以開啟這台電腦上的頁面，例如 localhost:5173。",
            "errBad": "這不是網址，所以沒有開啟。請試試像 example.com 這樣的網址。",
            "errPrivate": "這個網址在私人網路上（路由器、印表機或另一台電腦），所以沒有開啟。公開的網頁和這台電腦上的頁面都可以開啟。",
            "errNotFound": "找不到這個網址，所以沒有開啟。請檢查拼字。",
            "errOwn": "這個頁面屬於 Potato Workspace 本身，所以沒有開啟。",
        },
    })
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// Whether an `Accept-Language` header asks for Traditional Chinese first.
pub fn wants_zh_tw(accept_language: &str) -> bool {
    let first = accept_language.split(',').next().unwrap_or("").trim().to_ascii_lowercase();
    first.starts_with("zh-tw") || first.starts_with("zh-hk") || first.starts_with("zh-mo") || first.starts_with("zh-hant")
}

/// The page, as HTML text. `why` is the reason word of a refused address (unknown words are ignored).
pub fn page(why: Option<&str>, zh: bool) -> String {
    let all = strings();
    let s = &all[if zh { "zh-TW" } else { "en" }];
    let word = |k: &str| escape(s[k].as_str().unwrap_or(""));
    let refusal = why
        .filter(|w| REASONS.contains(w))
        .map(|w| format!("<p class=\"why\" role=\"alert\">{}</p>", word(w)))
        .unwrap_or_default();
    format!(
        "<!doctype html><html lang=\"{lang}\"><head><meta charset=\"utf-8\"><title>{title}</title>\
<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><style>\
:root{{color-scheme:dark light}}\
html,body{{margin:0;overflow:hidden}}body{{min-height:calc(100vh - 36px);display:grid;place-items:center;background:#1a1816;color:#e8e3dc;font:15px/1.6 system-ui,'Segoe UI',sans-serif}}\
main{{max-width:34rem;padding:2rem 1.5rem}}\
h1{{margin:0 0 .5rem;font-size:1.5rem;font-weight:600}}\
p{{margin:.5rem 0;color:#b9b2a8}}\
.why{{color:#f2a49b;border:1px solid #5a3a36;border-radius:8px;padding:.6rem .8rem;background:#2a1f1d}}\
@media (prefers-color-scheme:light){{body{{background:#f6f3ee;color:#2a2622}}p{{color:#5c554d}}.why{{color:#8a2a20;border-color:#e3b9b3;background:#fbeae7}}}}\
</style></head><body><main><h1>{lead}</h1>{refusal}<p>{hint}</p></main></body></html>",
        lang = if zh { "zh-TW" } else { "en" },
        title = word("title"),
        lead = word("lead"),
        hint = word("hint"),
    )
}

/// The reply for one request to the start page: status, headers and body. Only GET, only the root path.
pub fn respond(method: &str, path: &str, query: &str, accept_language: &str) -> (u16, Vec<(&'static str, String)>, Vec<u8>) {
    let headers = |len: usize| {
        vec![
            ("Content-Type", "text/html; charset=utf-8".to_string()),
            ("Content-Length", len.to_string()),
            ("Cache-Control", "no-store".to_string()),
            ("X-Content-Type-Options", "nosniff".to_string()),
            ("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'".to_string()),
        ]
    };
    if method != "GET" || path != "/" {
        let body = b"Not found".to_vec();
        return (if method == "GET" { 404 } else { 405 }, headers(body.len()), body);
    }
    let why = query.strip_prefix("why=");
    let body = page(why, wants_zh_tw(accept_language)).into_bytes();
    (200, headers(body.len()), body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_start_address_and_a_known_reason_pass() {
        assert!(is_start_address(&address(None)));
        assert!(is_start_address(&address(Some("errPrivate"))));
        assert_eq!(reason_of(&address(Some("errNotFound"))), Some("errNotFound"));
        // An unknown reason is dropped when the address is made, and refused when it is read.
        assert_eq!(address(Some("<script>")), address(None));
        let bad = format!("{}?why=<script>", address(None).trim_end_matches('?'));
        assert!(!is_start_address(&bad));
        for other in [
            "http://potato-start.localhost.evil.com/",
            "http://potato-start.localhost/x",
            "http://potato-start.localhost/?why=errBad&x=1",
            "https://example.com/",
            "about:blank",
        ] {
            assert!(!is_start_address(other), "{other}");
        }
    }

    #[test]
    fn the_page_asks_for_an_address_and_has_no_script() {
        let en = page(None, false);
        assert!(en.contains("Type an address") && en.contains("press Enter"));
        assert!(!en.to_lowercase().contains("<script") && !en.contains("class=\"why\""));
        let zh = page(None, true);
        assert!(zh.contains("輸入網址") && zh.contains("lang=\"zh-TW\""));
    }

    #[test]
    fn a_refused_address_shows_one_plain_sentence_with_the_reason() {
        for word in REASONS {
            let en = page(Some(word), false);
            let zh = page(Some(word), true);
            assert!(en.contains("class=\"why\"") && zh.contains("class=\"why\""), "{word}");
            assert!(en.contains("so it was not opened") || en.contains("so nothing was opened"), "{word}");
        }
        assert!(page(Some("errPrivate"), false).contains("private network"));
        assert!(page(Some("errNotFound"), false).contains("could not be found"));
        assert!(page(Some("errOwn"), false).contains("belongs to Potato Workspace"));
        // A word that is not on the list never reaches the page.
        assert!(!page(Some("<img src=x>"), false).contains("<img"));
        assert!(!page(Some("<img src=x>"), false).contains("class=\"why\""));
    }

    #[test]
    fn both_languages_have_the_same_words() {
        let all = strings();
        let keys = |lang: &str| {
            let mut k: Vec<String> = all[lang].as_object().unwrap().keys().cloned().collect();
            k.sort();
            k
        };
        assert_eq!(keys("en"), keys("zh-TW"));
        for word in REASONS {
            assert!(all["en"][word].is_string() && all["zh-TW"][word].is_string());
        }
    }

    #[test]
    fn the_reply_is_get_only_root_only_and_locked_down() {
        let (status, headers, body) = respond("GET", "/", "why=errPrivate", "zh-TW,zh;q=0.9");
        assert_eq!(status, 200);
        assert!(String::from_utf8(body).unwrap().contains("私人網路"));
        let csp = headers.iter().find(|(n, _)| *n == "Content-Security-Policy").unwrap();
        assert!(csp.1.contains("default-src 'none'") && !csp.1.contains("script-src"));
        // The mark-up bar shows the picture of the page as a data: image; on this page the CSP must let it (1.1.7 real-app check).
        assert!(csp.1.contains("img-src data:"));
        assert_eq!(respond("POST", "/", "", "").0, 405);
        assert_eq!(respond("GET", "/secret", "", "").0, 404);
        assert_eq!(respond("GET", "/", "why=<b>", "en").0, 200);
        assert!(!String::from_utf8(respond("GET", "/", "why=<b>", "en").2).unwrap().contains("<b>"));
    }

    #[test]
    fn the_language_is_read_from_the_header() {
        assert!(wants_zh_tw("zh-TW,zh;q=0.9,en;q=0.8"));
        assert!(wants_zh_tw("zh-Hant"));
        assert!(!wants_zh_tw("en-US,en;q=0.9"));
        assert!(!wants_zh_tw("zh-CN"));
        assert!(!wants_zh_tw(""));
    }
}
