import { AttentionEngine, SessionStats, CONFIG, COLORS, R_EYE, L_EYE, R_IRIS, L_IRIS, NO_FACE } from "./engine.js";

const VISION_VERSION = "0.10.21"; // pinned; change here if the CDN version is ever unavailable
const VISION_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VISION_VERSION}`;
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task";

const $ = (id) => document.getElementById(id);
const HINTS = { Focused: "Looking at the screen", Distracted: "Looking away from the screen",
  Drowsy: "Eyes closing. Take a short break", "No Face": "No face in view" };

const engine = new AttentionEngine(CONFIG);
const session = new SessionStats(CONFIG.alertCooldown);
let landmarker = null, stream = null, wakeLock = null, audioCtx = null;
let running = false, busy = false, muted = false, rafId = 0, lastVT = -1, lastAlert = null;
let fps = 0, tPrev = 0, lastRender = 0, last = { m: null, box: null, lms: null };

const showError = (msg) => { const e = $("error"); e.textContent = msg || ""; e.hidden = !msg; };
const fmtClock = (s) => [s / 3600, (s % 3600) / 60, s % 60].map((v) => String(Math.floor(v)).padStart(2, "0")).join(":");
const fmtSec = (s) => (s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`);
const nowSec = () => performance.now() / 1000;

/* ---------- audio (browser-generated beep) ---------- */
function ensureAudio() {
  if (!audioCtx) { const AC = window.AudioContext || window.webkitAudioContext; if (AC) audioCtx = new AC(); }
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
}
function alertUser(type) {
  if (muted) return;
  if (navigator.vibrate) navigator.vibrate(type === "Drowsy" ? [200, 100, 200, 100, 200] : [200, 100, 200]);
  if (!audioCtx) return;
  const freq = type === "Drowsy" ? 660 : 880, count = type === "Drowsy" ? 3 : 2;
  for (let i = 0; i < count; i++) {
    const t = audioCtx.currentTime + i * 0.28, o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = "sine"; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    o.connect(g).connect(audioCtx.destination); o.start(t); o.stop(t + 0.25);
  }
}

/* ---------- start / stop ---------- */
async function loadModel() {
  if (landmarker) return;
  $("statusHint").textContent = "Loading AI model (needs internet the first time)...";
  try {
    const { FaceLandmarker, FilesetResolver } = await import(`${VISION_URL}/vision_bundle.mjs`);
    const fileset = await FilesetResolver.forVisionTasks(`${VISION_URL}/wasm`);
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: MODEL_URL, delegate }, runningMode: "VIDEO", numFaces: 1,
      outputFacialTransformationMatrixes: true,
    });
    try { landmarker = await FaceLandmarker.createFromOptions(fileset, opts("GPU")); }
    catch (_) { landmarker = await FaceLandmarker.createFromOptions(fileset, opts("CPU")); }
  } catch (e) {
    throw new Error("Could not load the AI model. Connect to the internet once so it can download, then try again.");
  }
}

async function openCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)
    throw new Error("Camera is not available here. Open the app over HTTPS in Chrome or install it from the browser menu.");
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
  } catch (e) {
    if (e.name === "NotAllowedError") throw new Error("Camera permission was denied. Allow camera access for this app in browser/app settings, then try again.");
    if (e.name === "NotFoundError") throw new Error("No camera found on this device.");
    if (e.name === "NotReadableError") throw new Error("The camera is being used by another app. Close it and try again.");
    throw new Error("Could not open the camera: " + e.message);
  }
}

async function startSession() {
  if (running || busy) return; // never open a second stream
  busy = true; showError(""); $("btnStart").disabled = true;
  try {
    ensureAudio();
    await loadModel();
    stream = await openCamera();
    const video = $("cam");
    video.srcObject = stream;
    await video.play();
    $("frame").style.setProperty("--ar", (video.videoWidth / video.videoHeight).toFixed(4));
    engine.reset(); session.start(nowSec());
    lastVT = -1; lastAlert = session.alertId; fps = 0; tPrev = 0;
    running = true; setUi(true);
    try { wakeLock = await navigator.wakeLock?.request("screen"); } catch (_) { /* optional */ }
    rafId = requestAnimationFrame(tick);
  } catch (e) {
    releaseCamera(); showError(e.message); setUi(false); render(true);
  } finally { busy = false; }
}

function releaseCamera() {
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
  const video = $("cam"); video.pause(); video.srcObject = null;
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

function stopSession() {
  running = false; cancelAnimationFrame(rafId);
  session.stop(nowSec()); releaseCamera(); setUi(false);
  last = { m: null, box: null, lms: null }; render(true);
}

function setUi(on) {
  $("btnStart").disabled = on; $("btnStop").disabled = !on;
  $("livePill").textContent = on ? "Live" : "Idle"; $("livePill").classList.toggle("live", on);
  $("frame").classList.toggle("on", on);
  if (!on) $("fps").textContent = "FPS --";
}

/* ---------- main loop ---------- */
function tick() {
  if (!running) return;
  const video = $("cam"), t = performance.now();
  if (video.readyState >= 2 && video.currentTime !== lastVT) {
    lastVT = video.currentTime;
    try {
      const r = landmarker.detectForVideo(video, t);
      const lms = r.faceLandmarks && r.faceLandmarks[0] ? r.faceLandmarks[0] : null;
      const mat = r.facialTransformationMatrixes && r.facialTransformationMatrixes[0];
      const { m, box } = engine.update(lms, video.videoWidth, video.videoHeight, mat ? mat.data : null, t / 1000);
      session.update(m, t / 1000);
      last = { m, box, lms };
      if (tPrev) { const inst = 1000 / (t - tPrev); fps = fps ? 0.9 * fps + 0.1 * inst : inst; }
      tPrev = t;
      drawOverlay();
      if (t - lastRender > 250) { lastRender = t; render(false); }
    } catch (e) { stopSession(); showError("Detection error: " + e.message); return; }
  }
  rafId = requestAnimationFrame(tick);
}

function drawOverlay() {
  const c = $("overlay"), dpr = window.devicePixelRatio || 1, W = c.clientWidth, H = c.clientHeight;
  if (c.width !== W * dpr || c.height !== H * dpr) { c.width = W * dpr; c.height = H * dpr; }
  const g = c.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const { m, box, lms } = last; if (!m) return;
  const color = COLORS[m.status], mx = (x) => (1 - x) * W; // video is mirrored on screen
  if (box && lms) {
    const x0 = mx(box[2]), x1 = mx(box[0]), y0 = box[1] * H, y1 = box[3] * H;
    g.lineWidth = 2; g.strokeStyle = color; g.strokeRect(x0, y0, x1 - x0, y1 - y0);
    const label = m.calibrating ? "Calibrating" : m.status + (m.attention == null ? "" : ` ${m.attention}%`);
    g.font = "600 14px system-ui,sans-serif";
    const tw = g.measureText(label).width + 12, ly = Math.max(y0 - 24, 0);
    g.fillStyle = color; g.fillRect(x0, ly, tw, 22);
    g.fillStyle = "#141414"; g.fillText(label, x0 + 6, ly + 16);
    g.fillStyle = "#67e8f9";
    for (const i of [...R_EYE, ...L_EYE]) { g.beginPath(); g.arc(mx(lms[i].x), lms[i].y * H, 1.4, 0, 7); g.fill(); }
    if (lms.length >= 478) { g.fillStyle = "#fde047"; for (const i of [R_IRIS, L_IRIS]) { g.beginPath(); g.arc(mx(lms[i].x), lms[i].y * H, 2.4, 0, 7); g.fill(); } }
  } else if (m.status === NO_FACE) {
    g.fillStyle = color; g.font = "600 16px system-ui,sans-serif"; g.textAlign = "center";
    g.fillText("No face detected", W / 2, H / 2); g.textAlign = "start";
  }
}

/* ---------- dashboard ---------- */
function render(force) {
  const m = last.m, t = nowSec(), el = session.elapsed(t);
  const state = m ? m.status : (running ? NO_FACE : "idle");
  $("statusCard").dataset.state = state;
  $("statusName").textContent = state === "idle" ? "Idle" : state;
  $("statusHint").textContent = m && m.calibrating ? "Calibrating: look at the screen" : (HINTS[state] || "Start a session to begin");
  const att = m && m.attention != null ? m.attention : null;
  $("attn").textContent = att == null ? "--" : att + "%"; $("attnBar").style.width = (att || 0) + "%";
  $("ear").textContent = m && m.ear != null ? m.ear.toFixed(3) : "--";
  $("bpm").textContent = m ? m.blinksPerMin : "--";
  $("gaze").textContent = m && m.face ? m.gaze : "--";
  if (m) $("fps").textContent = "FPS " + fps.toFixed(1);
  $("calib").textContent = m && m.calibrating ? "calibrating..." : "";
  for (const k of ["yaw", "pitch", "roll"]) {
    const v = m ? m[k] : 0, row = document.querySelector(`.pose[data-k="${k}"]`);
    row.querySelector("i").style.left = 50 + Math.max(-1, Math.min(1, v / 45)) * 50 + "%";
    row.querySelector("b").textContent = v.toFixed(1) + "°";
  }
  const ti = session.timeIn, obs = ti.Focused + ti.Distracted + ti.Drowsy, fp = session.focusPct();
  $("duration").textContent = fmtClock(el);
  $("tFocused").textContent = fmtSec(ti.Focused); $("tDistracted").textContent = fmtSec(ti.Distracted);
  $("tDrowsy").textContent = fmtSec(ti.Drowsy); $("tNoFace").textContent = fmtSec(ti["No Face"]);
  $("blinks").textContent = session.blinks; $("trans").textContent = session.transitions;
  $("focusPct").textContent = fp == null ? "--" : fp.toFixed(1) + "%";
  if (obs > 0) {
    const a = (ti.Focused / obs) * 100, b = a + (ti.Distracted / obs) * 100;
    $("donut").style.background = `conic-gradient(var(--green) 0 ${a}%, var(--yellow) ${a}% ${b}%, var(--red) ${b}% 100%)`;
  } else $("donut").style.background = "conic-gradient(var(--raised) 0 100%)";
  if (lastAlert === null) lastAlert = session.alertId;
  else if (session.alertId > lastAlert) { lastAlert = session.alertId; alertUser(session.alertType); }
  drawTrend(session.trend());
}

function drawTrend(vals) {
  const c = $("trend"), dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = 110;
  c.width = w * dpr; c.height = h * dpr; c.style.height = h + "px";
  const g = c.getContext("2d"); g.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement);
  g.strokeStyle = css.getPropertyValue("--line"); g.lineWidth = 1;
  for (const y of [0.1, 0.5, 0.9]) { g.beginPath(); g.moveTo(0, h * y); g.lineTo(w, h * y); g.stroke(); }
  if (!vals.length) return;
  const step = w / Math.max(vals.length - 1, 1);
  g.strokeStyle = css.getPropertyValue("--accent"); g.lineWidth = 2; g.beginPath();
  let pen = false;
  vals.forEach((v, i) => {
    if (v == null) { pen = false; return; }
    const x = i * step, y = h - 6 - (v / 100) * (h - 12);
    pen ? g.lineTo(x, y) : g.moveTo(x, y); pen = true;
  });
  g.stroke();
}

function exportCsv() {
  if (!session.started) { showError("No session yet. Start a session first."); return; }
  const blob = new Blob([session.toCsv(nowSec())], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: `attentionai_session_${Date.now()}.csv` });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/* ---------- wiring ---------- */
$("btnStart").onclick = startSession;
$("btnStop").onclick = stopSession;
$("btnExport").onclick = exportCsv;
$("btnMute").onclick = () => {
  muted = !muted; $("btnMute").textContent = muted ? "Alerts muted" : "Alerts on";
  $("btnMute").setAttribute("aria-pressed", muted);
};
document.addEventListener("visibilitychange", async () => { // wake lock is released when the page is hidden
  if (running && document.visibilityState === "visible" && !wakeLock) {
    try { wakeLock = await navigator.wakeLock?.request("screen"); } catch (_) { /* optional */ }
  }
});
window.addEventListener("pagehide", releaseCamera);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
render(true);
