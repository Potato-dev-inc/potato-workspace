//! The "only move our own windows" guard. Potato may place a window only when it is a window of this
//! process. Every code path that moves or resizes a window goes through `set_position` / `set_size`
//! here, so a foreign window (for example the Windows Installer "Setup" window that is on screen while
//! the app starts at the end of an install) is refused by process id, whatever handle or label led to it.

use tauri::{Position, Size, WebviewWindow};

/// The pure rule: the window belongs to us when the pid that created it is ours. `None` (the window
/// is gone, or the pid cannot be read) is refused: never move what cannot be proven ours.
pub fn pid_is_ours(window_pid: Option<u32>, our_pid: u32) -> bool {
    window_pid == Some(our_pid)
}

/// Decide for a window handle with an injected pid lookup (the real one is `process_of_hwnd`).
pub fn owns_hwnd_with(hwnd: isize, our_pid: u32, pid_of: impl Fn(isize) -> Option<u32>) -> bool {
    hwnd != 0 && pid_is_ours(pid_of(hwnd), our_pid)
}

/// The process that created a window (`GetWindowThreadProcessId`).
#[cfg(windows)]
pub fn process_of_hwnd(hwnd: isize) -> Option<u32> {
    use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;
    let mut pid: u32 = 0;
    // SAFETY: a plain query; an invalid handle makes it return 0 and leave `pid` at 0.
    let thread = unsafe { GetWindowThreadProcessId(hwnd as _, &mut pid) };
    (thread != 0 && pid != 0).then_some(pid)
}

#[cfg(not(windows))]
pub fn process_of_hwnd(_hwnd: isize) -> Option<u32> {
    None
}

/// True when `window` is a window of this process. Off Windows there are no foreign handles to
/// confuse it with, so a Tauri window is ours.
pub fn owns_window(window: &WebviewWindow) -> bool {
    #[cfg(windows)]
    {
        match window.hwnd() {
            Ok(h) => owns_hwnd_with(h.0 as isize, std::process::id(), process_of_hwnd),
            Err(_) => false,
        }
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        true
    }
}

/// `window.set_position`, but only for a window of this process. Returns whether it moved.
pub fn set_position(window: &WebviewWindow, position: impl Into<Position>) -> bool {
    if !owns_window(window) {
        tracing::warn!(label = window.label(), "refused to move a window that is not ours");
        return false;
    }
    window.set_position(position).is_ok()
}

/// `window.set_size`, but only for a window of this process. Returns whether it resized.
pub fn set_size(window: &WebviewWindow, size: impl Into<Size>) -> bool {
    if !owns_window(window) {
        tracing::warn!(label = window.label(), "refused to resize a window that is not ours");
        return false;
    }
    window.set_size(size).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A mock desktop: the Windows Installer window (pid 4242) and two of ours (pid 100).
    fn desktop(hwnd: isize) -> Option<u32> {
        match hwnd {
            1 | 2 => Some(100),
            9 => Some(4242),
            _ => None,
        }
    }

    #[test]
    fn a_window_of_another_process_is_refused() {
        assert!(!owns_hwnd_with(9, 100, desktop));
    }

    #[test]
    fn our_own_windows_are_allowed() {
        assert!(owns_hwnd_with(1, 100, desktop));
        assert!(owns_hwnd_with(2, 100, desktop));
    }

    #[test]
    fn a_missing_or_null_window_is_refused() {
        assert!(!owns_hwnd_with(77, 100, desktop));
        assert!(!owns_hwnd_with(0, 100, |_| Some(100)));
    }

    #[test]
    fn the_mock_desktop_only_ever_yields_our_windows_to_the_mover() {
        let movable: Vec<isize> = [1, 2, 9, 77].into_iter().filter(|h| owns_hwnd_with(*h, 100, desktop)).collect();
        assert_eq!(movable, vec![1, 2]);
    }

    #[cfg(windows)]
    #[test]
    fn a_made_up_handle_has_no_owner_and_is_refused() {
        assert!(!owns_hwnd_with(0x7fff_fff1, std::process::id(), process_of_hwnd));
    }
}
