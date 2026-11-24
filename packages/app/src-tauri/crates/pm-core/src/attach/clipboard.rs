//! Files copied in Windows Explorer (Ctrl+C) put their paths on the clipboard as `CF_HDROP`. The webview does not
//! hand those over as files, so the chat box asks for the paths here on Ctrl+V. Other systems have no such format:
//! they get an empty list.

/// The clipboard format for a list of files (`CF_HDROP`).
#[cfg(windows)]
const CF_HDROP: u32 = 15;

/// Reads a `DROPFILES` block (the bytes of a `CF_HDROP` clipboard item) into the paths it lists.
///
/// The header is 20 bytes: the offset of the list (u32 at 0), a point and a flag (ignored), then `fWide` (u32 at 16):
/// non-zero means the paths are UTF-16. Each path ends with a null; an empty path ends the list. Broken input gives
/// whatever could be read before the damage.
pub fn parse_drop_files(bytes: &[u8]) -> Vec<String> {
    let word = |at: usize| bytes.get(at..at + 4).map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]));
    let Some(start) = word(0).map(|v| v as usize) else { return Vec::new() };
    let wide = word(16).unwrap_or(0) != 0;
    let Some(list) = bytes.get(start..) else { return Vec::new() };
    if wide {
        let units: Vec<u16> = list.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        units.split(|u| *u == 0).take_while(|path| !path.is_empty()).map(String::from_utf16_lossy).collect()
    } else {
        list.split(|b| *b == 0).take_while(|path| !path.is_empty()).map(|path| String::from_utf8_lossy(path).into_owned()).collect()
    }
}

/// The paths of the files copied in Explorer right now. Empty when the clipboard holds no files, cannot be opened
/// (another program has it), or outside Windows.
#[cfg(windows)]
pub fn clipboard_file_paths() -> Vec<String> {
    use windows_sys::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, OpenClipboard};
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
    // SAFETY: the clipboard is opened with no owner window and closed on every path below. The memory from
    // GetClipboardData is locked only while it is read, and is not freed (the clipboard owns it).
    unsafe {
        if OpenClipboard(0) == 0 {
            return Vec::new();
        }
        let mut paths = Vec::new();
        let handle = GetClipboardData(CF_HDROP);
        if handle != 0 {
            let ptr = GlobalLock(handle as _);
            if !ptr.is_null() {
                let len = GlobalSize(handle as _);
                let bytes = std::slice::from_raw_parts(ptr as *const u8, len);
                paths = parse_drop_files(bytes);
                GlobalUnlock(handle as _);
            }
        }
        CloseClipboard();
        paths
    }
}

#[cfg(not(windows))]
pub fn clipboard_file_paths() -> Vec<String> {
    Vec::new()
}
