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

      if (data.trail && data.trail.length > 1) {
        strokeLine(ctx, data.trail.map(([lat, lon]) => prepared.project(lat, lon)),
                   '#e2483d', Math.max(1.5, box.h * 0.012));
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
    _bounds: bounds,
    _makeProjection: makeProjection,
  });
}(typeof Widgets !== 'undefined' ? Widgets.register : require('./index.js').register));
