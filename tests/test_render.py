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


def test_a_clip_starting_before_the_session_is_seeked_into(tmp_path):
    """A negative -itsoffset would push frames to negative timestamps, where ffmpeg
    drops them - silently cancelling the sync correction."""
    plan = build_plan(SESSION, LAYOUT, None, tmp_path / "out.mp4")
    seeks = [plan.args[i + 1] for i, a in enumerate(plan.args) if a == "-ss"]
    assert seeks == ["10.000", "9.000"]              # both clips start early
    assert "-itsoffset" not in plan.args


def test_a_clip_starting_after_the_session_is_delayed(tmp_path):
    session = json.loads(json.dumps(SESSION))
    session["clips"][0]["offset_s"] = 4.5
    layout = {**LAYOUT, "cuts": [{"t": 0, "main": "cam_a", "pip": None}]}
    plan = build_plan(session, layout, None, tmp_path / "out.mp4")
    assert plan.args[plan.args.index("-itsoffset") + 1] == "4.500"
    assert "-ss" not in plan.args


def test_a_delayed_clip_keeps_its_timestamps(tmp_path):
    """setpts=PTS-STARTPTS would re-zero the start and undo the delay."""
    session = json.loads(json.dumps(SESSION))
    session["clips"][0]["offset_s"] = 4.5
    layout = {**LAYOUT, "cuts": [{"t": 0, "main": "cam_a", "pip": None}]}
    graph = graph_of(build_plan(session, layout, None, tmp_path / "out.mp4"))
    assert "setpts=PTS-STARTPTS" not in graph


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
    assert render.video_codec() in plan.args
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


# --- cutting stretches out ---------------------------------------------------

def test_without_ranges_nothing_is_trimmed(tmp_path):
    plan = build_plan(SESSION, LAYOUT, None, tmp_path / "out.mp4")
    assert "trim=" not in graph_of(plan)
    assert plan.duration_s == 300.0


def test_a_single_range_trims_the_ends(tmp_path):
    """The case that prompted this: a long in-lap and a long cool-down."""
    layout = {**LAYOUT, "ranges": [{"from": 40, "to": 250}]}
    plan = build_plan(SESSION, layout, None, tmp_path / "out.mp4")
    graph = graph_of(plan)
    assert "trim=start=40.000:end=250.000" in graph
    assert plan.duration_s == pytest.approx(210.0)


def test_two_ranges_are_concatenated(tmp_path):
    layout = {**LAYOUT, "ranges": [{"from": 0, "to": 40}, {"from": 60, "to": 300}]}
    plan = build_plan(SESSION, layout, None, tmp_path / "out.mp4")
    graph = graph_of(plan)
    assert "concat=n=2:v=1:a=1" in graph
    assert "split=2" in graph and "asplit=2" in graph
    assert plan.duration_s == pytest.approx(280.0)


def test_ranges_are_sorted_and_merged(tmp_path):
    layout = {**LAYOUT, "ranges": [{"from": 200, "to": 300}, {"from": 0, "to": 100},
                                   {"from": 100, "to": 150}]}
    plan = build_plan(SESSION, layout, None, tmp_path / "out.mp4")
    # The first two touch and fold into one, leaving two stretches in order.
    assert "concat=n=2" in graph_of(plan)
    assert plan.duration_s == pytest.approx(250.0)


def test_ranges_are_clamped_to_the_session(tmp_path):
    layout = {**LAYOUT, "ranges": [{"from": -50, "to": 9999}]}
    plan = build_plan(SESSION, layout, None, tmp_path / "out.mp4")
    assert plan.duration_s == pytest.approx(300.0)


def test_empty_ranges_mean_keep_everything(tmp_path):
    """A layout saved before ranges existed must still render in full."""
    for value in ([], None):
        plan = build_plan(SESSION, {**LAYOUT, "ranges": value}, None, tmp_path / "out.mp4")
        assert plan.duration_s == 300.0


def test_trimmed_audio_comes_through_the_graph(tmp_path):
    layout = {**LAYOUT, "ranges": [{"from": 40, "to": 250}]}
    plan = build_plan(SESSION, layout, None, tmp_path / "out.mp4")
    maps = [plan.args[i + 1] for i, a in enumerate(plan.args) if a == "-map"]
    assert "[ca]" in maps
    assert "atrim=start=40.000" in graph_of(plan)


def test_the_output_duration_drives_the_length_limit(tmp_path):
    layout = {**LAYOUT, "ranges": [{"from": 100, "to": 160}]}
    plan = build_plan(SESSION, layout, None, tmp_path / "out.mp4")
    # The first -t sizes the black base, which has to reach the last moment read from the
    # session; the last one caps the output, and that is what shrinks with the ranges.
    limits = [plan.args[i + 1] for i, a in enumerate(plan.args) if a == "-t"]
    assert limits[0] == "160.000"
    assert limits[-1] == "60.000"


def test_a_window_late_in_the_session_is_rendered_where_it_is(tmp_path):
    """Exporting one lap asks for a stretch in session time plus a length of output.

    Clamping the stretch with that length - which is what used to happen - left nothing,
    and the fallback rendered the opening minutes instead, with the overlay of the chosen
    lap laid over the wrong picture.
    """
    layout = {**LAYOUT, "ranges": [{"from": 200, "to": 260}]}
    plan = build_plan(SESSION, layout, None, tmp_path / "out.mp4", duration_s=60)

    graph = " ".join(plan.args)
    assert "trim=start=200.000:end=260.000" in graph
    limits = [plan.args[i + 1] for i, a in enumerate(plan.args) if a == "-t"]
    assert limits[-1] == "60.000"


def test_a_preview_of_a_trimmed_session_starts_where_the_trim_does(tmp_path):
    layout = {**LAYOUT, "ranges": [{"from": 100, "to": 300}]}
    plan = build_plan(SESSION, layout, None, tmp_path / "out.mp4", duration_s=10)

    assert "trim=start=100.000:end=110.000" in " ".join(plan.args)
    limits = [plan.args[i + 1] for i, a in enumerate(plan.args) if a == "-t"]
    assert limits[-1] == "10.000"


def test_a_preview_of_an_untrimmed_session_is_the_opening_seconds(tmp_path):
    plan = build_plan(SESSION, LAYOUT, None, tmp_path / "out.mp4", duration_s=10)
    limits = [plan.args[i + 1] for i, a in enumerate(plan.args) if a == "-t"]
    assert limits[-1] == "10.000"


def test_the_overlay_is_laid_on_after_the_trimming(tmp_path):
    """The browser renders the layer against output time, not session time.

    Laying it on before the cuts would apply the range offset a second time and slide
    the telemetry away from the picture.
    """
    overlay = tmp_path / "overlay.mp4"
    overlay.touch()
    layout = {**LAYOUT, "ranges": [{"from": 40, "to": 250}]}
    graph = graph_of(build_plan(SESSION, layout, overlay, tmp_path / "out.mp4"))
    steps = graph.split(";")
    concat = next(i for i, s in enumerate(steps) if "concat=" in s)
    merge = next(i for i, s in enumerate(steps) if "alphamerge" in s)
    assert merge > concat, "the overlay must come after the trimming"


def test_without_trimming_the_overlay_is_still_last(tmp_path):
    overlay = tmp_path / "overlay.mp4"
    overlay.touch()
    graph = graph_of(build_plan(SESSION, LAYOUT, overlay, tmp_path / "out.mp4"))
    assert graph.split(";")[-1].endswith("[out]")


def test_a_short_window_uses_one_chunk_instead_of_concat(tmp_path):
    """Seeking into a concat list is slow - 19.8 s against 9.4 s for the same seek on a
    single file - and a short render usually needs only one chunk."""
    session = json.loads(json.dumps(SESSION))
    session["clips"][1]["chunks"] = [700.0, 700.0]
    layout = {**LAYOUT, "cuts": [{"t": 0, "main": "cam_b", "pip": None}]}
    plan = build_plan(session, layout, None, tmp_path / "out.mp4", duration_s=30)
    assert "/data/b1.mp4" in plan.inputs
    assert "concat" not in plan.args


def test_a_window_crossing_a_joint_still_concatenates(tmp_path):
    session = json.loads(json.dumps(SESSION))
    session["clips"][1]["chunks"] = [700.0, 700.0]
    session["clips"][1]["offset_s"] = -690.0            # starts just before the joint
    layout = {**LAYOUT, "cuts": [{"t": 0, "main": "cam_b", "pip": None}]}
    plan = build_plan(session, layout, None, tmp_path / "out.mp4", duration_s=60)
    assert "concat" in plan.args
    assert "/tmp/b.txt" in plan.inputs


def test_the_seek_is_rebased_onto_the_chosen_chunk(tmp_path):
    session = json.loads(json.dumps(SESSION))
    session["clips"][1]["chunks"] = [700.0, 700.0]
    session["clips"][1]["offset_s"] = -900.0            # inside the second chunk
    layout = {**LAYOUT, "cuts": [{"t": 0, "main": "cam_b", "pip": None}]}
    plan = build_plan(session, layout, None, tmp_path / "out.mp4", duration_s=30)
    assert "/data/b2.mp4" in plan.inputs
    assert plan.args[plan.args.index("-ss") + 1] == "200.000"   # 900 - 700


@pytest.mark.parametrize("full_frame_base", [True, False])
def test_the_overlay_input_index_matches_its_position(tmp_path, full_frame_base):
    """Input 0 is the black canvas only when no camera fills the frame, so the overlay's
    index cannot be derived from the clip count alone."""
    overlay = tmp_path / "overlay.mp4"
    overlay.touch()
    slots = ([{"id": "main", "rect": [0, 0, 1, 1]}] if full_frame_base
             else [{"id": "main", "rect": [0.1, 0.1, 0.5, 0.5]}])
    session = json.loads(json.dumps(SESSION))
    for clip in session["clips"]:
        clip["width"], clip["height"] = 1920, 1080
    layout = {**LAYOUT, "slots": slots + [{"id": "pip", "rect": [0.7, 0.04, 0.28, 0.28]}]}

    plan = build_plan(session, layout, overlay, tmp_path / "out.mp4")
    import re
    # ffmpeg numbers every -i, including the synthetic black canvas, which `inputs` does
    # not list - so count the flags rather than the files.
    last = sum(1 for a in plan.args if a == "-i") - 1
    referenced = {int(m) for m in re.findall(r"\[(\d+):v\]crop=", graph_of(plan))}
    assert referenced == {last}, "the overlay must be the last input"


def test_the_encoder_follows_the_machine(monkeypatch):
    """VideoToolbox is a Mac thing; asking for it on Linux fails outright, and the render
    inside a container would never start."""
    monkeypatch.delenv("TRACKOVERLAY_CODEC", raising=False)
    monkeypatch.setattr(render.sys, "platform", "darwin")
    assert render.video_codec() == "h264_videotoolbox"
    monkeypatch.setattr(render.sys, "platform", "linux")
    assert render.video_codec() == "libx264"
    monkeypatch.setenv("TRACKOVERLAY_CODEC", "h264_nvenc")
    assert render.video_codec() == "h264_nvenc"


def test_footage_that_has_been_moved_is_named_before_ffmpeg_runs(tmp_path):
    """ffmpeg finds this too, but only after opening every input, and it reports a bare
    path with no hint of which camera it was or what to do."""
    session = {"clips": [{"id": "cam_3446",
                          "files": [str(tmp_path / "gone" / "GH013446.MP4")]}]}
    with pytest.raises(render.RenderError, match="cam_3446: the footage is gone"):
        render.check_footage(session, tmp_path)


def test_footage_still_in_the_project_folder_passes(tmp_path):
    (tmp_path / "GH013446.MP4").write_bytes(b"x")
    session = {"clips": [{"id": "cam_3446", "files": ["/moved/away/GH013446.MP4"]}]}
    render.check_footage(session, tmp_path)
