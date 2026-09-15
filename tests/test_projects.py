"""Projects: folders under the data directory, and the manifest that describes them."""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import pytest

from trackoverlay import projects
from trackoverlay.projects import ProjectError


def test_a_new_project_gets_a_folder_and_a_manifest(tmp_path):
    project = projects.create(tmp_path, "Slovakia Ring, 12 September")
    assert project.name == "slovakia-ring-12-september"
    assert project.root.is_dir()
    assert project.out_dir.is_dir()

    saved = json.loads(project.manifest_path.read_text())
    assert saved["title"] == "Slovakia Ring, 12 September"
    assert saved["version"] == projects.VERSION


@pytest.mark.parametrize("title, slug", [
    ("Portimão morning", "portimao-morning"),
    ("  spaced  out  ", "spaced-out"),
    ("2026-09-12", "2026-09-12"),
    ("!!!", ""),
])
def test_slugify(title, slug):
    assert projects.slugify(title) == slug


def test_a_title_without_letters_is_refused(tmp_path):
    with pytest.raises(ProjectError):
        projects.create(tmp_path, "!!!")


def test_a_second_project_of_the_same_name_gets_a_suffix(tmp_path):
    first = projects.create(tmp_path, "Track day")
    second = projects.create(tmp_path, "Track day")
    assert (first.name, second.name) == ("track-day", "track-day-2")


@pytest.mark.parametrize("name", ["..", ".", "a/b", "/etc", "%2e%2e", "Upper", "", "-lead"])
def test_a_project_name_cannot_escape_the_data_root(tmp_path, name):
    with pytest.raises(ProjectError):
        projects.read(tmp_path, name)


def test_reading_a_project_that_is_not_there(tmp_path):
    with pytest.raises(ProjectError):
        projects.read(tmp_path, "nope")


def test_a_folder_without_a_manifest_is_still_a_project(tmp_path):
    (tmp_path / "loose").mkdir()
    (tmp_path / "loose" / "a.csv").write_text("Record,Time\n")
    project = projects.read(tmp_path, "loose")
    assert [p.name for p in projects.sources(project)] == ["a.csv"]


def test_sources_are_the_folder_plus_the_registered_paths(tmp_path):
    outside = tmp_path / "card"
    outside.mkdir()
    video = outside / "GH013429.MP4"
    video.write_bytes(b"x")

    project = projects.create(tmp_path / "data", "Day")
    (project.root / "session.csv").write_text("Record,Time\n")
    (project.root / "notes.txt").write_text("ignored")
    project = projects.add_sources(project, [video])

    found = {p.name for p in projects.sources(project)}
    assert found == {"session.csv", "GH013429.MP4"}


def test_produced_files_never_come_back_as_sources(tmp_path):
    project = projects.create(tmp_path, "Day")
    (project.root / "a.csv").write_text("Record,Time\n")
    (project.out_dir / "final.mp4").write_bytes(b"rendered")

    assert [p.name for p in projects.sources(project)] == ["a.csv"]


def test_a_file_the_tool_cannot_read_is_refused(tmp_path):
    project = projects.create(tmp_path, "Day")
    notes = tmp_path / "notes.txt"
    notes.write_text("x")
    with pytest.raises(ProjectError):
        projects.add_sources(project, [notes])


def test_a_file_that_is_not_there_is_refused(tmp_path):
    project = projects.create(tmp_path, "Day")
    with pytest.raises(ProjectError):
        projects.add_sources(project, [tmp_path / "gone.csv"])


def test_adding_the_same_file_twice_registers_it_once(tmp_path):
    video = tmp_path / "GH013429.MP4"
    video.write_bytes(b"x")
    project = projects.create(tmp_path / "data", "Day")
    project = projects.add_sources(project, [video])
    project = projects.add_sources(project, [video])
    assert len(project.registered) == 1


def test_a_registered_file_can_be_dropped(tmp_path):
    video = tmp_path / "GH013429.MP4"
    video.write_bytes(b"x")
    project = projects.create(tmp_path / "data", "Day")
    project = projects.add_sources(project, [video])
    project = projects.remove_source(project, video)
    assert projects.sources(project) == []


def test_a_file_inside_the_folder_cannot_be_dropped_by_the_editor(tmp_path):
    project = projects.create(tmp_path, "Day")
    inside = project.root / "a.csv"
    inside.write_text("Record,Time\n")
    with pytest.raises(ProjectError):
        projects.remove_source(project, inside)


def test_discovery_lists_projects_newest_first(tmp_path):
    projects.write(replace(projects.create(tmp_path, "Old"), created_utc=1.0))
    projects.write(replace(projects.create(tmp_path, "New"), created_utc=2.0))
    (tmp_path / "not a project").mkdir()

    assert [p.name for p in projects.discover(tmp_path)] == ["new", "old"]


def test_discovery_of_a_missing_directory_is_empty(tmp_path):
    assert projects.discover(tmp_path / "nope") == []


@pytest.mark.parametrize("name", ["../session.json", "/etc/passwd", "", ".hidden", "a/b"])
def test_an_output_name_cannot_escape_the_out_directory(tmp_path, name):
    project = projects.create(tmp_path, "Day")
    with pytest.raises(ProjectError):
        projects.resolve_output(project, name)


def test_an_output_resolves_inside_out(tmp_path):
    project = projects.create(tmp_path, "Day")
    assert projects.resolve_output(project, "final.mp4") == project.out_dir / "final.mp4"


def test_the_confirmed_sync_survives_a_reread(tmp_path):
    project = projects.create(tmp_path, "Day")
    projects.set_manual_sync(project, "cam_3429", -0.42)
    assert projects.read(tmp_path, "day").manual_sync == {"cam_3429": -0.42}


def test_a_zero_correction_is_forgotten(tmp_path):
    project = projects.create(tmp_path, "Day")
    project = projects.set_manual_sync(project, "cam_3429", -0.42)
    project = projects.set_manual_sync(project, "cam_3429", 0.0)
    assert projects.read(tmp_path, "day").manual_sync == {}


# --- migration ----------------------------------------------------------------------

def _legacy(root, *, nudge=0.0):
    """A folder the way `trackoverlay build -o out/session.json` used to leave it.

    The video sits elsewhere, which is the usual case and the only one worth recording:
    files inside the folder are found by the scan.
    """
    root.mkdir(parents=True)
    card = root.parent / "card"
    card.mkdir(exist_ok=True)
    (root / "session.json").write_text(json.dumps({
        "session": {"track": "Slovakia Ring", "duration_s": 100.0},
        "laps": [{"duration_s": 160.349}],
        "clips": [{"id": "cam_1", "files": [str(card / "GH013429.MP4")], "offset_s": 1.4}],
    }))
    (root / "layout.json").write_text(json.dumps({"nudge_s": nudge, "widgets": []}))
    (root / "final.mp4").write_bytes(b"rendered")
    (root / "overlay.webm").write_bytes(b"layer")
    return root


def test_a_legacy_folder_gains_a_manifest(tmp_path):
    _legacy(tmp_path / "out")
    project = projects.from_session_path(tmp_path / "out" / "session.json")

    assert project.manifest_path.is_file()
    assert project.track == "Slovakia Ring"
    assert [p.name for p in project.registered] == ["GH013429.MP4"]


def test_migration_moves_renders_into_out(tmp_path):
    _legacy(tmp_path / "out")
    project = projects.from_session_path(tmp_path / "out" / "session.json")

    assert (project.out_dir / "final.mp4").is_file()
    assert (project.out_dir / "overlay.webm").is_file()
    assert not (project.root / "final.mp4").exists()


def test_a_preview_only_nudge_becomes_the_real_offset(tmp_path):
    """The whole point of the migration: what a person confirmed now reaches ffmpeg."""
    root = _legacy(tmp_path / "out", nudge=0.5)
    project = projects.from_session_path(root / "session.json")

    assert project.manual_sync == {"cam_1": 0.5}
    session = json.loads((root / "session.json").read_text())
    assert session["clips"][0]["offset_s"] == pytest.approx(1.9)
    assert session["clips"][0]["auto_offset_s"] == pytest.approx(1.4)
    assert json.loads((root / "layout.json").read_text())["nudge_s"] == 0


def test_migration_runs_once(tmp_path):
    root = _legacy(tmp_path / "out", nudge=0.5)
    projects.from_session_path(root / "session.json")
    projects.from_session_path(root / "session.json")

    session = json.loads((root / "session.json").read_text())
    assert session["clips"][0]["offset_s"] == pytest.approx(1.9)


def test_files_already_in_the_folder_are_not_registered_twice(tmp_path):
    root = tmp_path / "out"
    _legacy(root)
    (root / "inside.csv").write_text("Record,Time\n")
    project = projects.from_session_path(root / "session.json")

    assert [p.name for p in project.registered] == ["GH013429.MP4"]
    assert sorted(p.name for p in projects.sources(project)) == ["inside.csv"]


def test_a_card_describes_a_built_project(tmp_path):
    _legacy(tmp_path / "data" / "day")
    card = projects.read(tmp_path / "data", "day").as_dict()

    assert card["built"] is True
    assert card["laps"] == 1
    assert card["best_s"] == pytest.approx(160.349)
    assert card["track"] == "Slovakia Ring"


def test_a_card_for_an_unbuilt_project(tmp_path):
    project = projects.create(tmp_path, "Day")
    (project.root / "a.csv").write_text("Record,Time\n")
    card = project.as_dict()

    assert card["built"] is False
    assert (card["videos"], card["telemetry"]) == (0, 1)


def test_a_moved_project_finds_its_own_files_again(tmp_path):
    """A session records the paths files had when it was built. Mounting the folder into
    a container puts them somewhere else entirely, and only the folder travels."""
    project = projects.create(tmp_path, "Day")
    video = project.root / "GH013429.MP4"
    video.write_bytes(b"x")

    recorded = "/somewhere/that/is/gone/GH013429.MP4"
    assert projects.resolve_source(recorded, project.root) == video


def test_a_file_that_was_never_in_the_project_is_left_alone(tmp_path):
    project = projects.create(tmp_path, "Day")
    missing = Path("/elsewhere/GH013429.MP4")
    assert projects.resolve_source(missing, project.root) == missing
