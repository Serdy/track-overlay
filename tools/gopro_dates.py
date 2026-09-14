#!/usr/bin/env python3
"""Читает время и координаты из GPMF-потока GoPro и чинит даты файлов.

  python3 tools/gopro_dates.py data/*.MP4            # только показать
  python3 tools/gopro_dates.py --apply data/*.MP4    # ещё и проставить даты
"""
import argparse, datetime, struct, subprocess, sys, tempfile, zoneinfo
from pathlib import Path

TZ = zoneinfo.ZoneInfo("Europe/Warsaw")
FMT = {'b':'b','B':'B','s':'h','S':'H','l':'i','L':'I','f':'f','d':'d'}


def gpmd_index(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "d",
         "-show_entries", "stream=index,codec_tag_string",
         "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True).stdout
    for line in out.splitlines():
        idx, tag = line.split(",")[:2]
        if tag == "gpmd":
            return int(idx)
    return None


def extract(path, idx):
    tmp = Path(tempfile.mkdtemp()) / "gpmd.bin"
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(path), "-codec", "copy",
                    "-map", f"0:{idx}", "-f", "rawvideo", str(tmp)], check=True)
    return tmp.read_bytes()


def walk(buf, off, end, streams, cur=None):
    while off + 8 <= end:
        key = buf[off:off+4].decode('latin1'); typ = buf[off+4]
        ssz = buf[off+5]; rpt = struct.unpack_from('>H', buf, off+6)[0]
        plen = ssz * rpt; body = off + 8
        if typ == 0:
            new = {} if key == 'STRM' else cur
            walk(buf, body, body + plen, streams, new)
            if key == 'STRM' and new:
                streams.append(new)
        elif cur is not None:
            cur.setdefault(key, (chr(typ), ssz, rpt, buf[body:body+plen]))
        off = body + plen + (-plen) % 4
    return streams


def vals(item):
    typ, ssz, rpt, payload = item
    f = FMT.get(typ)
    if not f:
        return None
    n = ssz // struct.calcsize(f)
    return [struct.unpack_from('>' + f * n, payload, i * ssz) for i in range(rpt)]


def gpsu_to_dt(raw):
    """GPSU — ASCII 'ггммддччммсс.ссс' в UTC."""
    s = raw.decode('latin1').strip('\x00').strip()
    return datetime.datetime.strptime(s[:12], "%y%m%d%H%M%S").replace(
        microsecond=int(float(s[12:] or 0) * 1e6), tzinfo=datetime.timezone.utc)


def scan(path):
    idx = gpmd_index(path)
    if idx is None:
        return None
    raw = extract(path, idx)
    blocks = [s for s in walk(raw, 0, len(raw), []) if 'GPSU' in s]
    if not blocks:
        return None
    fixes = [vals(b['GPSF'])[0][0] if 'GPSF' in b else 0 for b in blocks]
    good = [b for b, f in zip(blocks, fixes) if f >= 2]
    coord = None
    if good:
        r = vals(good[0]['GPS5'])[0]
        coord = (r[0] / 1e7, r[1] / 1e7)
    return {
        "start": gpsu_to_dt(blocks[0]['GPSU'][3]),
        "end": gpsu_to_dt(blocks[-1]['GPSU'][3]),
        "blocks": len(blocks), "fixed": len(good), "coord": coord,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+", type=Path)
    ap.add_argument("--apply", action="store_true", help="проставить даты файлам")
    args = ap.parse_args()

    for f in sorted(args.files):
        info = scan(f)
        if not info:
            print(f"{f.name}: GPMF не найден"); continue
        loc = info["start"].astimezone(TZ)
        dur = (info["end"] - info["start"]).total_seconds()
        pos = f"{info['coord'][0]:.5f},{info['coord'][1]:.5f}" if info["coord"] else "нет фикса"
        print(f"{f.name}  {loc:%d.%m.%Y %H:%M:%S} {loc:%Z}  {dur/60:5.1f}мин  "
              f"fix {info['fixed']}/{info['blocks']}  {pos}")
        if args.apply:
            subprocess.run(["touch", "-t", loc.strftime("%Y%m%d%H%M.%S"), str(f)], check=True)
            subprocess.run(["SetFile", "-d", loc.strftime("%m/%d/%Y %H:%M:%S"), str(f)], check=True)


if __name__ == "__main__":
    main()
