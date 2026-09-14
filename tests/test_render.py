import json

import pytest

from trackoverlay import render
from trackoverlay.render import RenderError, build_plan, parse_progress

SESSION = {
    "session": {"duration_s": 300.0},
    "clips": [
        {"id": "cam_a", "files": ["/data/a.mp4"], "offset_s": -10.0, "duration_s": 400.0},
        {"id": "cam_b", "files": ["/data/b1.mp4", "/data/b2.mp4"], "offset_s": -9.0,
         "duration_s": 400.0, "_concat": "/tmp/b.txt"},
    ],
}

LAYOUT = {
    "output": {"width": 1920, "height": 1080, "fps": 60},
    "slots": [{"id": "main", "rect": [0, 0, 1, 1]},
              {"id": "pip", "rect": [0.7, 0.04, 0.28, 0.28]}],
    "cuts": [{"t": 0, "main": "cam_a", "pip": "cam_b"}],
    "widgets": [],
}


def graph_of(plan):
    return plan.args[plan.args.index("-filter_complex") + 1]


def overlays(plan):
    return [step for step in graph_of(plan).split(";") if "overlay=" in step]


def test_single_arrangement_gives_one_overlay_per_slot(tmp_path):
    plan = build_plan(SESSION, LAYOUT, None, tmp_path / "out.mp4")
    assert len(overlays(plan)) == 2                  # main and pip
    assert plan.duration_s == 300.0


def test_a_switch_doubles_the_windows(tmp_path):
    layout = {**LAYOUT, "cuts": [
        {"t": 0, "main": "cam_a", "pip": "cam_b"},
        {"t": 100, "main": "cam_b", "pip": "cam_a"},
    ]}
    plan = build_plan(SESSION, layout, None, tmp_path / "out.mp4")
    steps = overlays(plan)
    assert len(steps) == 4
    assert "between(t,0.000,100.000)" in steps[0]
    assert "between(t,100.000,300.000)" in steps[2]


def test_windows_never_run_past_the_requested_duration(tmp_path):
    """Rendering a short piece must not emit windows that can never fire."""
    layout = {**LAYOUT, "cuts": [
        {"t": 0, "main": "cam_a", "pip": "cam_b"},
        {"t": 100, "main": "cam_b", "pip": "cam_a"},
    ]}
    plan = build_plan(SESSION, layout, None, tmp_path / "out.mp4", duration_s=30)
    for step in overlays(plan):
        end = float(step.split(",")[-1].split(")")[0])
        assert end <= 30.0 + 1e-6


def test_redundant_cuts_do_not_grow_the_graph(tmp_path):
    layout = {**LAYOUT, "cuts": [
        {"t": 0, "main": "cam_a", "pip": "cam_b"},
        {"t": 50, "main": "cam_a", "pip": "cam_b"},     # changes nothing
        {"t": 100, "main": "cam_b", "pip": "cam_a"},
    ]}
    plan = build_plan(SESSION, layout, None, tmp_path / "out.mp4")
    assert len(overlays(plan)) == 4


def test_single_camera_needs_no_pip(tmp_path):
    layout = {**LAYOUT, "cuts": [{"t": 0, "main": "cam_a", "pip": None}]}
    plan = build_plan(SESSION, layout, None, tmp_path / "out.mp4")
    assert len(overlays(plan)) == 1


def test_pip_geometry_follows_the_slot_rectangle(tmp_path):
    plan = build_plan(SESSION, LAYOUT, None, tmp_path / "out.mp4")
    pip = overlays(plan)[1]
    assert "x=1344" in pip                            # 0.7 * 1920
    assert "y=43" in pip                              # 0.04 * 1080


def test_scaling_uses_even_dimensions(tmp_path):
    """h264 refuses odd pixel dimensions."""
    layout = {**LAYOUT, "slots": [{"id": "main", "rect": [0, 0, 1, 1]},
                                  {"id": "pip", "rect": [0.7, 0.04, 0.2777, 0.2777]}]}
    plan = build_plan(SESSION, layout, None, tmp_path / "out.mp4")
    for size in [step.split("scale=")[1].split(":")[:2]
                 for step in graph_of(plan).split(";") if "scale=" in step]:
        assert int(size[0]) % 2 == 0 and int(size[1]) % 2 == 0


def test_sync_offset_is_applied_per_input(tmp_path):
    plan = build_plan(SESSION, LAYOUT, None, tmp_path / "out.mp4")
    offsets = [plan.args[i + 1] for i, a in enumerate(plan.args) if a == "-itsoffset"]
    assert offsets == ["-10.000", "-9.000"]


def test_chunked_clip_goes_through_concat(tmp_path):
    plan = build_plan(SESSION, LAYOUT, None, tmp_path / "out.mp4")
    assert "concat" in plan.args
    assert "/tmp/b.txt" in plan.inputs


def test_overlay_is_the_last_layer(tmp_path):
    overlay = tmp_path / "overlay.webm"
    overlay.touch()
    plan = build_plan(SESSION, LAYOUT, overlay, tmp_path / "out.mp4")
    assert overlays(plan)[-1].endswith("[out]")
    assert plan.args[plan.args.index("-map") + 1] == "[out]"


def test_overlay_halves_are_recombined(tmp_path):
    """The layer is colour over matte in one frame, because browsers will not encode alpha."""
    overlay = tmp_path / "overlay.webm"
    overlay.touch()
    graph = graph_of(build_plan(SESSION, LAYOUT, overlay, tmp_path / "out.mp4"))
    assert "crop=1920:1080:0:0" in graph          # colour, top half
    assert "crop=1920:1080:0:1080" in graph       # matte, bottom half
    assert "alphamerge" in graph


def test_without_overlay_the_last_camera_layer_is_mapped(tmp_path):
    plan = build_plan(SESSION, LAYOUT, None, tmp_path / "out.mp4")
    assert plan.args[plan.args.index("-map") + 1].startswith("[b")


def test_audio_comes_from_the_opening_camera(tmp_path):
    plan = build_plan(SESSION, LAYOUT, None, tmp_path / "out.mp4")
    maps = [plan.args[i + 1] for i, a in enumerate(plan.args) if a == "-map"]
    assert "1:a?" in maps                             # cam_a is input 1
    assert render.AUDIO_CODEC in plan.args


def test_hardware_encoder_and_output_path(tmp_path):
    out = tmp_path / "final.mp4"
    plan = build_plan(SESSION, LAYOUT, None, out)
    assert render.VIDEO_CODEC in plan.args
    assert plan.args[-1] == str(out)


def test_empty_cut_list_is_rejected(tmp_path):
    with pytest.raises(RenderError, match="no camera arrangement"):
        build_plan(SESSION, {**LAYOUT, "cuts": []}, None, tmp_path / "out.mp4")


def test_unknown_clip_is_rejected(tmp_path):
    layout = {**LAYOUT, "cuts": [{"t": 0, "main": "cam_ghost", "pip": None}]}
    with pytest.raises(RenderError, match="absent from the session"):
        build_plan(SESSION, layout, None, tmp_path / "out.mp4")


def test_slot_with_no_camera_is_rejected(tmp_path):
    layout = {**LAYOUT, "cuts": [{"t": 0, "main": None, "pip": None}]}
    with pytest.raises(RenderError, match="no camera occupies"):
        build_plan(SESSION, layout, None, tmp_path / "out.mp4")


def test_chunked_clip_without_concat_list_is_rejected(tmp_path):
    session = json.loads(json.dumps(SESSION))
    del session["clips"][1]["_concat"]
    layout = {**LAYOUT, "cuts": [{"t": 0, "main": "cam_b", "pip": None}]}
    with pytest.raises(RenderError, match="concat list"):
        build_plan(session, layout, None, tmp_path / "out.mp4")


@pytest.mark.parametrize("line, expected", [
    ("out_time_ms=15000000", 0.5),
    ("out_time_ms=0", 0.0),
    ("out_time_ms=99000000", 1.0),                    # clamped
])
def test_parse_progress(line, expected):
    assert parse_progress(line, 30.0) == pytest.approx(expected)


@pytest.mark.parametrize("line", ["frame=120", "", "speed=1.2x"])
def test_parse_progress_ignores_other_lines(line):
    assert parse_progress(line, 30.0) is None


def test_parse_progress_without_duration():
    assert parse_progress("out_time_ms=1000", 0.0) is None
