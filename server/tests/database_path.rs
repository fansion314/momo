use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
};
use tizi_server::database_path;
#[test]
fn argument_then_service_variable_override_every_default() {
    let path = database_path(
        Some(Path::new("/chosen/cli.db")),
        Some(OsStr::new("/chosen/env.db")),
        Some(OsStr::new("/xdg")),
        Some(OsStr::new("/home/person")),
        true,
    )
    .unwrap();
    assert_eq!(path, PathBuf::from("/chosen/cli.db"));
    let path = database_path(
        None,
        Some(OsStr::new("/chosen/env.db")),
        Some(OsStr::new("/xdg")),
        Some(OsStr::new("/home/person")),
        true,
    )
    .unwrap();
    assert_eq!(path, PathBuf::from("/chosen/env.db"));
}
#[test]
fn user_defaults_follow_xdg_then_home_without_cwd() {
    assert_eq!(
        database_path(
            None,
            None,
            Some(OsStr::new("/custom/data")),
            Some(OsStr::new("/home/person")),
            false
        )
        .unwrap(),
        PathBuf::from("/custom/data/tizi-server/tizi.db")
    );
    for xdg in [None, Some(OsStr::new("")), Some(OsStr::new("relative/xdg"))] {
        assert_eq!(
            database_path(None, None, xdg, Some(OsStr::new("/home/person")), false).unwrap(),
            PathBuf::from("/home/person/.local/share/tizi-server/tizi.db")
        );
    }
}
#[test]
fn root_default_is_system_state_even_with_user_home_or_xdg() {
    assert_eq!(
        database_path(
            None,
            None,
            Some(OsStr::new("/user/xdg")),
            Some(OsStr::new("/home/person")),
            true
        )
        .unwrap(),
        PathBuf::from("/var/lib/tizi-server/tizi.db")
    );
    assert_eq!(
        database_path(None, None, None, None, true).unwrap(),
        PathBuf::from("/var/lib/tizi-server/tizi.db")
    );
}
#[test]
fn missing_or_relative_home_and_explicit_empty_values_fail() {
    assert!(database_path(None, None, None, None, false).is_err());
    assert!(database_path(None, None, None, Some(OsStr::new("relative/home")), false).is_err());
    assert!(database_path(Some(Path::new("")), None, None, None, true).is_err());
    assert!(database_path(None, Some(OsStr::new("")), None, None, true).is_err());
}
