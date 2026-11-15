//! The Today page's routes; the request/response logic lives in `crate::timeline::http`.

use super::{Ctx, RouteResult};

pub(super) fn handle(cx: &Ctx) -> Option<RouteResult> {
    if cx.segments.first() != Some(&"timeline") {
        return None;
    }
    let param = |name: &str| -> Option<String> {
        if cx.method == "GET" {
            crate::bridge::http::query_param(cx.query, name)
        } else {
            cx.request_body.get(name).and_then(|v| v.as_str()).map(str::to_string)
        }
    };
    crate::timeline::http::respond(crate::checkpoints::live(), cx.method, cx.segments, &param)
}
