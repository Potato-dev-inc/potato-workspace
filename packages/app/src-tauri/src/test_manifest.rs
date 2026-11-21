//! The lib unit-test exe links Tauri's dialog/window layer, which imports `TaskDialogIndirect` (Common Controls v6). The app gets v6 from
//! its own resource; the unit-test exe has none, so without this it dies at start with STATUS_ENTRYPOINT_NOT_FOUND. A linker directive in
//! the test build only (`cfg(test)`) asks the linker for a manifest that requests v6 (written next to the test exe as `<exe>.manifest`, which Windows loads); the app and its bin tests are untouched (no second manifest).

#[cfg(all(test, windows, target_env = "msvc"))]
#[used]
#[unsafe(link_section = ".drectve")]
static COMCTL32_V6: [u8; 168] = *b" /MANIFESTDEPENDENCY:\"type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'\" ";
