/**
 * Track map: the envelope of all laps, the recent trail and the position dot.
 *
 * Nothing is downloaded — the outline is drawn from the session's own GPS trace. Your
 * own trajectory beats any third-party picture, because it is literally where you
 * rode. No tiles, no Leaflet, no network calls: rendering has to work offline, or
 * batch export ends up depending on the internet.
 *
 * The envelope is static for the whole session, so it is projected once and reused.
 * There is no reason to recompute it sixty times a second.
 */
(function (register) {
  const PAD = 0.08;              // padding inside the widget, as a fraction of its shorter side
  const TRAIL_S = 6;             // how many seconds of trail follow the dot

  // Where the trail reaches full colour, in seconds gained per second. Measured over the
  // eight laps in `data/`: half the samples sit under 0.04 s, three quarters under 0.08.
  // Scaled linearly from there the trail comes out white for most of a lap - which is
  // honest and useless, since the point is to be read at a glance on a small map. The
  // square root lifts ordinary riding into visible colour and still leaves the strongest
  // quarter to saturate. Under DEAD_GAIN the difference is noise and the trail is neutral.
  const FULL_GAIN = 0.10;
  const DEAD_GAIN = 0.02;

  const NEUTRAL = [235, 235, 235];
  const GAINING = [61, 208, 122];
  const LOSING = [226, 72, 61];

  /** Bounding box of the given lat/lon lines. */
  function bounds(lines) {
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const line of lines) {
      for (const [lat, lon] of line) {
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
      }
    }
    return { minLat, maxLat, minLon, maxLon };
  }

  /**
   * Projects lat/lon into widget pixels, preserving the aspect ratio.
   *
   * Longitude has to be squeezed by the cosine of the latitude: at 48° a degree of
   * longitude is about a third shorter than a degree of latitude. Without that
   * correction the circuit comes out stretched sideways.
   */
  function makeProjection(box, box_bounds) {
    const b = box_bounds;
    const midLat = (b.minLat + b.maxLat) / 2;
    const kx = Math.cos(midLat * Math.PI / 180);
    const spanX = Math.max((b.maxLon - b.minLon) * kx, 1e-9);
    const spanY = Math.max(b.maxLat - b.minLat, 1e-9);

    const pad = Math.min(box.w, box.h) * PAD;
    const innerW = Math.max(box.w - pad * 2, 1);
    const innerH = Math.max(box.h - pad * 2, 1);
    const scale = Math.min(innerW / spanX, innerH / spanY);

    const offsetX = box.x + pad + (innerW - spanX * scale) / 2;
    const offsetY = box.y + pad + (innerH - spanY * scale) / 2;

    return (lat, lon) => [
      offsetX + (lon - b.minLon) * kx * scale,
      // Screen coordinates grow downwards, latitude grows upwards — so flip.
      offsetY + (b.maxLat - lat) * scale,
    ];
  }

  /**
   * The trail colour for one moment: green where time is coming out of the best lap so
   * far, red where it is going the other way, neutral where there is nothing to say -
   * before the first lap is finished, or on a stretch matching it too closely to call.
   */
  function trailColor(gain) {
    if (gain === null || gain === undefined) return `rgb(${NEUTRAL.join(',')})`;
    const span = FULL_GAIN - DEAD_GAIN;
    const share = Math.min(1, Math.max(0, (Math.abs(gain) - DEAD_GAIN) / span));
    const strength = Math.sqrt(share);
    const target = gain > 0 ? GAINING : LOSING;
    const mixed = NEUTRAL.map((from, i) => Math.round(from + (target[i] - from) * strength));
    return `rgb(${mixed.join(',')})`;
  }

  function strokeLine(ctx, points, color, width) {
    if (points.length < 2) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i][0], points[i][1]);
    ctx.stroke();
  }

  register({
    id: 'map',
    title: 'Track map',
    defaultSize: [0.17, 0.30],

    /** Bounds and projection are computed once per session, not per frame. */
    prepare(session, box) {
      const envelope = session.envelope || { left: [], right: [] };
      const lines = [envelope.left, envelope.right].filter((line) => line.length);
      if (!lines.length) return null;

      const project = makeProjection(box, bounds(lines));
      return {
        box,
        project,
        left: envelope.left.map(([lat, lon]) => project(lat, lon)),
        right: envelope.right.map(([lat, lon]) => project(lat, lon)),
      };
    },

    draw(ctx, box, data) {
      const W = (typeof Widgets !== 'undefined') ? Widgets : require('./index.js');
      const prepared = data.map;
      if (!prepared) return;

      W.plate(ctx, box);

      // The band the session's laps actually occupy: one edge out, the other back.
      if (prepared.left.length && prepared.right.length) {
        ctx.fillStyle = 'rgba(255,255,255,0.16)';
        ctx.beginPath();
        ctx.moveTo(prepared.left[0][0], prepared.left[0][1]);
        for (const [x, y] of prepared.left) ctx.lineTo(x, y);
        for (let i = prepared.right.length - 1; i >= 0; i -= 1) {
          ctx.lineTo(prepared.right[i][0], prepared.right[i][1]);
        }
        ctx.closePath();
        ctx.fill();
      }

      strokeLine(ctx, prepared.left, 'rgba(255,255,255,0.30)', Math.max(1, box.h * 0.006));
      strokeLine(ctx, prepared.right, 'rgba(255,255,255,0.30)', Math.max(1, box.h * 0.006));

      // Stroked segment by segment rather than as one line: the whole point is that one
      // corner reads differently from the next. Six seconds of trail is thirty segments.
      if (data.trail && data.trail.length > 1) {
        const points = data.trail.map(([lat, lon]) => prepared.project(lat, lon));
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.lineWidth = Math.max(1.5, box.h * 0.012);
        for (let i = 1; i < points.length; i += 1) {
          ctx.strokeStyle = trailColor(data.trail[i][2]);
          ctx.beginPath();
          ctx.moveTo(points[i - 1][0], points[i - 1][1]);
          ctx.lineTo(points[i][0], points[i][1]);
          ctx.stroke();
        }
      }

      if (data.lat !== null && data.lat !== undefined &&
          data.lon !== null && data.lon !== undefined) {
        const [x, y] = prepared.project(data.lat, data.lon);
        const radius = Math.max(2, box.h * 0.022);
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#e2483d';
        ctx.lineWidth = Math.max(1, radius * 0.45);
        ctx.stroke();
      }
    },

    TRAIL_S,
    FULL_GAIN,
    _trailColor: trailColor,
    _bounds: bounds,
    _makeProjection: makeProjection,
  });
}(typeof Widgets !== 'undefined' ? Widgets.register : require('./index.js').register));
