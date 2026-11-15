//! More than one companion: the default flag, the old file, the cap of 8 saved and 3 awake, and a look of its own.

use super::manage::Patch;
use super::model::{CompanionState, MAX_AWAKE_COMPANIONS, MAX_COMPANIONS};
use super::store;
use super::test_host::{draft, service_with_one, start_ms, temp_dir, FakeHost};
use super::Service;

const NAMES: [&str; 8] = ["Mochi", "Bit", "Nib", "Tofu", "Lumen", "Hoot", "Sprout", "Kit"];

fn state_of(service: &Service, id: &str) -> CompanionState {
    service.view(id, false).unwrap().state
}

#[test]
fn the_first_companion_is_the_default_and_another_can_be_made_default() {
    let (service, _host, root) = service_with_one();
    service.create(draft("Bit", &root.join("bit"))).unwrap();
    let views = service.views(false);
    assert_eq!(
        views.iter().map(|v| (v.id.as_str(), v.is_default)).collect::<Vec<_>>(),
        vec![("mochi", true), ("bit", false)]
    );
    let bit = service.set_default("bit").unwrap();
    assert!(bit.is_default);
    assert!(!service.view("mochi", false).unwrap().is_default);
    assert_eq!(store::load_all(&root).unwrap().1.as_deref(), Some("bit"), "saved");
    // It survives a restart of the service.
    let host = FakeHost::new(start_ms());
    let again = Service::new(host, root);
    assert!(again.view("bit", false).unwrap().is_default);
    assert_eq!(service.set_default("nobody").unwrap_err().code, "COMPANION_NOT_FOUND");
}

#[test]
fn archiving_or_deleting_the_default_hands_the_flag_to_the_next_companion() {
    let (service, _host, root) = service_with_one();
    service.create(draft("Bit", &root.join("bit"))).unwrap();
    service.create(draft("Nib", &root.join("nib"))).unwrap();
    service.archive("mochi").unwrap();
    assert!(service.view("bit", false).unwrap().is_default);
    assert!(!service.view("nib", false).unwrap().is_default);
    service.set_default("nib").unwrap();
    service.delete("nib").unwrap();
    assert!(service.view("bit", false).unwrap().is_default);
    assert_eq!(store::load_all(&root).unwrap().1.as_deref(), Some("bit"));
}

#[test]
fn an_old_version_1_file_opens_with_mochi_as_default_and_stays_untouched_until_a_save() {
    let root = temp_dir("pm-companion-v1");
    let home = root.join("mochi");
    let text = format!(
        r#"{{"v":1,"companions":[{{"id":"mochi","name":"Mochi","avatar":"mochi","persona":"calm","agentType":"claude","folder":{},"createdMs":1}}]}}"#,
        serde_json::to_string(&home.display().to_string()).unwrap()
    );
    std::fs::write(store::companions_path(&root), &text).unwrap();
    let host = FakeHost::new(start_ms());
    let service = Service::new(host, root.clone());
    let view = service.view("mochi", false).unwrap();
    assert!(view.is_default && view.accent.is_none());
    assert_eq!(std::fs::read_to_string(store::companions_path(&root)).unwrap(), text, "nothing written at load");
    service.update("mochi", Patch { accent: Some("sky".into()), ..Patch::default() }).unwrap();
    let saved = std::fs::read_to_string(store::companions_path(&root)).unwrap();
    assert!(saved.contains("\"v\": 2") && saved.contains("\"defaultId\": \"mochi\""), "{saved}");
}

#[test]
fn a_ninth_companion_is_refused_and_a_fourth_awake_one_is_made_asleep() {
    let (service, host, root) = service_with_one();
    for name in &NAMES[1..MAX_COMPANIONS] {
        service.create(draft(name, &root.join(name.to_lowercase()))).unwrap();
    }
    assert_eq!(service.views(false).len(), MAX_COMPANIONS);
    let err = service.create(draft("Extra", &root.join("extra"))).unwrap_err();
    assert_eq!(err.code, "COMPANION_LIMIT");
    // Only the first three were started.
    assert_eq!(host.spawn_count(), MAX_AWAKE_COMPANIONS);
    let awake = service.views(false).iter().filter(|v| v.state != CompanionState::Sleeping).count();
    assert_eq!(awake, MAX_AWAKE_COMPANIONS);
    assert_eq!(state_of(&service, "tofu"), CompanionState::Sleeping);
    // Waking a fourth is refused until one rests.
    assert_eq!(service.wake("tofu").unwrap_err().code, "COMPANION_AWAKE_LIMIT");
    service.sleep("nib").unwrap();
    assert!(service.wake("tofu").is_ok());
}

#[test]
fn a_file_with_too_many_awake_puts_the_extra_ones_to_sleep_and_keeps_the_default_first() {
    let (service, _host, root) = service_with_one();
    for name in &NAMES[1..3] {
        service.create(draft(name, &root.join(name.to_lowercase()))).unwrap();
    }
    // Five awake at the next start: a file written by hand with auto-start on.
    let (mut list, _) = store::load_all(&root).unwrap();
    for name in &NAMES[3..5] {
        let mut extra = list[0].clone();
        extra.id = name.to_lowercase();
        extra.name = (*name).into();
        extra.folder = root.join(name.to_lowercase()).display().to_string();
        list.push(extra);
    }
    store::save_with_default(&root, &list, Some("lumen")).unwrap();
    let host = FakeHost::new(start_ms());
    let service = Service::new(host, root);
    service.tick();
    let sleeping: Vec<String> =
        service.views(false).into_iter().filter(|v| v.state == CompanionState::Sleeping).map(|v| v.id).collect();
    assert_eq!(sleeping, vec!["nib", "tofu"], "the default (lumen) stays awake, the last in order sleep");
}

#[test]
fn each_companion_has_its_own_look_and_a_bad_colour_is_refused() {
    let (service, _host, root) = service_with_one();
    let mut d = draft("Bit", &root.join("bit"));
    d.avatar = "bit".into();
    d.accent = Some("mint".into());
    let bit = service.create(d).unwrap();
    assert_eq!((bit.avatar.as_str(), bit.accent.as_deref()), ("bit", Some("mint")));
    assert_eq!(service.view("mochi", false).unwrap().accent, None);
    let changed = service.update("bit", Patch { avatar: Some("kit".into()), ..Patch::default() }).unwrap();
    assert_eq!(changed.avatar, "kit");
    let saved = store::load(&root).unwrap();
    assert_eq!(saved[1].look.as_ref().unwrap().avatar, "kit", "the look follows the face");
    let mut bad = draft("Nib", &root.join("nib"));
    bad.accent = Some("neon".into());
    assert!(service.create(bad).is_err());
    assert!(service.update("bit", Patch { accent: Some("neon".into()), ..Patch::default() }).is_err());
}

#[test]
fn each_companion_keeps_its_own_memory_folder() {
    let (service, _host, root) = service_with_one();
    service.create(draft("Bit", &root.join("bit"))).unwrap();
    assert!(root.join("mochi").join("SOUL.md").exists() && root.join("bit").join("SOUL.md").exists());
    assert_ne!(root.join("mochi"), root.join("bit"));
}
