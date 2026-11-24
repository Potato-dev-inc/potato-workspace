//! The `pmfile` protocol: big Word, Excel and PDF files stream to the viewer from here (see `crate::files::stream`).
//! A request is `<scheme>://.../<pane id>%2F<path in the project>`; the project folder is the pane's, and the path goes
//! through the same check as every other file call. The disk read runs off the main thread.

use super::files_view::pane_root;
use super::AppState;
use crate::files;
use tauri::http::{self, Method, Request, Response};
use tauri::{Manager, Runtime, UriSchemeContext, UriSchemeResponder};

fn into_response(reply: files::StreamReply) -> Response<Vec<u8>> {
    let mut builder = Response::builder().status(reply.status);
    for (name, value) in &reply.headers {
        builder = builder.header(*name, value.as_str());
    }
    builder.body(reply.body).unwrap_or_else(|_| Response::builder().status(500).body(Vec::new()).expect("empty response"))
}

/// The handler registered in `lib.rs` for the `pmfile` scheme.
pub fn files_stream_protocol<R: Runtime>(ctx: UriSchemeContext<'_, R>, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let origin = request.headers().get(http::header::ORIGIN).and_then(|v| v.to_str().ok()).map(str::to_owned);
    if request.method() == Method::OPTIONS {
        responder.respond(into_response(files::preflight(origin.as_deref())));
        return;
    }
    let range = request.headers().get(http::header::RANGE).and_then(|v| v.to_str().ok()).map(str::to_owned);
    let head = request.method() == Method::HEAD;
    let target = files::split_request_path(request.uri().path());
    let app = ctx.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let reply = match target {
            None => files::StreamReply { status: 400, headers: vec![], body: b"FILES_BAD_REQUEST".to_vec() },
            Some((pane_id, rel)) => {
                let root = pane_root(&app.state::<AppState>(), &pane_id);
                files::serve(&root, &rel, range.as_deref(), origin.as_deref())
            }
        };
        let mut response = into_response(reply);
        if head {
            *response.body_mut() = Vec::new();
        }
        responder.respond(response);
    });
}

#[cfg(test)]
mod wiring_tests {
    /// The protocol and the open command are wired into the app, and the viewer builds its addresses for the same scheme name.
    #[test]
    fn the_protocol_and_the_open_command_are_wired_in() {
        let lib = include_str!("../lib.rs");
        assert!(lib.contains("register_asynchronous_uri_scheme_protocol(\"pmfile\", commands::files_stream_protocol)"));
        assert!(lib.contains("commands::files_open_bytes,"));
        assert!(include_str!("../../../src/lib/files-api.ts").contains("convertFileSrc(`${paneId}/${path}`, 'pmfile')"));
    }
}
