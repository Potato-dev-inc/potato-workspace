//! The stage page: one self-contained HTML file (style, script and the spec inside; it loads nothing). The renderer
//! seeks it frame by frame; opened by itself with `autoplay` it is the captioned slideshow.

use super::spec::Spec;

const CSS: &str = include_str!("assets/stage.css");
const JS: &str = include_str!("assets/stage.js");
pub const RENDER_SCRIPT: &str = include_str!("assets/render.mjs");

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// The spec as JSON that can sit inside a `<script>` tag: no `<` and no line-separator characters.
fn json_for_script(spec: &Spec) -> String {
    serde_json::to_string(spec).unwrap_or_else(|_| "{}".into()).replace('<', "\\u003c").replace('\u{2028}', "\\u2028").replace('\u{2029}', "\\u2029")
}

/// `autoplay`: the page plays by itself and a click pauses it (the slideshow). Otherwise it waits for `__seek`.
pub fn html(spec: &Spec, autoplay: bool) -> String {
    format!(
        "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>{title}</title>\n<style>{CSS}</style></head>\n<body{attr}><div id=\"root\"></div>\n<script id=\"spec\" type=\"application/json\">{json}</script>\n<script>{JS}</script></body></html>\n",
        title = html_escape(&spec.title),
        attr = if autoplay { " data-autoplay" } else { "" },
        json = json_for_script(spec),
    )
}
