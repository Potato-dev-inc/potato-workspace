//! Showing a toast with the Windows notification API (WinRT, through the `windows` crate the app already uses).
//!
//! The toast is shown under the app's AppUserModelID, which is the bundle identifier: the installer puts it on
//! the Start menu shortcut, and Windows only shows a toast for an id that has one. Buttons are protocol
//! links (see `rules`), so nothing here listens for a click.

use windows::core::HSTRING;
use windows::Data::Xml::Dom::XmlDocument;
use windows::UI::Notifications::{ToastNotification, ToastNotificationManager};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

/// Show `xml`. A toast with the same `tag` replaces the one before it. Call from a worker thread.
pub fn show(xml: &str, tag: Option<&str>) -> Result<(), String> {
    // The thread may be new to COM; "already initialised" is fine, so the result is not needed.
    // SAFETY: plain COM start-up on this thread, no pointers involved.
    let _ = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    let run = || -> windows::core::Result<()> {
        let doc = XmlDocument::new()?;
        doc.LoadXml(&HSTRING::from(xml))?;
        let toast = ToastNotification::CreateToastNotification(&doc)?;
        if let Some(tag) = tag {
            toast.SetTag(&HSTRING::from(tag))?;
        }
        let notifier = ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(super::AUMID))?;
        notifier.Show(&toast)
    };
    run().map_err(|e| e.to_string())
}
