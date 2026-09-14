/**
 * sr-track.js — SR_TRACK module (canonical source)
 *
 * Pure logic: no DOM, no jQuery, no window.SRSRCNG.
 *
 * DUAL-EXPORT SEAM
 * ----------------
 * Bottom of this file uses:
 *   if (typeof module !== 'undefined' && module.exports) { module.exports = SR_TRACK; }
 *   else { window.SR_TRACK = SR_TRACK; }
 *
 * In Node (unit tests):  require('./sr-track.js') returns the SR_TRACK object.
 * In the browser (page): `module` is undefined, so window.SR_TRACK is assigned instead.
 * No ReferenceError in either environment — the guard is safe everywhere.
 *
 * KEEPING IN SYNC WITH THE USERSCRIPT
 * ------------------------------------
 * The body of this file (everything between the "BEGIN sr-track inline" and
 * "END sr-track inline" markers below) is copied verbatim into
 * serious-racing-lean-angle.user.js inside its IIFE, replacing any prior inline
 * copy.  When you change logic here, update that inlined block too.
 * Search for "BEGIN sr-track inline" to find it.
 *
 * Why a separate file instead of extracting from the IIFE?
 *   The userscript must be a single self-contained .user.js for Tampermonkey —
 *   no build step, no external require.  A separate module file lets Node tests
 *   import the logic directly while the userscript inlines the same code.
 *
 * SPEED UNIT DECISION
 * -------------------
 * riders[i].data col2 is the mph BASE unit per CLAUDE.md (authoritative).
 * Conversion: v_ms = col2 * 0.44704  (mph → m/s; exact NIST factor).
 * col4 is already in m/s². Both channels are thus in SI throughout the pipeline.
 * Peak sanity: 125 mph * 0.44704 ≈ 55.9 m/s peak speed; speed-derivative accel
 * at hard corner exit ~3–8 m/s² — within the expected 3–12 m/s² band.
 */

// === BEGIN sr-track inline ===

var SR_TRACK = (function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Default configuration (all live-tunable by passing a cfg override object).
  // ---------------------------------------------------------------------------
  var DEFAULT_CFG = {
    // Fusion weights
    BRAKE_FLOOR: 0.3,   // m/s²; g <= -BRAKE_FLOOR => pure brake half
    wS:          1.0,   // speed-supplement weight (accel half)
    wL:          0.15,  // lean-trend weight (accel half)

    // Fixed normalisation scales (NOT per-lap percentile — cross-lap consistent)
    B_SCALE: 8.0,       // m/s²; maps -B_SCALE -> score -1 (brake; sharper)

    // Accel normalisation is LEAN-GATED: the m/s² that maps to full green depends
    // on lean angle, because high-speed straight-line accel is gentle (~1.4 m/s²
    // near top speed) yet genuinely "on the gas", while a slight speed gain mid-
    // corner should stay yellow. Low lean (straight) -> small scale (sensitive,
    // gentle accel reads green); high lean (corner) -> large scale (creep stays
    // yellow). Calibrated against lap 122060,5 real telemetry.
    A_SCALE_STRAIGHT: 1.5, // m/s² -> +1 when upright (lean ~0)
    A_SCALE_CORNER:   4.0, // m/s² -> +1 when fully leaned (>= LEAN_GATE)
    LEAN_GATE:        25,  // deg; lean at which the scale reaches A_SCALE_CORNER
    A_SCALE: 4.0,       // legacy: fallback scale (e.g. col4-dead path normalisation)

    // Signal smoothing (centered MA window widths, in samples)
    speedSmoothWin: 5,
    col4SmoothWin:  3,
    leanSmoothWin:  5,
    diffSpan:       3,  // central-difference half-span (samples) for aSpd & leanTrend
    aSpdClamp:      25, // m/s²; outlier clamp on speed-derivative

    // Output
    scoreSmoothWin: 3,
    // Asymmetric slew (max |Δscore| per sample). Braking onset is sharp and must
    // show red fast, so downward steps are large; acceleration builds gradually,
    // so upward steps stay gentle (keeps the gradient smooth, no green bleeding
    // past the speed peak into the brake zone).
    slewUp:         0.15, // toward accel/green (gentle)
    slewDown:       0.6,  // toward brake/red (snappy)
    slew:           0.15, // legacy alias (unused; kept for back-compat references)
    LEVELS:         11,   // quantisation bands
    MIN_RUN:        4,    // absorb colour runs < 4 samples (0.4 s)

    // Validity thresholds
    col4DeadFrac:  0.70, // fraction of |col4|<0.05 => col4 considered dead
    leanSatFrac:   0.85, // fraction at saturation => lean considered dead
    leanSatDeg:    40,   // degrees; GPS lean saturates at ±40

    // Speed unit conversion (mph base → m/s)
    MPH_TO_MS: 0.44704,

    // Fixed timestep (seconds per sample)
    DT: 0.1,

    // Lean-trend reference scale (°/s); values above this count as full unwinding
    LEAN_DREF: 60,

    // T3 — braking-onset Schmitt trigger thresholds (score units, [-1..+1])
    // T6 CALIBRATION (against compare-122145-3-63254-5.json, Brno GP, 2 riders):
    // -0.35 missed every GENTLE brake application (real col4 dips of -2 to -2.6 m/s²,
    // e.g. a light dab into a fast corner) because those corners never pushed the
    // fused score past -0.35. Loosened to -0.12 so light dabs register; verified
    // against raw col4/speed that every newly-captured onset is a real deceleration,
    // not smoothing noise (see T6 report). Onset counts stay plausible (13/14 vs the
    // old 9/14) and every onset run is still >= ONSET_MIN_SAMPLES.
    BRAKE_ONSET_ENTER: -0.12, // score must drop below this to ENTER braking
    // EXIT must stay numerically > ENTER (shallower) for hysteresis; -0.10 keeps a
    // tight 0.02 gap now that ENTER itself sits close to zero.
    BRAKE_ONSET_EXIT:  -0.10, // score must rise above this to EXIT braking (hysteresis)
    ONSET_MIN_SAMPLES:  4,    // min consecutive braking samples (0.4 s) to accept an onset
    ONSET_MIN_DIST:     40,   // metres; min normalized-track-distance gap between accepted onsets

    // T4 — detectCorners: per-rider corner-span detection + cross-rider clustering
    CORNER_LEAN_SMOOTH_WIN:  4,    // centeredMA half-width (samples) for |lean| before thresholding
    CORNER_LEAN_FRAC:        0.6,  // corner span = smoothed |lean| > FRAC * that rider's own lean max
    CORNER_LEAN_MIN_SAMPLES: 3,    // min consecutive samples above threshold to keep a span
    CORNER_GAP_MERGE:        5,    // merge two spans separated by <= this many below-threshold samples
    CORNER_MATCH_WINDOW:     40,   // metres; hard window for cross-rider distance clustering
    // Lean-dead fallback: corners = local minima of smoothed speed
    CORNER_SPEED_SMOOTH_WIN: 5,    // centeredMA half-width (samples) for speed before minima search
    CORNER_SPEED_PROM_FRAC:  0.08, // minima must dip >= this fraction of that rider's own speed
                                    // range (vmax - vmin) below both shoulders to count as a corner
    CORNER_SPEED_MIN_SEP:    10,   // min sample separation between accepted speed-minima corners

    // T5 — buildCompareEvents: matching a rider's braking onset to a corner
    // The brake point is upstream of the apex/corner-cluster distance, so the
    // search window looks BACKWARD from the corner dist by up to this many
    // metres (and forward by a small slack, in case clustering/apex averaging
    // placed the corner's dist slightly before the true entry). Wider than
    // CORNER_MATCH_WINDOW (40) because braking zones for fast corners commonly
    // start well upstream of the apex cluster point.
    //
    // T6 CALIBRATION: 120 left 11/13 corners on the real fixture with NO
    // matched onset for at least one rider, because a single onset commonly
    // covers a long continuous braking zone into one apex of a corner combo
    // (observed onset-to-apex spans up to ~310m on this track). Widened to 370
    // — verified by brute-force search that 370 is comfortably inside the
    // plateau (340-420+) that yields ALL 13 corners matched with ZERO onsets
    // reused across two different corners (reuse would silently produce a
    // bogus "braked N m later" for the second corner sharing someone else's
    // brake point — checked and rejected at intermediate window sizes, see T6
    // report). Do not shrink this back toward CORNER_MATCH_WINDOW's scale
    // without re-running that reuse check on real data.
    DELTA_MATCH_WINDOW:      370,  // metres; max backward search distance from corner dist to onset dist
    DELTA_MATCH_FORWARD:     15,   // metres; small forward slack past the corner dist
  };

  // Merge caller overrides onto a copy of the defaults.
  function makeCfg(override) {
    var cfg = {};
    var k;
    for (k in DEFAULT_CFG) { if (Object.prototype.hasOwnProperty.call(DEFAULT_CFG, k)) cfg[k] = DEFAULT_CFG[k]; }
    if (override) {
      for (k in override) { if (Object.prototype.hasOwnProperty.call(override, k)) cfg[k] = override[k]; }
    }
    return cfg;
  }

  // ---------------------------------------------------------------------------
  // Internal numeric helpers
  // ---------------------------------------------------------------------------
  function clamp(x, lo, hi) { return x < lo ? lo : x > hi ? hi : x; }

  function isFiniteNum(x) { return typeof x === 'number' && isFinite(x); }

  /** Variance of a numeric array (population). Returns 0 on empty/single-element. */
  function variance(arr) {
    var n = arr.length;
    if (n < 2) return 0;
    var sum = 0, i;
    for (i = 0; i < n; i++) sum += arr[i];
    var mean = sum / n;
    var sq = 0;
    for (i = 0; i < n; i++) sq += (arr[i] - mean) * (arr[i] - mean);
    return sq / n;
  }

  /**
   * Centered moving average. Edge samples use the largest available symmetric window.
   * Falls back gracefully for n<2 (returns a copy).
   * @param {number[]} arr
   * @param {number}   win  half-width on each side (total window = 2*win+1)
   * @returns {number[]}
   */
  function centeredMA(arr, win) {
    var n = arr.length;
    var out = new Array(n);
    var i, j, lo, hi, sum, cnt;
    for (i = 0; i < n; i++) {
      lo = Math.max(0, i - win);
      hi = Math.min(n - 1, i + win);
      sum = 0; cnt = 0;
      for (j = lo; j <= hi; j++) {
        if (isFiniteNum(arr[j])) { sum += arr[j]; cnt++; }
      }
      out[i] = cnt > 0 ? sum / cnt : 0;
    }
    return out;
  }

  /**
   * Central finite difference with variable half-span.
   * At index i uses span = min(diffSpan, i, n-1-i) so edges never access out-of-bounds.
   * Returns derivative in units of arr_units / s.
   * @param {number[]} arr   smoothed signal
   * @param {number}   span  desired half-span (samples)
   * @param {number}   dt    seconds per sample
   * @returns {number[]}
   */
  function centralDiff(arr, span, dt) {
    var n = arr.length;
    var out = new Array(n);
    var i, s;
    for (i = 0; i < n; i++) {
      s = Math.min(span, i, n - 1 - i);
      if (s === 0) {
        // single-sided where possible
        if (i === 0 && n > 1)      out[i] = (arr[1] - arr[0]) / dt;
        else if (i === n - 1 && n > 1) out[i] = (arr[n - 1] - arr[n - 2]) / dt;
        else                        out[i] = 0;
      } else {
        out[i] = (arr[i + s] - arr[i - s]) / (2 * s * dt);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // T2 — validity(col4Arr, speedMphArr, leanArr, cfg) -> {useG,useS,useL}|{bail:true}
  // ---------------------------------------------------------------------------
  /**
   * Assess per-channel usability for a full lap's worth of arrays.
   *
   * @param {number[]} col4Arr      longitudinal accel (m/s²), from riders[i].data col 4
   * @param {number[]} speedMphArr  speed in mph BASE unit (col 2), per CLAUDE.md
   * @param {number[]} leanArr      lean angle (°), col 5; saturates at ±40
   * @param {object}  [cfgOverride] optional cfg overrides
   * @returns {{useG:boolean,useS:boolean,useL:boolean}|{bail:boolean}}
   *   bail:true only when BOTH col4 and speed are unusable.
   */
  function validity(col4Arr, speedMphArr, leanArr, cfgOverride) {
    // Backward-compat scalar path (old stub used validity(scalar[, deadband])).
    // If first arg is a plain number the caller is using the old scalar API.
    if (typeof col4Arr === 'number') {
      return _validityScalar(col4Arr, speedMphArr /* deadband */);
    }

    var cfg = makeCfg(cfgOverride);
    var n = Array.isArray(col4Arr) ? col4Arr.length : 0;

    // Assess col4 (g-sensor)
    var useG = true;
    if (n < 2) {
      useG = false;
    } else {
      var deadCount = 0, i;
      for (i = 0; i < n; i++) {
        if (!isFiniteNum(col4Arr[i]) || Math.abs(col4Arr[i]) < 0.05) deadCount++;
      }
      if (deadCount / n > cfg.col4DeadFrac) useG = false;
      if (useG && variance(col4Arr) < 1e-6) useG = false;
    }

    // Assess speed
    var useS = true;
    var sn = Array.isArray(speedMphArr) ? speedMphArr.length : 0;
    if (sn < 2) {
      useS = false;
    } else {
      var allNaN = true, j;
      for (j = 0; j < sn; j++) { if (isFiniteNum(speedMphArr[j])) { allNaN = false; break; } }
      if (allNaN) useS = false;
      if (useS && variance(speedMphArr) < 1e-9) useS = false;
    }

    // Bail if BOTH sensors are dead
    if (!useG && !useS) return { bail: true };

    // Assess lean
    var useL = true;
    var ln = Array.isArray(leanArr) ? leanArr.length : 0;
    if (ln < 2) {
      useL = false;
    } else {
      var satCount = 0, k;
      var satThresh = cfg.leanSatDeg * 0.99;
      for (k = 0; k < ln; k++) {
        if (!isFiniteNum(leanArr[k]) || Math.abs(leanArr[k]) >= satThresh) satCount++;
      }
      if (satCount / ln > cfg.leanSatFrac) useL = false;
      if (useL && variance(leanArr) < 1e-6) useL = false;
    }

    return { useG: useG, useS: useS, useL: useL };
  }

  /** Old scalar-based classification (kept for backward compat with T0 tests). */
  function _validityScalar(accel, deadband) {
    if (deadband === undefined || typeof deadband !== 'number') deadband = 0.5;
    if (accel > deadband) return 'accel';
    if (accel < -deadband) return 'brake';
    return 'steady';
  }

  // ---------------------------------------------------------------------------
  // T3 — internal signal pipeline
  // ---------------------------------------------------------------------------
  /**
   * Build all smoothed signals needed by computeScore.
   * @returns {{ g, vs, aSpd, leanSmooth, dLean }}
   */
  function _buildSignals(col4Arr, speedMphArr, leanArr, cfg) {
    var n = col4Arr.length;
    var i;

    // col4 smoothed (m/s²; already SI)
    var g = centeredMA(col4Arr, Math.floor(cfg.col4SmoothWin / 2));

    // Speed: mph → m/s, then smooth
    var v_ms = new Array(n);
    for (i = 0; i < n; i++) {
      v_ms[i] = isFiniteNum(speedMphArr[i]) ? speedMphArr[i] * cfg.MPH_TO_MS : 0;
    }
    var vs = centeredMA(v_ms, Math.floor(cfg.speedSmoothWin / 2));

    // Speed-derivative accel (m/s²), clamped
    var aSpd = centralDiff(vs, cfg.diffSpan, cfg.DT);
    for (i = 0; i < n; i++) {
      aSpd[i] = clamp(aSpd[i], -cfg.aSpdClamp, cfg.aSpdClamp);
    }

    // Lean: smooth |lean| then differentiate for trend
    var leanAbs = new Array(n);
    for (i = 0; i < n; i++) {
      leanAbs[i] = isFiniteNum(leanArr[i]) ? Math.abs(leanArr[i]) : 0;
    }
    var leanSmooth = centeredMA(leanAbs, Math.floor(cfg.leanSmoothWin / 2));
    var dLean = centralDiff(leanSmooth, cfg.diffSpan, cfg.DT); // °/s; negative = unwinding

    return { g: g, vs: vs, aSpd: aSpd, leanSmooth: leanSmooth, dLean: dLean };
  }

  // ---------------------------------------------------------------------------
  // T4 — computeScore(col4Arr, speedMphArr, leanArr, valid, cfg) -> score[]
  // ---------------------------------------------------------------------------
  /**
   * Compute a fused longitudinal score in [-1..+1] for each sample.
   *
   * Positive = accelerating, negative = braking, zero = coasting/neutral.
   *
   * Backward compat: if first arg is a number, falls back to old scalar path.
   *
   * @param {number[]} col4Arr     longitudinal accel m/s²
   * @param {number[]} speedMphArr speed in mph base unit (col2 per CLAUDE.md)
   * @param {number[]} leanArr     lean angle °
   * @param {{useG,useS,useL}|null} valid  from validity(); null = use all channels
   * @param {object}  [cfgOverride]
   * @returns {number[]}  score[] in [-1..+1], same length as col4Arr
   */
  function computeScore(col4Arr, speedMphArr, leanArr, valid, cfgOverride) {
    // Backward-compat scalar path
    if (typeof col4Arr === 'number') {
      return _computeScoreScalar(col4Arr, speedMphArr /* deadband */);
    }

    var cfg = makeCfg(cfgOverride);
    var n = Array.isArray(col4Arr) ? col4Arr.length : 0;
    if (n === 0) return [];

    // Default valid: trust all channels
    var useG = true, useS = true, useL = true;
    if (valid && !valid.bail) {
      useG = valid.useG !== false;
      useS = valid.useS !== false;
      useL = valid.useL !== false;
    }

    var sig = _buildSignals(col4Arr, speedMphArr, leanArr, cfg);
    var g    = sig.g;
    var aSpd = sig.aSpd;
    var dLean = sig.dLean;

    var leanSmooth = sig.leanSmooth;

    // Normalisation helpers
    function normB(x) { return clamp(x / cfg.B_SCALE, -1, 0); } // x expected negative
    // Lean-gated accel scale: sensitive upright, insensitive when leaned over.
    function aScaleFor(leanMag) {
      var t = clamp(leanMag / cfg.LEAN_GATE, 0, 1);
      return cfg.A_SCALE_STRAIGHT + (cfg.A_SCALE_CORNER - cfg.A_SCALE_STRAIGHT) * t;
    }

    var raw = new Array(n);
    var i, base, supp, leanContrib;

    for (i = 0; i < n; i++) {
      var gi = useG ? g[i] : 0;
      var aSi = useS ? aSpd[i] : 0;
      // -dLean: negative dLean (lean decreasing = unwinding corner = accel evidence)
      leanContrib = useL ? clamp(-dLean[i] / cfg.LEAN_DREF, 0, 1) : 0;
      // Lean magnitude gates accel sensitivity. No lean channel -> treat as upright.
      var aEff = aScaleFor(useL ? leanSmooth[i] : 0);

      if (!useG) {
        // col4 dead: speed-derived channel carries full range (including braking via neg aSpd)
        var rawS = cfg.wS * clamp(aSi / aEff, -1, 1) + cfg.wL * leanContrib;
        raw[i] = clamp(rawS, -1, 1);
      } else if (gi <= -cfg.BRAKE_FLOOR) {
        // Pure brake half: normB(gi) in [-1, 0]. Speed/lean do NOT pull toward accel.
        raw[i] = normB(gi);
      } else {
        // Accel/coast half — lean-gated so gentle straight-line accel reads green
        // while a slight speed gain mid-corner stays yellow.
        base = clamp(Math.max(gi, 0) / aEff, 0, 1);
        supp = cfg.wS * clamp(aSi / aEff, 0, 1) + cfg.wL * leanContrib;
        // Supplement can only RAISE, not lower; score = max(base, supp)
        raw[i] = Math.max(base, supp);
      }
    }

    // Output smoothing
    var smoothed = centeredMA(raw, Math.floor(cfg.scoreSmoothWin / 2));

    // Asymmetric slew-rate limiting: snappy toward brake, gentle toward accel.
    var slewUp = cfg.slewUp != null ? cfg.slewUp : cfg.slew;
    var slewDown = cfg.slewDown != null ? cfg.slewDown : cfg.slew;
    var out = new Array(n);
    out[0] = smoothed[0];
    for (i = 1; i < n; i++) {
      var delta = smoothed[i] - out[i - 1];
      if (delta > slewUp) delta = slewUp;
      else if (delta < -slewDown) delta = -slewDown;
      out[i] = out[i - 1] + delta;
    }

    return out;
  }

  /** Old scalar path preserved for T0 backward-compat tests. */
  function _computeScoreScalar(accel, deadband) {
    if (deadband === undefined || typeof deadband !== 'number') deadband = 0.5;
    var abs = accel < 0 ? -accel : accel;
    var beyond = abs - deadband;
    if (beyond <= 0) return 0;
    var maxBeyond = 14.7 - deadband;
    var score = beyond / maxBeyond;
    return score > 1 ? 1 : score;
  }

  // ---------------------------------------------------------------------------
  // T3 — great-circle bearing helper
  // ---------------------------------------------------------------------------
  /**
   * Great-circle initial bearing from (lat1,lng1) to (lat2,lng2), in degrees
   * [0, 360). Standard forward-azimuth formula; degenerate (identical) points
   * return 0 rather than NaN.
   * @returns {number}
   */
  function bearing(lat1, lng1, lat2, lng2) {
    if (!isFiniteNum(lat1) || !isFiniteNum(lng1) || !isFiniteNum(lat2) || !isFiniteNum(lng2)) return 0;
    if (lat1 === lat2 && lng1 === lng2) return 0;
    var toRad = Math.PI / 180;
    var phi1 = lat1 * toRad, phi2 = lat2 * toRad;
    var dLambda = (lng2 - lng1) * toRad;
    var y = Math.sin(dLambda) * Math.cos(phi2);
    var x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
    var theta = Math.atan2(y, x);
    var deg = theta * 180 / Math.PI;
    return (deg + 360) % 360;
  }

  // ---------------------------------------------------------------------------
  // T3 — detectBrakingOnsets(riderData, cfg) -> [{idx,lat,lng,dist,heading,minSpeed,severity}]
  // ---------------------------------------------------------------------------
  /**
   * Detect braking-zone onsets from one rider's raw data rows.
   *
   * Reuses computeScore (fused g+speed score, [-1..+1], negative = braking) —
   * this is NOT a second classifier, just a Schmitt-trigger + debounce layered
   * on top of the existing score.
   *
   * @param {Array<Array<number>>} riderData  rows [lat,lng,speedMph,cumDist,longAccel,lean]
   * @param {object} [cfgOverride]
   * @returns {Array<{idx:number, lat:number, lng:number, dist:number, heading:number,
   *                   minSpeed:number, severity:number}>}
   */
  function detectBrakingOnsets(riderData, cfgOverride) {
    var cfg = makeCfg(cfgOverride);
    var n = Array.isArray(riderData) ? riderData.length : 0;
    if (n < 2) return [];

    var i, row;
    var lat = new Array(n), lng = new Array(n), speedMph = new Array(n);
    var distRaw = new Array(n), col4 = new Array(n), leanArr = new Array(n);
    for (i = 0; i < n; i++) {
      row = riderData[i] || [];
      lat[i]      = isFiniteNum(row[0]) ? row[0] : 0;
      lng[i]      = isFiniteNum(row[1]) ? row[1] : 0;
      speedMph[i] = isFiniteNum(row[2]) ? row[2] : 0;
      distRaw[i]  = isFiniteNum(row[3]) ? row[3] : 0;
      col4[i]     = isFiniteNum(row[4]) ? row[4] : 0;
      leanArr[i]  = isFiniteNum(row[5]) ? row[5] : 0;
    }

    // Normalize distance so it starts at 0 (per CLAUDE.md: p[3] - data[0][3]).
    var dist0 = distRaw[0];
    var dist = new Array(n);
    for (i = 0; i < n; i++) dist[i] = distRaw[i] - dist0;

    var valid = validity(col4, speedMph, leanArr, cfg);
    if (valid.bail) return [];

    var score = computeScore(col4, speedMph, leanArr, valid, cfg);
    if (!score || score.length === 0) return [];

    var onsets = [];
    var braking = false;
    var runStart = -1;
    var lastAcceptedDist = null;

    for (i = 0; i < n; i++) {
      var s = isFiniteNum(score[i]) ? score[i] : 0;
      if (!braking) {
        if (s < cfg.BRAKE_ONSET_ENTER) {
          braking = true;
          runStart = i;
        }
      } else {
        if (s > cfg.BRAKE_ONSET_EXIT) {
          braking = false;
          _acceptOnset(runStart, i);
          runStart = -1;
        }
      }
    }
    // Lap ends while still braking — close out the run at end-of-data (exclusive).
    if (braking && runStart >= 0) {
      _acceptOnset(runStart, n);
    }

    function _acceptOnset(startIdx, exitIdxExclusive) {
      var runLen = exitIdxExclusive - startIdx; // samples spent braking before exit
      if (runLen < cfg.ONSET_MIN_SAMPLES) return;

      var d = dist[startIdx];
      if (lastAcceptedDist !== null && (d - lastAcceptedDist) < cfg.ONSET_MIN_DIST) return;

      var prevIdx = startIdx > 0 ? startIdx - 1 : startIdx;
      var nextIdx = startIdx < n - 1 ? startIdx + 1 : startIdx;
      var heading = bearing(lat[prevIdx], lng[prevIdx], lat[nextIdx], lng[nextIdx]);

      // minSpeed: minimum speed from startIdx until back on the gas
      // (score crosses back above ~0), the run's own exit, or end of data.
      var minSpeed = speedMph[startIdx];
      var peakAbsScore = Math.abs(score[startIdx]);
      var j;
      for (j = startIdx; j < n; j++) {
        var sj = isFiniteNum(score[j]) ? score[j] : 0;
        if (j > startIdx && sj > 0) break; // back on the gas
        if (speedMph[j] < minSpeed) minSpeed = speedMph[j];
        var absSj = Math.abs(sj);
        if (absSj > peakAbsScore) peakAbsScore = absSj;
      }

      onsets.push({
        idx: startIdx,
        lat: lat[startIdx],
        lng: lng[startIdx],
        dist: d,
        heading: heading,
        minSpeed: minSpeed,
        severity: peakAbsScore,
      });
      lastAcceptedDist = d;
    }

    return onsets;
  }

  // ---------------------------------------------------------------------------
  // T4 — detectCorners(riders, cfg) -> clustered corners across riders
  // ---------------------------------------------------------------------------
  /**
   * Extract typed, normalised rows from one rider's raw riderData for the
   * corner detector (same column layout as detectBrakingOnsets).
   * @returns {{lat,lng,speedMph,dist,col4,lean}} parallel arrays, dist normalised to start at 0
   */
  function _extractRiderArrays(riderData) {
    var n = Array.isArray(riderData) ? riderData.length : 0;
    var lat = new Array(n), lng = new Array(n), speedMph = new Array(n);
    var distRaw = new Array(n), col4 = new Array(n), leanArr = new Array(n);
    var i, row;
    for (i = 0; i < n; i++) {
      row = riderData[i] || [];
      lat[i]      = isFiniteNum(row[0]) ? row[0] : 0;
      lng[i]      = isFiniteNum(row[1]) ? row[1] : 0;
      speedMph[i] = isFiniteNum(row[2]) ? row[2] : 0;
      distRaw[i]  = isFiniteNum(row[3]) ? row[3] : 0;
      col4[i]     = isFiniteNum(row[4]) ? row[4] : 0;
      leanArr[i]  = isFiniteNum(row[5]) ? row[5] : 0;
    }
    var dist0 = n > 0 ? distRaw[0] : 0;
    var dist = new Array(n);
    for (i = 0; i < n; i++) dist[i] = distRaw[i] - dist0;
    return { lat: lat, lng: lng, speedMph: speedMph, dist: dist, col4: col4, lean: leanArr };
  }

  /**
   * Per-rider corner spans from a RELATIVE lean threshold.
   *
   * Why relative, not absolute: lean angle is a GPS-derived per-lap estimate
   * whose scale is NOT consistent across riders (verified: one rider's |lean|
   * maxes at ~46deg, another's at ~28deg on the same track/corners). An
   * absolute threshold (e.g. 35deg) would silently produce zero corners for
   * the low-scale rider. Thresholding at CORNER_LEAN_FRAC * that rider's own
   * max |lean| makes the detector self-calibrating per rider.
   *
   * We use the rider's own MAX (not a percentile) as the reference: the max
   * is exactly the value CLAUDE.md documents as varying rider-to-rider, so
   * anchoring to it is the most direct way to cancel out that per-rider scale
   * difference. A percentile would also work but adds a knob with no evidence
   * it generalises better than the max on this data.
   *
   * @returns {Array<{entryDist,exitDist,apexIdx,minSpeed,apexLat,apexLng}>}
   */
  function _leanCornerSpans(arrays, cfg) {
    var n = arrays.lat.length;
    if (n < 2) return [];

    var leanAbs = new Array(n), i;
    for (i = 0; i < n; i++) leanAbs[i] = Math.abs(arrays.lean[i]);
    var smooth = centeredMA(leanAbs, Math.floor(cfg.CORNER_LEAN_SMOOTH_WIN / 2));

    var maxLean = 0;
    for (i = 0; i < n; i++) { if (smooth[i] > maxLean) maxLean = smooth[i]; }
    if (maxLean <= 0) return [];

    var threshold = cfg.CORNER_LEAN_FRAC * maxLean;

    return _spansFromMask(_thresholdMask(smooth, threshold, n), arrays, cfg);
  }

  /** Boolean mask: true where val > threshold. */
  function _thresholdMask(arr, threshold, n) {
    var mask = new Array(n);
    for (var i = 0; i < n; i++) mask[i] = arr[i] > threshold;
    return mask;
  }

  /**
   * Turn a boolean "in corner" mask into merged spans with entry/exit/apex.
   * Small gaps (<= CORNER_GAP_MERGE below-threshold samples) are bridged so a
   * single corner isn't split by one noisy sample; spans shorter than
   * CORNER_LEAN_MIN_SAMPLES are discarded as noise.
   */
  function _spansFromMask(mask, arrays, cfg) {
    var n = mask.length;
    var raw = [];
    var i, start = -1;
    for (i = 0; i < n; i++) {
      if (mask[i] && start < 0) {
        start = i;
      } else if (!mask[i] && start >= 0) {
        raw.push([start, i - 1]);
        start = -1;
      }
    }
    if (start >= 0) raw.push([start, n - 1]);
    if (raw.length === 0) return [];

    // Bridge small gaps between consecutive runs.
    var merged = [raw[0].slice()];
    for (i = 1; i < raw.length; i++) {
      var prev = merged[merged.length - 1];
      var gap = raw[i][0] - prev[1] - 1;
      if (gap <= cfg.CORNER_GAP_MERGE) {
        prev[1] = raw[i][1];
      } else {
        merged.push(raw[i].slice());
      }
    }

    var spans = [];
    for (i = 0; i < merged.length; i++) {
      var s = merged[i][0], e = merged[i][1];
      if (e - s + 1 < cfg.CORNER_LEAN_MIN_SAMPLES) continue;

      var apexIdx = s, minSpeed = arrays.speedMph[s];
      for (var j = s; j <= e; j++) {
        if (arrays.speedMph[j] < minSpeed) { minSpeed = arrays.speedMph[j]; apexIdx = j; }
      }

      spans.push({
        entryDist: arrays.dist[s],
        exitDist:  arrays.dist[e],
        apexIdx:   apexIdx,
        minSpeed:  minSpeed,
        apexLat:   arrays.lat[apexIdx],
        apexLng:   arrays.lng[apexIdx],
      });
    }
    return spans;
  }

  /**
   * Lean-dead fallback: corners = local minima of centeredMA-smoothed speed,
   * each required to dip at least CORNER_SPEED_PROM_FRAC * (that rider's own
   * speed range) below the higher of its two neighbouring local shoulders
   * (simple prominence proxy — no full topographic-prominence algorithm
   * needed at this sample rate/noise level), and separated by at least
   * CORNER_SPEED_MIN_SEP samples from any previously accepted minimum.
   *
   * @returns {Array<{entryDist,exitDist,apexIdx,minSpeed,apexLat,apexLng}>}
   */
  function _speedMinimaCornerSpans(arrays, cfg) {
    var n = arrays.lat.length;
    if (n < 3) return [];

    var smooth = centeredMA(arrays.speedMph, Math.floor(cfg.CORNER_SPEED_SMOOTH_WIN / 2));

    var vmax = smooth[0], vmin = smooth[0], i;
    for (i = 1; i < n; i++) {
      if (smooth[i] > vmax) vmax = smooth[i];
      if (smooth[i] < vmin) vmin = smooth[i];
    }
    var range = vmax - vmin;
    if (range <= 0) return [];
    var minProminence = cfg.CORNER_SPEED_PROM_FRAC * range;

    // Candidate local minima: smooth[i] <= both neighbours (plateau-tolerant).
    var candidates = [];
    for (i = 1; i < n - 1; i++) {
      if (smooth[i] <= smooth[i - 1] && smooth[i] <= smooth[i + 1] &&
          (smooth[i] < smooth[i - 1] || smooth[i] < smooth[i + 1])) {
        candidates.push(i);
      }
    }

    // Prominence: walk outward from the candidate to the nearest higher point
    // on each side (or the array edge) and take the smaller of the two rises.
    function prominenceOf(idx) {
      var leftMax = smooth[idx];
      for (var l = idx - 1; l >= 0; l--) {
        if (smooth[l] > leftMax) leftMax = smooth[l];
        if (smooth[l] > smooth[idx] + minProminence) break;
      }
      var rightMax = smooth[idx];
      for (var r = idx + 1; r < n; r++) {
        if (smooth[r] > rightMax) rightMax = smooth[r];
        if (smooth[r] > smooth[idx] + minProminence) break;
      }
      return Math.min(leftMax, rightMax) - smooth[idx];
    }

    var accepted = [];
    var lastIdx = -Infinity;
    for (i = 0; i < candidates.length; i++) {
      var idx = candidates[i];
      if (idx - lastIdx < cfg.CORNER_SPEED_MIN_SEP) {
        // Too close to the previous accepted minimum: keep whichever is deeper.
        if (accepted.length > 0 && smooth[idx] < smooth[accepted[accepted.length - 1]]) {
          accepted[accepted.length - 1] = idx;
          lastIdx = idx;
        }
        continue;
      }
      if (prominenceOf(idx) >= minProminence) {
        accepted.push(idx);
        lastIdx = idx;
      }
    }

    var spans = [];
    for (i = 0; i < accepted.length; i++) {
      var apexIdx = accepted[i];
      spans.push({
        entryDist: arrays.dist[apexIdx],
        exitDist:  arrays.dist[apexIdx],
        apexIdx:   apexIdx,
        minSpeed:  arrays.speedMph[apexIdx],
        apexLat:   arrays.lat[apexIdx],
        apexLng:   arrays.lng[apexIdx],
      });
    }
    return spans;
  }

  /**
   * Detect one rider's corner spans, choosing lean-relative or speed-minima
   * fallback per the rider's own validity() lean-usability flag (useL).
   * @returns {Array<{entryDist,exitDist,apexIdx,minSpeed,apexLat,apexLng}>}
   */
  function _riderCornerSpans(riderData, cfg) {
    var arrays = _extractRiderArrays(riderData);
    var n = arrays.lat.length;
    if (n < 2) return [];

    var valid = validity(arrays.col4, arrays.speedMph, arrays.lean, cfg);
    var useL = !valid.bail && valid.useL !== false;

    return useL ? _leanCornerSpans(arrays, cfg) : _speedMinimaCornerSpans(arrays, cfg);
  }

  /**
   * Cross-rider clustering of corner spans by normalised track distance.
   *
   * ORDER-INDEPENDENCE: every span from every rider is first flattened into
   * one flat list tagged with its riderIndex, then that flat list is SORTED
   * by apex distance and walked once, chain-merging any span within
   * CORNER_MATCH_WINDOW of the running cluster's last-added distance. Because
   * the sort key is the span's own distance (not its rider's position in the
   * input array) and clustering only consults that distance ordering,
   * swapping the order of the `riders` array only changes each span's
   * riderIndex tag — it can never change which spans land in the same sorted
   * neighbourhood or which clusters form. This is deliberately NOT "detect on
   * riders[0] then match everyone else against it," which would privilege
   * rider 0's spans as the reference grid.
   *
   * PHANTOM REJECTION: after clustering, when more than one rider was
   * supplied, any cluster containing spans from only a single rider is
   * dropped — a corner only one rider actually took (no other rider slowed
   * down anywhere nearby) is not treated as a real track corner. With exactly
   * one rider supplied there is nothing to corroborate against, so every
   * cluster is kept.
   *
   * @param {Array<Array<object>>} perRiderSpans  perRiderSpans[riderIndex] = spans[]
   * @param {number} riderCount
   * @param {object} cfg
   * @returns {Array<{dist:number, perRider: Array<object|null>}>} sorted by dist
   */
  function _clusterCornerSpans(perRiderSpans, riderCount, cfg) {
    var flat = [];
    var r, s;
    for (r = 0; r < perRiderSpans.length; r++) {
      for (s = 0; s < perRiderSpans[r].length; s++) {
        var span = perRiderSpans[r][s];
        var apexDist = isFiniteNum(span.entryDist) && isFiniteNum(span.exitDist)
          ? (span.entryDist + span.exitDist) / 2
          : span.entryDist;
        flat.push({ riderIndex: r, span: span, apexDist: apexDist });
      }
    }
    if (flat.length === 0) return [];

    flat.sort(function (a, b) { return a.apexDist - b.apexDist; });

    var clusters = [];
    var current = null;
    for (var i = 0; i < flat.length; i++) {
      var item = flat[i];
      if (current !== null && (item.apexDist - current.lastDist) <= cfg.CORNER_MATCH_WINDOW) {
        current.items.push(item);
        current.lastDist = item.apexDist;
      } else {
        current = { items: [item], lastDist: item.apexDist };
        clusters.push(current);
      }
    }

    var out = [];
    for (i = 0; i < clusters.length; i++) {
      var items = clusters[i].items;

      // Phantom rejection: with >1 rider supplied, a cluster must contain
      // spans from more than one distinct rider to count as a real corner.
      if (riderCount > 1) {
        var distinctRiders = {};
        var distinctCount = 0;
        for (var k = 0; k < items.length; k++) {
          if (!distinctRiders[items[k].riderIndex]) {
            distinctRiders[items[k].riderIndex] = true;
            distinctCount++;
          }
        }
        if (distinctCount < 2) continue;
      }

      var perRider = new Array(riderCount);
      for (var pr = 0; pr < riderCount; pr++) perRider[pr] = null;
      var sumDist = 0;
      for (k = 0; k < items.length; k++) {
        var it = items[k];
        // If a rider has multiple spans in the same cluster window, keep the
        // deepest (lowest minSpeed) as that rider's representative for this corner.
        if (perRider[it.riderIndex] === null || it.span.minSpeed < perRider[it.riderIndex].minSpeed) {
          perRider[it.riderIndex] = {
            riderIndex: it.riderIndex,
            minSpeed:   it.span.minSpeed,
            apexIdx:    it.span.apexIdx,
            apexLat:    it.span.apexLat,
            apexLng:    it.span.apexLng,
            entryDist:  it.span.entryDist,
          };
        }
        sumDist += it.apexDist;
      }

      out.push({ dist: sumDist / items.length, perRider: perRider });
    }

    out.sort(function (a, b) { return a.dist - b.dist; });
    return out;
  }

  /**
   * detectCorners(riders, cfg) — full pipeline: per-rider corner-span
   * detection (relative-lean primary, speed-minima fallback for lean-dead
   * riders) followed by order-independent cross-rider distance clustering
   * with phantom-span rejection.
   *
   * @param {Array<Array<Array<number>>>} riders  riders[i] = that rider's data rows
   * @param {object} [cfgOverride]
   * @returns {Array<{dist:number, perRider:Array<object|null>}>} sorted by dist
   */
  function detectCorners(riders, cfgOverride) {
    var cfg = makeCfg(cfgOverride);
    var list = Array.isArray(riders) ? riders : [];
    var riderCount = list.length;
    if (riderCount === 0) return [];

    var perRiderSpans = new Array(riderCount);
    for (var i = 0; i < riderCount; i++) {
      perRiderSpans[i] = _riderCornerSpans(list[i], cfg);
    }

    return _clusterCornerSpans(perRiderSpans, riderCount, cfg);
  }

  // ---------------------------------------------------------------------------
  // T5 — buildCompareEvents(riders, cfg) -> top-level compare-mode event model
  // ---------------------------------------------------------------------------
  /**
   * For one rider's braking onsets, find the onset that best corresponds to a
   * given corner distance: the CLOSEST onset whose dist falls in the window
   * [cornerDist - DELTA_MATCH_WINDOW, cornerDist + DELTA_MATCH_FORWARD].
   *
   * The brake point necessarily sits upstream (smaller dist) of the corner's
   * apex/cluster distance, so the window is asymmetric — a large backward
   * reach and a small forward slack (clustering/apex-averaging can place a
   * corner's representative dist a few metres before the true entry).
   *
   * @param {Array<{dist:number}>} riderOnsets  one rider's detectBrakingOnsets() output
   * @param {number} cornerDist
   * @param {object} cfg
   * @returns {{dist:number}|null}  the matched onset object, or null if none in window
   */
  function _matchOnsetToCorner(riderOnsets, cornerDist, cfg) {
    if (!Array.isArray(riderOnsets) || riderOnsets.length === 0) return null;
    if (!isFiniteNum(cornerDist)) return null;

    var lo = cornerDist - cfg.DELTA_MATCH_WINDOW;
    var hi = cornerDist + cfg.DELTA_MATCH_FORWARD;

    var best = null;
    var bestGap = Infinity;
    for (var i = 0; i < riderOnsets.length; i++) {
      var o = riderOnsets[i];
      if (!o || !isFiniteNum(o.dist)) continue;
      if (o.dist < lo || o.dist > hi) continue;
      // Closest to the corner dist wins (largest dist within the window that
      // is still <= cornerDist is "closest to the corner"; ties broken by
      // absolute gap, which favours the same onset either way).
      var gap = Math.abs(cornerDist - o.dist);
      if (gap < bestGap) {
        bestGap = gap;
        best = o;
      }
    }
    return best;
  }

  /**
   * Compute the "braked N m later" delta for one clustered corner, given each
   * present rider's matched brake-point distance.
   *
   * Reference = the rider with the SMALLEST matched brake-point dist (braked
   * earliest / furthest from the corner). Every other matched rider is
   * reported relative to that reference: metresLater = riderDist - refDist.
   * Only reference-vs-each comparisons are produced (not all pairwise
   * combinations) — this keeps the output renderable ("RIDER X braked N m
   * later than RIDER Y") for up to 4 riders instead of growing combinatorially.
   *
   * @param {Array<{riderIndex:number, brakePointDist:number|null}>} riderBrakePoints
   *   one entry per rider PRESENT at this corner (i.e. perRider[i] !== null),
   *   brakePointDist may still be null if that rider had no matched onset.
   * @returns {{referenceRider:number, entries:Array<{riderIndex:number, metresLater:number}>}|null}
   *   null when fewer than 2 riders have a non-null brakePointDist.
   */
  function _computeBrakeDelta(riderBrakePoints) {
    var matched = [];
    for (var i = 0; i < riderBrakePoints.length; i++) {
      var rbp = riderBrakePoints[i];
      if (rbp && isFiniteNum(rbp.brakePointDist)) matched.push(rbp);
    }
    if (matched.length < 2) return null;

    var reference = matched[0];
    for (i = 1; i < matched.length; i++) {
      if (matched[i].brakePointDist < reference.brakePointDist) reference = matched[i];
    }

    var entries = [];
    for (i = 0; i < matched.length; i++) {
      var m = matched[i];
      if (m === reference) continue;
      entries.push({
        riderIndex:  m.riderIndex,
        metresLater: m.brakePointDist - reference.brakePointDist,
      });
    }

    return { referenceRider: reference.riderIndex, entries: entries };
  }

  /**
   * buildCompareEvents(riders, cfg) — single top-level entry point the map
   * renderer calls to get a fully-composed compare-mode event model. Pure
   * composition over detectBrakingOnsets() (T3) and detectCorners() (T4); no
   * new detection logic is introduced here.
   *
   * Pipeline:
   *   1. Run detectBrakingOnsets() independently for each rider.
   *   2. Run detectCorners(riders, cfg) to get track-level clustered corners.
   *   3. For each clustered corner, for each rider PRESENT in that corner's
   *      perRider slot (perRider[i] !== null), find that rider's best-matching
   *      braking onset via _matchOnsetToCorner() (nearest onset dist upstream
   *      of, or slightly past, the corner dist — see DELTA_MATCH_WINDOW/
   *      DELTA_MATCH_FORWARD). A rider with no matching onset gets
   *      brakePointDist:null and is simply excluded from the delta — never throws.
   *   4. Compute a reference-vs-each brake-point delta (see _computeBrakeDelta):
   *      the earliest braker is the reference; every other matched rider is
   *      reported as "braked N m later" (metresLater = own dist - reference dist,
   *      always >= 0 by construction of "reference = earliest").
   *
   * RETURN SHAPE
   * ------------
   * {
   *   onsets: Array<Array<OnsetObj>>,
   *     // onsets[riderIndex] = that rider's raw detectBrakingOnsets() output,
   *     // i.e. Array<{idx,lat,lng,dist,heading,minSpeed,severity}> (see T3 doc).
   *
   *   corners: Array<{
   *     dist: number,                     // clustered corner distance (from detectCorners)
   *     perRider: Array<{                 // index-aligned with the `riders` input array
   *       riderIndex: number,
   *       minSpeed: number,               // mph BASE unit, from detectCorners' perRider entry
   *       apexLat: number,
   *       apexLng: number,
   *       entryDist: number,
   *       brakePointDist: number|null,    // matched onset's dist, or null if none matched
   *     } | null>,                        // null = rider not present at this corner (from T4)
   *     brakeDelta: {
   *       referenceRider: number,         // riderIndex of the earliest (reference) braker
   *       entries: Array<{riderIndex: number, metresLater: number}>,
   *                                       // one entry per OTHER matched rider; metresLater >= 0
   *     } | null,                         // null when <2 riders have a matched brake point here
   *   }>,                                 // sorted by dist (inherited from detectCorners)
   * }
   *
   * @param {Array<Array<Array<number>>>} riders  riders[i] = that rider's raw data rows
   * @param {object} [cfgOverride]
   * @returns {{onsets: Array<Array<object>>, corners: Array<object>}}
   */
  function buildCompareEvents(riders, cfgOverride) {
    var cfg = makeCfg(cfgOverride);
    var list = Array.isArray(riders) ? riders : [];
    var riderCount = list.length;

    var onsets = new Array(riderCount);
    for (var i = 0; i < riderCount; i++) {
      onsets[i] = detectBrakingOnsets(list[i], cfg);
    }

    var clusteredCorners = detectCorners(list, cfg);

    var corners = new Array(clusteredCorners.length);
    for (i = 0; i < clusteredCorners.length; i++) {
      var cluster = clusteredCorners[i];
      var perRider = new Array(cluster.perRider.length);
      var riderBrakePoints = new Array(cluster.perRider.length);

      for (var r = 0; r < cluster.perRider.length; r++) {
        var p = cluster.perRider[r];
        if (p === null) {
          perRider[r] = null;
          riderBrakePoints[r] = null;
          continue;
        }

        var matchedOnset = _matchOnsetToCorner(onsets[r] || [], cluster.dist, cfg);
        var brakePointDist = matchedOnset ? matchedOnset.dist : null;

        perRider[r] = {
          riderIndex:     p.riderIndex,
          minSpeed:       p.minSpeed,
          apexLat:        p.apexLat,
          apexLng:        p.apexLng,
          entryDist:      p.entryDist,
          brakePointDist: brakePointDist,
        };
        riderBrakePoints[r] = { riderIndex: p.riderIndex, brakePointDist: brakePointDist };
      }

      corners[i] = {
        dist:       cluster.dist,
        perRider:   perRider,
        brakeDelta: _computeBrakeDelta(riderBrakePoints),
      };
    }

    return { onsets: onsets, corners: corners };
  }

  // ---------------------------------------------------------------------------
  // T5 — quantize(scoreArr, cfg) -> band[]
  // ---------------------------------------------------------------------------
  /**
   * Quantise score[] into LEVELS integer bands.
   *
   * LEVELS=11 produces bands 0..10 with edges at -1, -0.8, -0.6, …, +0.8, +1.
   * Band index:  0 = hardest braking, 5 = neutral, 10 = hardest accel.
   *
   * Backward compat: if first arg is a plain number, uses old sentinel-value path.
   *
   * @param {number[]|number} scoreArr  score array in [-1..+1], or scalar (old API)
   * @param {object|number}  [cfg]      cfg override object, or deadband scalar (old API)
   * @returns {number[]|number}
   */
  function quantize(scoreArr, cfg) {
    // Backward-compat scalar path (old tests pass a scalar accel + optional deadband)
    if (typeof scoreArr === 'number') {
      return _quantizeScalar(scoreArr, cfg /* deadband */);
    }

    var c = makeCfg(typeof cfg === 'object' ? cfg : undefined);
    var n = Array.isArray(scoreArr) ? scoreArr.length : 0;
    if (n === 0) return [];

    var levels = c.LEVELS; // 11
    // Edges: levels+1 = 12 values from -1 to +1 inclusive
    var step = 2 / levels; // 2/11 ≈ 0.1818…
    var out = new Array(n);
    var i, band;
    for (i = 0; i < n; i++) {
      var s = clamp(scoreArr[i], -1, 1);
      // Map [-1, +1] to [0, LEVELS]; clamp top edge to LEVELS-1
      band = Math.floor((s + 1) / step);
      if (band >= levels) band = levels - 1;
      out[i] = band;
    }
    return out;
  }

  /** Returns the midpoint score for a band index (useful for colorising). */
  function bandMidpoint(band, levels) {
    if (levels === undefined) levels = DEFAULT_CFG.LEVELS;
    var step = 2 / levels;
    return -1 + (band + 0.5) * step;
  }

  /** Old scalar sentinel-value path from T0 stub (preserved for backward compat). */
  function _quantizeScalar(accel, deadband) {
    if (deadband === undefined || typeof deadband !== 'number') deadband = 0.5;
    var zone = _validityScalar(accel, deadband);
    if (zone === 'accel') return deadband;
    if (zone === 'brake') return -deadband;
    return 0;
  }

  // ---------------------------------------------------------------------------
  // T5 — scoreToColor(score, cfg) -> '#rrggbb'
  // ---------------------------------------------------------------------------
  /**
   * Map a numeric score in [-1..+1] to a colour via HSL interpolation.
   *
   * Designer spec anchors (HSL):
   *   brake:   #ff3b2f  hsl(4,   100%, 59%)
   *   neutral: #f5b800  hsl(46,  100%, 48%)
   *   accel:   #22d66e  hsl(147, 67%,  49%)
   *
   * Gamma bias 0.75 bends the gradient toward neutral so mid-scores don't
   * look fully saturated.
   *
   * Backward compat: if first arg is a string ('accel'|'steady'|'brake'), returns
   * the legacy flat colour so existing T0 tests continue to pass.
   *
   * @param {number|string} score   numeric in [-1..+1], or legacy string state
   * @param {object}       [cfg]   ignored (reserved for future override)
   * @returns {string}  '#rrggbb'
   */
  function scoreToColor(score, cfg) {
    // Legacy string path — keeps T0 tests green
    if (typeof score === 'string') {
      if (score === 'accel')  return '#37d67a';
      if (score === 'brake')  return '#ff5c52';
      return '#f0b429'; // steady / unknown
    }

    // Numeric HSL path
    // Anchors
    var BRAKE   = { h: 4,   s: 100, l: 59 };
    var NEUTRAL = { h: 46,  s: 100, l: 48 };
    var ACCEL   = { h: 147, s: 67,  l: 49 };

    var s = typeof score === 'number' && isFinite(score) ? clamp(score, -1, 1) : 0;
    var t = (s + 1) / 2; // [0, 1]; 0 = full brake, 0.5 = neutral, 1 = full accel

    // Gamma bias: pull mid-values toward neutral (0.5)
    var half = t - 0.5;
    var absHalf = half < 0 ? -half : half;
    var sign = half < 0 ? -1 : (half > 0 ? 1 : 0);
    var tb = sign * Math.pow(absHalf * 2, 0.75) / 2 + 0.5;

    var h, sl, ll, from, to, frac;
    if (tb <= 0.5) {
      // Brake → Neutral
      frac = tb / 0.5;          // [0, 1]; 0 = brake, 1 = neutral
      from = BRAKE; to = NEUTRAL;
    } else {
      // Neutral → Accel
      frac = (tb - 0.5) / 0.5;  // [0, 1]; 0 = neutral, 1 = accel
      from = NEUTRAL; to = ACCEL;
    }

    h  = from.h + (to.h  - from.h)  * frac;
    sl = from.s + (to.s  - from.s)  * frac;
    ll = from.l + (to.l  - from.l)  * frac;

    return _hslToHex(h, sl / 100, ll / 100);
  }

  /**
   * Return the display colour for a band index (maps band midpoint through scoreToColor).
   * @param {number} band   integer in [0, LEVELS-1]
   * @param {object} [cfg]
   * @returns {string} '#rrggbb'
   */
  function bandToColor(band, cfg) {
    var c = makeCfg(typeof cfg === 'object' ? cfg : undefined);
    return scoreToColor(bandMidpoint(band, c.LEVELS));
  }

  // ---------------------------------------------------------------------------
  // Internal: HSL → #rrggbb
  // Standard algorithm; h in [0,360), s and l in [0,1].
  // ---------------------------------------------------------------------------
  function _hslToHex(h, s, l) {
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var x = c * (1 - Math.abs((h / 60) % 2 - 1));
    var m = l - c / 2;
    var r, g, b;
    h = ((h % 360) + 360) % 360; // normalise
    if      (h <  60) { r = c; g = x; b = 0; }
    else if (h < 120) { r = x; g = c; b = 0; }
    else if (h < 180) { r = 0; g = c; b = x; }
    else if (h < 240) { r = 0; g = x; b = c; }
    else if (h < 300) { r = x; g = 0; b = c; }
    else              { r = c; g = 0; b = x; }
    function toHex(v) {
      var n = Math.round((v + m) * 255);
      n = n < 0 ? 0 : n > 255 ? 255 : n;
      return (n < 16 ? '0' : '') + n.toString(16);
    }
    return '#' + toHex(r) + toHex(g) + toHex(b);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  return {
    // Array-based pipeline (new)
    validity:            validity,
    computeScore:        computeScore,
    quantize:            quantize,
    scoreToColor:        scoreToColor,
    bandMidpoint:        bandMidpoint,
    bandToColor:         bandToColor,
    detectBrakingOnsets: detectBrakingOnsets,
    detectCorners:       detectCorners,
    buildCompareEvents:  buildCompareEvents,

    // Expose default config so callers can inspect or derive overrides
    DEFAULT_CFG:   DEFAULT_CFG,

    // Internal helpers exposed for unit testing
    _centeredMA:             centeredMA,
    _centralDiff:            centralDiff,
    _buildSignals:           _buildSignals,
    _hslToHex:               _hslToHex,
    _bearing:                bearing,
    _extractRiderArrays:     _extractRiderArrays,
    _leanCornerSpans:        _leanCornerSpans,
    _speedMinimaCornerSpans: _speedMinimaCornerSpans,
    _riderCornerSpans:       _riderCornerSpans,
    _clusterCornerSpans:     _clusterCornerSpans,
    _matchOnsetToCorner:     _matchOnsetToCorner,
    _computeBrakeDelta:      _computeBrakeDelta,
  };
}());

// === END sr-track inline ===

// Dual-export seam: works in Node (require) and in the browser (window) without error.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SR_TRACK;
} else {
  window.SR_TRACK = SR_TRACK;
}
