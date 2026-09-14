#!/usr/bin/env python3
"""Проверяет сведение GoPro (GPMF) и RaceBox (CSV) по скорости.

Считает лаг кросс-корреляцией и сравнивает с тем, что обещает UTC.
"""
import csv, datetime, struct, subprocess, sys, tempfile
from pathlib import Path
import numpy as np

FMT = {'b':'b','B':'B','s':'h','S':'H','l':'i','L':'I','f':'f','d':'d'}
GRID_HZ = 10.0
MAX_LAG_S = 60.0


def gpmd_index(path):
    out = subprocess.run(["ffprobe","-v","error","-select_streams","d",
        "-show_entries","stream=index,codec_tag_string","-of","csv=p=0",str(path)],
        capture_output=True, text=True, check=True).stdout
    for line in out.splitlines():
        idx, tag = line.split(",")[:2]
        if tag == "gpmd":
            return int(idx)
    raise SystemExit(f"{path}: поток gpmd не найден")


def walk(buf, off, end, streams, cur=None):
    while off + 8 <= end:
        key = buf[off:off+4].decode('latin1'); typ = buf[off+4]
        ssz = buf[off+5]; rpt = struct.unpack_from('>H', buf, off+6)[0]
        plen = ssz*rpt; body = off+8
        if typ == 0:
            new = {} if key == 'STRM' else cur
            walk(buf, body, body+plen, streams, new)
            if key == 'STRM' and new: streams.append(new)
        elif cur is not None:
            cur.setdefault(key, (chr(typ), ssz, rpt, buf[body:body+plen]))
        off = body + plen + (-plen) % 4
    return streams


def vals(item):
    typ, ssz, rpt, payload = item
    f = FMT[typ]; n = ssz // struct.calcsize(f)
    return [struct.unpack_from('>'+f*n, payload, i*ssz) for i in range(rpt)]


def gpsu(raw):
    s = raw.decode('latin1').strip('\x00').strip()
    return datetime.datetime.strptime(s[:12], "%y%m%d%H%M%S").replace(
        microsecond=int(float(s[12:] or 0)*1e6), tzinfo=datetime.timezone.utc).timestamp()


def gopro_speed(paths):
    """→ (массив epoch-секунд, массив км/ч), склеенный по всем чанкам."""
    ts, sp = [], []
    for p in paths:
        tmp = Path(tempfile.mkdtemp())/"g.bin"
        subprocess.run(["ffmpeg","-v","error","-y","-i",str(p),"-codec","copy",
                        "-map",f"0:{gpmd_index(p)}","-f","rawvideo",str(tmp)], check=True)
        raw = tmp.read_bytes()
        blocks = [s for s in walk(raw, 0, len(raw), []) if 'GPS5' in s and 'GPSU' in s]
        times = [gpsu(b['GPSU'][3]) for b in blocks]
        for i, b in enumerate(blocks):
            if (vals(b['GPSF'])[0][0] if 'GPSF' in b else 0) < 2:
                continue
            scal = [v[0] for v in vals(b['SCAL'])]
            rows = vals(b['GPS5'])
            t0 = times[i]
            t1 = times[i+1] if i+1 < len(times) else t0 + 1.0
            for j, r in enumerate(rows):
                ts.append(t0 + (t1-t0)*j/len(rows))
                sp.append(r[3]/scal[3]*3.6)
    return np.array(ts), np.array(sp)


def racebox_speed(csv_path):
    ts, sp = [], []
    with open(csv_path, newline='') as f:
        for row in csv.DictReader(f):
            t = datetime.datetime.strptime(row['Time'], "%Y-%m-%dT%H:%M:%S.%fZ")
            ts.append(t.replace(tzinfo=datetime.timezone.utc).timestamp())
            sp.append(float(row['Speed']))
    return np.array(ts), np.array(sp)


def main():
    rb_csv, gp_files = sys.argv[1], sys.argv[2:]
    gt, gs = gopro_speed([Path(p) for p in gp_files])
    rt, rs = racebox_speed(rb_csv)

    iso = lambda e: datetime.datetime.fromtimestamp(e, datetime.timezone.utc).strftime('%H:%M:%S.%f')[:-3]
    print(f"GoPro   {iso(gt[0])} → {iso(gt[-1])} UTC   {len(gt):6d} сэмплов  ~{len(gt)/(gt[-1]-gt[0]):.1f} Гц")
    print(f"RaceBox {iso(rt[0])} → {iso(rt[-1])} UTC   {len(rt):6d} сэмплов  ~{len(rt)/(rt[-1]-rt[0]):.1f} Гц")

    lo, hi = max(gt[0], rt[0]), min(gt[-1], rt[-1])
    print(f"\nПерекрытие по UTC: {iso(lo)} → {iso(hi)}  ({(hi-lo)/60:.1f} мин)")
    if hi - lo < 60:
        raise SystemExit("Перекрытие слишком мало")

    grid = np.arange(lo, hi, 1.0/GRID_HZ)
    g = np.interp(grid, gt, gs)
    r = np.interp(grid, rt, rs)
    gz = (g - g.mean())/g.std()
    rz = (r - r.mean())/r.std()

    maxlag = int(MAX_LAG_S*GRID_HZ)
    lags = np.arange(-maxlag, maxlag+1)
    corr = np.array([np.corrcoef(gz[max(0,l):len(gz)+min(0,l)],
                                 rz[max(0,-l):len(rz)+min(0,-l)])[0,1] for l in lags])
    best = lags[np.argmax(corr)]/GRID_HZ
    print(f"\nКорреляция при нулевом лаге : {corr[maxlag]:+.4f}")
    print(f"Пик корреляции             : {corr.max():+.4f}  при лаге {best:+.2f} с")
    print(f"\nВывод: UTC {'сходится' if abs(best) < 0.5 else 'РАСХОДИТСЯ'}, "
          f"поправка {best:+.2f} с")


if __name__ == "__main__":
    main()
