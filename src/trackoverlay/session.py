"""Assembling a session: from raw files to ``session.json``.

``session.json`` is the contract between Python and the browser. Python knows nothing
about drawing, the browser nothing about parsing formats. Every time inside the file is
counted in seconds from the session start rather than as an absolute stamp: that spares
the browser any epoch arithmetic and keeps the numbers short.
"""

from __future__ import annotations

import datetime as _dt
import json
from dataclasses import dataclass
from pathlib import Path

from . import laps as L
from . import sync
from . import telemetry as T
from .ingest import clips, gpmf, racebox

# Rounding on serialisation: at full float precision the channel set inflates the file
# fivefold, and resolution finer than this carries no meaning anyway.
ROUND = {"lat": 7, "lon": 7, "speed": 2, "lean": 1, "accel": 3, "dist": 1}


class SessionError(Exception):
    """The session cannot be assembled from the given files."""


@dataclass
class Session:
    start_utc: float
    track: str
    telemetry: T.Telemetry
    laps: list[L.Lap]
    gate: L.Gate
    envelope: tuple[list, list]
    clips: list[dict]

    def as_dict(self) -> dict:
        best = min((lap.duration_s for lap in self.laps), default=None)
        stamp = _dt.datetime.fromtimestamp(self.start_utc, _dt.timezone.utc)
        return {
            "session": {
                "start_utc": stamp.isoformat().replace("+00:00", "Z"),
                "track": self.track,
                "duration_s": round(self.telemetry.times[-1] - self.start_utc, 3),
                # The grid is uniform by construction, so sample i sits at exactly
                # i / rate_hz — the browser needs no separate time axis.
                "rate_hz": round(self.telemetry.rate_hz, 4),
            },
            "channels": {
                name: {
                    "role": channel.role,
                    "unit": channel.unit,
                    "samples": [round(v, ROUND.get(name, 3)) for v in channel.samples],
                }
                for name, channel in self.telemetry.channels.items()
            },
            "laps": [
                {
                    "n": lap.number,
                    "t_start": round(lap.t_start - self.start_utc, 3),
                    "t_end": round(lap.t_end - self.start_utc, 3),
                    "duration_s": round(lap.duration_s, 3),
                    "best": best is not None and abs(lap.duration_s - best) < 1e-6,
                }
                for lap in self.laps
            ],
            "gates": [{"id": "sf", "name": "Start / Finish", **self.gate.as_dict()}],
            "envelope": {"left": self.envelope[0], "right": self.envelope[1]},
            "clips": self.clips,
        }

    def write(self, path: Path) -> Path:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.as_dict(), ensure_ascii=False,
                                   separators=(",", ":")), encoding="utf-8")
        return path


def _build_telemetry(data: racebox.RaceBoxData) -> T.Telemetry:
    columns = data.columns
    tel = T.Telemetry(times=data.times)

    tel.add("lat", "lat", "deg", columns["lat"])
    tel.add("lon", "lon", "deg", columns["lon"])
    tel.add("speed", "speed", "km/h", columns["speed_kmh"])

    # Heading: a dedicated VBO column is noticeably cleaner than a derivative of coordinates.
    heading = columns.get("heading_deg") or T.heading_from_track(columns["lat"],
                                                                columns["lon"])
    smooth = T.LEAN_SMOOTH_S if "heading_deg" in columns else T.LEAN_SMOOTH_S * 2.5
    tel.add("lean", "lean", "deg",
            T.compute_lean(columns["speed_kmh"], heading, data.times, smooth_s=smooth))

    # A ready G column beats differentiating speed: it carries no differentiation noise.
    accel = columns.get("g_long") or T.accel_long_g(columns["speed_kmh"], data.times)
    tel.add("accel", "accel_long", "g", accel)

    tel.add("dist", "distance", "m",
            T.cumulative_distance_m(columns["lat"], columns["lon"]))
    return tel


def _align_clips(found: list[clips.Clip], tel: T.Telemetry,
                 start_utc: float) -> list[dict]:
    speeds = tel["speed"]
    out = []
    for clip in found:
        samples: list[gpmf.GpsSample] = []
        for path in clip.files:
            try:
                samples += gpmf.read_gps(path)
            except (gpmf.GpmfError, OSError):
                pass                      # video without telemetry has to show up too
        result = sync.align([s.t_utc for s in samples], [s.speed_kmh for s in samples],
                            tel.times, speeds, session_start_utc=start_utc)
        proxies = clip.proxies()
        out.append({
            "id": f"cam_{clip.id}",
            "files": [str(p) for p in clip.files],
            # Duration of each chunk: the browser plays them through one <video> tag and
            # needs to know where one file ends and the next begins.
            "chunks": [round(c.duration_s, 3) for c in clip.chunks],
            "proxy": [str(p) for p in proxies] if proxies else None,
            "offset_s": round(result.offset_s, 3),
            "duration_s": round(clip.duration_s, 3),
            "sync": {
                "method": result.method,
                "correlation": round(result.correlation, 4),
                "correction_s": round(result.correction_s, 3),
                "reliable": result.reliable,
            },
        })
    return out


def build_session(racebox_files: list[Path], video_files: list[Path],
                  *, track: str = "") -> Session:
    """The full pipeline: parsers, synchronisation, laps, envelope."""
    if not racebox_files:
        raise SessionError("no RaceBox export was given")

    csvs = [p for p in racebox_files if p.suffix.lower() == ".csv"]
    vbos = [p for p in racebox_files if p.suffix.lower() == ".vbo"]
    if not csvs:
        raise SessionError("at least one RaceBox CSV is required — a VBO alone will not do")

    parts = [racebox.read_csv(p) for p in csvs] + [racebox.read_vbo(p) for p in vbos]
    data = racebox.merge(*parts)
    tel = T.resample_uniform(_build_telemetry(data), round(data.rate_hz))
    start_utc = tel.times[0]

    lats, lons = tel["lat"], tel["lon"]
    gate = L.detect_start_finish(lats, lons, T.heading_from_track(lats, lons),
                                 tel["speed"])
    crossings = L.find_crossings(lats, lons, tel.times, gate)
    found_laps = L.split_laps(tel.times, crossings)
    if not found_laps:
        raise SessionError(
            "could not mark out a single lap — the track is shorter than a lap, or no gate was found")
    envelope = L.build_envelope(lats, lons, found_laps)

    found_clips = clips.discover(video_files) if video_files else []
    aligned = _align_clips(found_clips, tel, start_utc)
    if found_clips and not any(c["sync"]["reliable"] for c in aligned):
        # Not an error: footage without GPS still cuts together, just by hand.
        pass

    return Session(start_utc, track, tel, found_laps, gate, envelope, aligned)
