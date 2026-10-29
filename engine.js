// AttentionAI engine: landmarks -> eye closure, gaze, head pose -> attention state.
// Pure logic (no DOM) so it is easy to test. Results are ESTIMATES, not a validated measurement.

export const FOCUSED = "Focused", DISTRACTED = "Distracted", DROWSY = "Drowsy", NO_FACE = "No Face";
export const COLORS = { [FOCUSED]: "#22c55e", [DISTRACTED]: "#facc15", [DROWSY]: "#ef4444", [NO_FACE]: "#94a3b8" };
const SCORE_TARGET = { [FOCUSED]: 100, [DISTRACTED]: 35, [DROWSY]: 0 };

export const R_EYE = [33, 160, 158, 133, 153, 144]; // outer, top, top, inner, bottom, bottom
export const L_EYE = [362, 385, 387, 263, 373, 380];
export const R_IRIS = 468, L_IRIS = 473;

export const CONFIG = {
  earClosed: 0.21,        // eye aspect ratio below this = closed
  drowsySeconds: 1.5,     // continuous closure needed
  perclosWindow: 30,      // seconds of history for the closure-ratio indicator
  perclosLimit: 0.40,     // share of the window with closed eyes => drowsy
  yawMax: 25, pitchMax: 25,        // degrees away from calibrated "forward"
  gazeLeftRight: [0.35, 0.65],     // iris position inside the eye
  awaySeconds: 2.0,       // "away" must last this long
  noFaceSeconds: 1.0,
  stableSeconds: 0.4,     // new status must persist this long before it is shown
  calibFrames: 40,        // first frames of a session define "forward"
  blinkMin: 0.04, blinkMax: 0.5,
  alertCooldown: 10,      // seconds between alerts
  mirror: true,           // selfie view: swap Left/Right labels
};

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const wrap = (a) => (a > 90 ? a - 180 : a < -90 ? a + 180 : a);

function ear(p, idx) {
  const [a, b, c, d, e, f] = idx.map((i) => p[i]);
  const horiz = dist(a, d);
  return horiz < 1e-6 ? 0 : (dist(b, f) + dist(c, e)) / (2 * horiz);
}

// MediaPipe 4x4 face transform (flat array of 16, column-major) -> yaw/pitch/roll in degrees.
export function headPose(data) {
  const r = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let j = 0; j < 3; j++) {
    const n = Math.hypot(data[j * 4], data[j * 4 + 1], data[j * 4 + 2]) || 1;
    for (let i = 0; i < 3; i++) r[i][j] = data[j * 4 + i] / n;
  }
  const sy = Math.hypot(r[0][0], r[1][0]), deg = 180 / Math.PI;
  return [Math.atan2(-r[2][0], sy) * deg, wrap(Math.atan2(r[2][1], r[2][2]) * deg), wrap(Math.atan2(r[1][0], r[0][0]) * deg)];
}

export class AttentionEngine {
  constructor(cfg = CONFIG) { this.cfg = cfg; this.reset(); }
  reset() {
    this.status = NO_FACE; this.score = null; this.blinks = 0;
    this.tPrev = null; this.lastFaceT = null; this.closedSince = null; this.awaySince = null;
    this.cand = null; this.candSince = 0;
    this.blinkTimes = []; this.perclos = []; this.closedCnt = 0;
    this.calib = []; this.offset = null;
  }

  gaze(p, closed) {
    if (closed) return "Closed";
    if (p.length < 478) return "Center";
    const rs = [];
    for (const [c0, c1, iris] of [[33, 133, R_IRIS], [362, 263, L_IRIS]]) {
      const x0 = p[c0][0], x1 = p[c1][0];
      if (Math.abs(x1 - x0) > 1e-6) rs.push((p[iris][0] - x0) / (x1 - x0));
    }
    const h = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 0.5;
    const [lo, hi] = this.cfg.gazeLeftRight;
    const imgSide = h < lo ? "Left" : h > hi ? "Right" : "Center"; // side in the raw image
    if (imgSide === "Center" || !this.cfg.mirror) return imgSide;
    return imgSide === "Left" ? "Right" : "Left"; // selfie view is mirrored
  }

  // lms: [{x,y}] normalized or null. vw/vh: video size. matrix: flat 16 array or null. now: seconds.
  update(lms, vw, vh, matrix, now) {
    const cfg = this.cfg;
    const dt = this.tPrev == null ? 0 : Math.min(now - this.tPrev, 0.5);
    this.tPrev = now;
    const m = { face: false, ear: null, gaze: "-", yaw: 0, pitch: 0, roll: 0, calibrating: false, perclos: 0 };
    let box = null, rawState;

    if (lms && lms.length) {
      const p = lms.map((l) => [l.x * vw, l.y * vh]);
      this.lastFaceT = now; m.face = true;
      m.ear = (ear(p, R_EYE) + ear(p, L_EYE)) / 2;
      const closed = m.ear < cfg.earClosed;

      if (matrix) {
        const raw = headPose(matrix);
        if (!this.offset) {
          this.calib.push(raw);
          if (this.calib.length >= cfg.calibFrames) {
            this.offset = [0, 1, 2].map((k) => {
              const v = this.calib.map((r) => r[k]).sort((a, b) => a - b);
              return v[v.length >> 1];
            });
          }
        }
        m.calibrating = !this.offset;
        if (this.offset) { m.yaw = raw[0] - this.offset[0]; m.pitch = raw[1] - this.offset[1]; m.roll = raw[2] - this.offset[2]; }
      }
      m.gaze = this.gaze(p, closed);

      if (closed) { if (this.closedSince == null) this.closedSince = now; }
      else if (this.closedSince != null) {
        const d = now - this.closedSince;
        if (d >= cfg.blinkMin && d <= cfg.blinkMax) { this.blinks++; this.blinkTimes.push(now); }
        this.closedSince = null;
      }
      const closedFor = this.closedSince == null ? 0 : now - this.closedSince;

      this.perclos.push([now, closed]); this.closedCnt += closed ? 1 : 0;
      while (this.perclos.length && now - this.perclos[0][0] > cfg.perclosWindow) {
        if (this.perclos.shift()[1]) this.closedCnt--;
      }
      const span = now - this.perclos[0][0];
      m.perclos = this.closedCnt / this.perclos.length;

      const away = !m.calibrating && (Math.abs(m.yaw) > cfg.yawMax || Math.abs(m.pitch) > cfg.pitchMax
        || m.gaze === "Left" || m.gaze === "Right");
      if (away) { if (this.awaySince == null) this.awaySince = now; } else this.awaySince = null;
      const awayFor = this.awaySince == null ? 0 : now - this.awaySince;

      if (closedFor >= cfg.drowsySeconds || (span >= 10 && m.perclos >= cfg.perclosLimit)) rawState = DROWSY;
      else if (awayFor >= cfg.awaySeconds) rawState = DISTRACTED;
      else rawState = FOCUSED;

      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const l of lms) { x0 = Math.min(x0, l.x); x1 = Math.max(x1, l.x); y0 = Math.min(y0, l.y); y1 = Math.max(y1, l.y); }
      const pad = 0.08 * (x1 - x0);
      box = [Math.max(x0 - pad, 0), Math.max(y0 - pad, 0), Math.min(x1 + pad, 1), Math.min(y1 + pad, 1)];
    } else {
      this.closedSince = this.awaySince = null;
      const lost = this.lastFaceT == null || now - this.lastFaceT >= cfg.noFaceSeconds;
      rawState = lost ? NO_FACE : this.status; // hold briefly, then No Face
    }

    // temporal smoothing
    if (rawState === this.status) this.cand = null;
    else {
      if (rawState !== this.cand) { this.cand = rawState; this.candSince = now; }
      if (now - this.candSince >= cfg.stableSeconds) { this.status = rawState; this.cand = null; }
    }

    // smoothed attention score; unobserved time is not scored
    if (this.status !== NO_FACE && m.face) {
      const target = SCORE_TARGET[this.status];
      this.score = this.score == null ? target : this.score + (1 - Math.exp(-dt / 2)) * (target - this.score);
    }
    while (this.blinkTimes.length && now - this.blinkTimes[0] > 60) this.blinkTimes.shift();

    m.status = this.status; m.blinks = this.blinks; m.blinksPerMin = this.blinkTimes.length;
    m.attention = this.status === NO_FACE || this.score == null ? null : Math.round(this.score);
    return { m, box };
  }
}

export class SessionStats {
  constructor(cooldown = CONFIG.alertCooldown, logMax = 7200) {
    this.cooldown = cooldown; this.logMax = logMax;
    this.alertId = 0; this.alertType = ""; this.started = false; this._clear();
  }
  _clear() {
    this.running = false;
    this.timeIn = { [FOCUSED]: 0, [DISTRACTED]: 0, [DROWSY]: 0, [NO_FACE]: 0 };
    this.transitions = 0; this.blinks = 0; this.lastObs = null; this.lastT = null; this.lastLog = null;
    this.lastAlert = -1e9; this.startWall = null; this.startT = null; this.endT = null; this.log = [];
  }
  start(now) { this._clear(); this.started = this.running = true; this.startWall = new Date(); this.startT = now; }
  stop(now) { if (this.running) { this.running = false; this.endT = now; } }

  update(m, now) {
    if (!this.running) return;
    const dt = this.lastT == null ? 0 : Math.min(now - this.lastT, 0.5); // clamp gaps
    this.lastT = now;
    const st = m.status;
    this.timeIn[st] += dt; this.blinks = m.blinks;
    if (st !== NO_FACE) { if (this.lastObs && st !== this.lastObs) this.transitions++; this.lastObs = st; }
    if ((st === DISTRACTED || st === DROWSY) && now - this.lastAlert >= this.cooldown) {
      this.lastAlert = now; this.alertId++; this.alertType = st;
    }
    if (this.lastLog == null || now - this.lastLog >= 1) {
      this.lastLog = now;
      this.log.push([+(now - this.startT).toFixed(1), st, m.attention, m.ear, m.yaw, m.pitch, m.blinks, m.gaze]);
      if (this.log.length > this.logMax) this.log.shift();
    }
  }
  elapsed(now) { return this.startT == null ? 0 : (this.endT ?? now) - this.startT; }
  focusPct() {
    const t = this.timeIn, obs = t[FOCUSED] + t[DISTRACTED] + t[DROWSY];
    return obs < 1e-6 ? null : (100 * t[FOCUSED]) / obs;
  }
  trend() { return this.log.slice(-120).map((r) => r[2]); }

  toCsv(now) {
    const t = this.timeIn, fp = this.focusPct(), r1 = (v) => Math.round(v * 10) / 10;
    const rows = [
      ["AttentionAI session export (estimates only; not a medical or validated measurement)"],
      ["started", this.startWall.toISOString()], ["duration_s", r1(this.elapsed(now))],
      ["focused_s", r1(t[FOCUSED])], ["distracted_s", r1(t[DISTRACTED])], ["drowsy_s", r1(t[DROWSY])],
      ["no_face_s (not counted in focus %)", r1(t[NO_FACE])],
      ["focus_pct (focused / observed time)", fp == null ? "" : r1(fp)],
      ["blinks", this.blinks], ["status_transitions", this.transitions], [],
      ["elapsed_s", "status", "attention_pct", "ear", "yaw_deg", "pitch_deg", "blinks", "gaze"],
      ...this.log.map(([ts, st, att, e, y, p, b, g]) => [ts, st, att ?? "", e == null ? "" : e.toFixed(3), r1(y), r1(p), b, g]),
    ];
    const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    return rows.map((r) => r.map(esc).join(",")).join("\n");
  }
}
