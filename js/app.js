// KinemaLoom on the phone: the patient's side only.
//
// Scan the programme QR from the clinic, do the exercises in front of the
// phone's camera, answer two questions, and show the results as an animated
// QR for the clinic computer to read. The measuring is core.js through
// session.js, the same rules as the desktop; this file is the screens.
//
// Everything runs on the phone. The camera picture is never stored or sent.

import { FilesetResolver, PoseLandmarker } from "./vendor/vision_bundle.mjs";
import qrcode from "./vendor/qrcode.mjs";
import { angle3pt, framingHint, landmarkConfidence, MIN_CONFIDENCE } from "./core.js";
import { decodeProgramme, encodeResults } from "./exchange.js";
import { HomeSession } from "./session.js";
import { drawFigure, facingText } from "./figure.js";
import * as store from "./store.js";

const MODEL = "full";
const SEND_PART_MS = 500;          // each results QR part stays this long on screen
const EFFORTS = ["easy", "about right", "hard"];
// Development only: ?video=<url> measures a video file instead of the camera.
const DEV_VIDEO = new URLSearchParams(location.search).get("video");

const $ = (id) => document.getElementById(id);
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

// ----- pages ------------------------------------------------------------------

let page = null;
const leaving = [];                // cleanups for the page being shown

function show(id) {
  while (leaving.length) leaving.pop()();
  for (const s of document.querySelectorAll("section.page")) s.hidden = s.id !== id;
  page = id;
  window.scrollTo(0, 0);
  // The phone's back button returns to the exercise list rather than leaving the app.
  if (id !== "home" && id !== "welcome" && history.state?.page !== id) history.pushState({ page: id }, "");
}

function goHome() {
  if (page === "exercise") {
    finishSession();               // asks how it felt if anything was measured
    return;
  }
  if (page === "feedback") saveSession(null);
  store.loadProgramme() ? renderHome() : show("welcome");
}

window.addEventListener("popstate", () => goHome());

document.addEventListener("click", (e) => {
  const go = e.target.closest("[data-go]")?.dataset.go;
  if (go === "scan") startScan();
  else if (go === "send") startSend();
  else if (go === "home" || go === "back") goHome();
});

// ----- camera ----------------------------------------------------------------

async function openCamera(facing) {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    throw Object.assign(new Error("insecure"), { name: "InsecureError" });
  }
  return navigator.mediaDevices.getUserMedia({
    video: { facingMode: facing, width: { ideal: 640 }, height: { ideal: 480 } }, audio: false,
  });
}

function cameraError(e) {
  switch (e.name) {
    case "NotAllowedError": return "The camera is blocked for this page. Allow it in the browser's site settings, then try again.";
    case "NotFoundError": case "OverconstrainedError": return "No camera was found on this phone.";
    case "NotReadableError": return "The camera is in use by another app. Close it and try again.";
    case "InsecureError": return "The camera only works when this page is opened over https.";
    default: return `The camera could not start (${e.message || e.name}).`;
  }
}

function stopStream(stream) {
  stream?.getTracks().forEach((t) => t.stop());
}

let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && "wakeLock" in navigator) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    } else if (!on && wakeLock) {
      await wakeLock.release();
    }
  } catch {
    // not supported, or refused (battery saver): the screen may dim, nothing worse
  }
}
// A wake lock ends when the page is hidden; take it again on return.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && (page === "exercise" || page === "send")) keepAwake(true);
});

// ----- scanning the programme ---------------------------------------------------

async function startScan() {
  show("scan");
  const msg = $("scan-msg");
  msg.textContent = "Point the camera at the QR code on your clinician's screen.";
  let stream;
  try {
    stream = await openCamera("environment");
  } catch (e) {
    msg.textContent = cameraError(e);
    return;
  }
  if (page !== "scan") return stopStream(stream);
  const video = $("scan-video");
  video.srcObject = stream;
  await video.play().catch(() => {});

  let detector = null;
  try {
    if ("BarcodeDetector" in window
        && (await BarcodeDetector.getSupportedFormats()).includes("qr_code")) {
      detector = new BarcodeDetector({ formats: ["qr_code"] });
    }
  } catch {
    detector = null;
  }
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  let busy = false;
  let done = false;

  const timer = setInterval(async () => {
    if (busy || done || video.readyState < 2) return;
    busy = true;
    try {
      let texts = [];
      if (detector) {
        texts = (await detector.detect(video)).map((c) => c.rawValue);
      } else if (window.jsQR) {
        const k = Math.min(1, 800 / Math.max(video.videoWidth, video.videoHeight));
        canvas.width = Math.round(video.videoWidth * k);
        canvas.height = Math.round(video.videoHeight * k);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const found = window.jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
        if (found) texts = [found.data];
      }
      const ours = texts.find((t) => t.startsWith("KLP1"));
      if (ours) {
        const programme = await decodeProgramme(ours);
        done = true;
        store.saveProgramme(ours, programme);
        if (navigator.vibrate) navigator.vibrate(80);
        renderHome();
      } else if (texts.length) {
        msg.textContent = "That QR code is not a KinemaLoom programme.";
      }
    } catch (e) {
      msg.textContent = `The code could not be read: ${e.message}. Try again, a little closer.`;
    } finally {
      busy = false;
    }
  }, 200);
  leaving.push(() => { clearInterval(timer); stopStream(stream); video.srcObject = null; });
}

// ----- the exercise list --------------------------------------------------------

function describeItem(it) {
  const plan = it.sets > 1
    ? `${it.sets} sets of ${it.reps}${it.rest ? `, ${it.rest} s rest` : ""}`
    : plural(it.reps, "repetition");
  return `${plan} · target ${it.target[0]}–${it.target[1]}°`;
}

function formatDate(iso) {
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

function renderHome() {
  const saved = store.loadProgramme();
  if (!saved) return show("welcome");
  const p = saved.programme;
  show("home");
  $("home-title").textContent = `Your exercises · ${p.patient}`;
  $("home-from").textContent = `From ${p.clinician || "your clinician"}, ${formatDate(p.issued)}`;
  const list = $("home-list");
  list.replaceChildren(...p.items.map((it) => {
    const li = document.createElement("li");
    const b = document.createElement("b");
    b.textContent = `${it.exercise} · ${it.side} side`;
    const span = document.createElement("span");
    span.textContent = describeItem(it);
    li.append(b, span);
    return li;
  }));
  const n = store.sessionsFor(p.patient).length;
  $("home-sessions").textContent = n
    ? `${plural(n, "session")} saved on this phone. Sending them again is fine; the clinic keeps each once.`
    : "No sessions on this phone yet.";
  $("home-send").disabled = n === 0;
}

$("home-start").addEventListener("click", () => startExercises());

$("forget").addEventListener("click", () => {
  if (confirm("Delete your programme and every saved session from this phone? "
              + "Sessions not yet sent to the clinic will be lost.")) {
    store.forgetAll();
    show("welcome");
  }
});

// ----- exercising -------------------------------------------------------------

let session = null;
let landmarker = null;
let latest = null;                 // the last frame's measurement, after the pipeline
let sourceError = "";
let sound = store.settings.sound;
let audio = null;

async function createLandmarker() {
  const fileset = await FilesetResolver.forVisionTasks(new URL("../wasm", import.meta.url).href);
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: new URL(`../models/pose_landmarker_${MODEL}.task`, import.meta.url).href, delegate },
    runningMode: "VIDEO", numPoses: 1, outputSegmentationMasks: false,
    minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
  });
  try {
    return await PoseLandmarker.createFromOptions(fileset, options("GPU"));
  } catch {
    return PoseLandmarker.createFromOptions(fileset, options("CPU"));
  }
}

// One camera frame's reading, as the desktop worker makes it. The frame is the
// camera's own (not mirrored), so the side needs no swapping; only the display
// is mirrored.
function readFrame(result, w, h) {
  const ex = session.ex;
  const lms = result.landmarks?.[0];
  if (!lms) return { pose: false, points: null, angle: null, confident: false, reason: "", hint: "" };
  const idx = ex.resolve(session.side);
  const [conf, reason] = landmarkConfidence(lms, idx, ex.jointNames);
  const points = idx.map((i) => [lms[i].x * w, lms[i].y * h]);
  const twin = ex.resolve(session.side === "left" ? "right" : "left")[1];
  return {
    pose: true, points, angle: angle3pt(...points), confident: conf >= MIN_CONFIDENCE, reason,
    hint: framingHint(points.map(([x, y]) => [Math.trunc(x), Math.trunc(y)]), ex, h),
    depthGap: lms[idx[1]].z - lms[twin].z,
  };
}

async function startExercises() {
  const saved = store.loadProgramme();
  if (!saved) return show("welcome");
  session = new HomeSession(saved.programme, { model: MODEL });
  if (!session.items.length) {
    alert("This programme has no exercises this app can measure. Please ask your clinician.");
    return;
  }
  latest = null;
  sourceError = "";
  show("exercise");
  buildStrip();
  selectionChanged();
  setSound(sound);

  const loading = $("loading");
  const live = $("live");
  loading.hidden = false;
  loading.textContent = "Preparing the camera…";
  let running = true;
  let measuring = false;           // camera and tracker ready
  let stream = null;
  let raf = 0;
  const video = document.createElement("video");
  video.playsInline = true;
  video.muted = true;
  // Phones pause the camera while another app is in front; carry on on return.
  const resume = () => {
    if (document.visibilityState === "visible" && video.paused && measuring) video.play().catch(() => {});
  };
  document.addEventListener("visibilitychange", resume);
  leaving.push(() => {
    running = false;
    cancelAnimationFrame(raf);
    document.removeEventListener("visibilitychange", resume);
    stopStream(stream);
    video.pause();
    video.removeAttribute("src");
    video.srcObject = null;
    keepAwake(false);
  });

  const ctx = live.getContext("2d");
  const fig = $("figure");
  const fctx = fig.getContext("2d");
  let lastVideoTime = -1;
  let lastStamp = 0;

  // The figure moves from the start, while the camera and tracker get ready.
  const frame = () => {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    sizeCanvas(fig, fctx);
    drawFigure(fctx, fig.clientWidth, fig.clientHeight, session.ex, session.side, performance.now() / 1000);
    if (session.tick()) tone(true);        // the rest ran out: "go"
    if (!measuring || video.readyState < 2 || video.currentTime === lastVideoTime) {
      if (session.resting()) updateReadout();
      return;
    }
    lastVideoTime = video.currentTime;
    const stamp = Math.max(performance.now(), lastStamp + 1);
    lastStamp = stamp;
    const w = video.videoWidth;
    const h = video.videoHeight;
    let result;
    try {
      result = landmarker.detectForVideo(video, stamp);
    } catch (e) {
      sourceError = `Measuring stopped (${e.message}).`;
      measuring = false;
      updateReadout();
      return;
    }
    const m = readFrame(result, w, h);
    const out = session.measure(m);
    latest = { ...m, ...out };
    if (out.rep) announceRep(out.rep);
    drawLive(ctx, live, video, w, h, latest);
    updateReadout();
  };
  raf = requestAnimationFrame(frame);

  try {
    if (DEV_VIDEO) {
      video.src = DEV_VIDEO;
      video.loop = true;
      live.style.transform = "none";        // a recording is shown as recorded
    } else {
      stream = await openCamera("user");
      video.srcObject = stream;
    }
    await video.play();
  } catch (e) {
    if (!running) return stopStream(stream);
    sourceError = DEV_VIDEO ? `The video could not play (${e.message}).` : cameraError(e);
    loading.textContent = sourceError;
    updateReadout();
    return;
  }
  if (!running) return;
  keepAwake(true);

  loading.textContent = "Preparing the movement tracker…";
  try {
    landmarker = landmarker || (await createLandmarker());
  } catch (e) {
    sourceError = `The movement tracker could not start on this phone (${e.message}).`;
    loading.textContent = sourceError;
    updateReadout();
    return;
  }
  if (!running) return;
  loading.hidden = true;
  measuring = true;
}

function sizeCanvas(canvas, ctx) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function drawLive(ctx, canvas, video, w, h, m) {
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  ctx.drawImage(video, 0, 0, w, h);
  if (!m.points) return;
  const col = !m.confident ? "#909696" : m.inTarget ? "#78be6e" : "#e8eeee";
  const unit = Math.max(2, h / 160);
  ctx.strokeStyle = col;
  ctx.fillStyle = col;
  ctx.lineCap = "round";
  ctx.lineWidth = unit * 1.6;
  ctx.beginPath();
  ctx.moveTo(...m.points[0]);
  ctx.lineTo(...m.points[1]);
  ctx.lineTo(...m.points[2]);
  ctx.stroke();
  m.points.forEach((p, i) => {
    ctx.beginPath();
    ctx.arc(p[0], p[1], unit * (i === 1 ? 3 : 2.2), 0, 2 * Math.PI);
    ctx.fill();
  });
}

function buildStrip() {
  $("strip").replaceChildren(...session.items.map(() => document.createElement("li")));
}

function selectionChanged() {
  const ex = session.ex;
  $("ex-title").textContent = `${ex.name} · ${session.side} side`;
  $("ex-cue").textContent = `${ex.cueFor(session.side)}. ${facingText(ex)}; green is your target, `
                            + `${ex.target[0]}–${ex.target[1]}°.`;
  latest = null;
  updateReadout();
}

function warningState() {
  if (sourceError) return [sourceError, "bad"];
  if (!latest) return ["Waiting for the camera…", "muted"];
  const parts = [];
  let level = "ok";
  if (!latest.pose) {
    parts.push("No person detected");
    level = "bad";
  } else if (!latest.confident) {
    parts.push(cap(latest.reason) || "Low confidence");
    level = "bad";
  }
  if (latest.hint) {
    parts.push(latest.hint);
    if (level === "ok") level = "warn";
  }
  if (session.measuredLimbFar()) {
    const limb = session.ex.jointNames[1] === "knee" ? "leg" : "arm";
    parts.push(`Your ${session.side} ${limb} looks farther from the camera – turn so it is nearest`);
    if (level === "ok") level = "warn";
  }
  if (!parts.length) return ["✓  Tracking OK", "ok"];
  return [`⚠  ${parts.join(" · ")}`, level];
}

let lastStatus = "";
function updateReadout() {
  if (!session || page !== "exercise") return;
  const [text, level] = warningState();
  const warning = $("warning");
  setText(warning, text);
  warning.className = `warning ${level}`;

  const angle = $("angle");
  if (latest && latest.angle != null) {
    setText(angle, `${Math.round(latest.angle)}°`);
    angle.className = `angle ${!latest.confident ? "unsure" : latest.inTarget ? "in" : ""}`;
  } else {
    setText(angle, "");
  }

  const { big, sub } = session.countText();
  const done = session.itemDone();
  setText($("count"), big);
  $("count").classList.toggle("done", done);
  setText($("count-sub"), sub);

  const [main, hint, rating] = session.repStatus();
  const status = $("status");
  const html = `${main}<small>${hint}</small>`;
  if (html !== lastStatus) {
    status.innerHTML = "";
    status.append(main);
    const small = document.createElement("small");
    small.textContent = hint;
    status.append(small);
    lastStatus = html;
  }
  status.classList.toggle("in", rating === "in");
  status.classList.toggle("off", rating === "off");

  const running = session.state === "running";
  $("start").hidden = running;
  $("skip").hidden = !session.resting();
  const next = $("next");
  setText(next, session.isLast() ? "Finish" : "Next exercise");
  next.classList.toggle("ready", done);
  next.hidden = !running;

  [...$("strip").children].forEach((li, i) => {
    const it = session.items[i];
    const reps = session.counter(it).reps;
    const total = HomeSession.total(it);
    const itemDone = reps >= total;
    li.className = i === session.itemIndex ? "current" : itemDone ? "done" : "";
    setText(li, `${i + 1} ${it.ex.name.split(" ")[0]} ${it.side[0].toUpperCase()} · `
                + `${itemDone ? "✓ " : ""}${Math.min(reps, total)}/${total}`);
  });
}

function announceRep(rep) {
  tone(rep.rating === "in target");
  const status = $("status");
  status.classList.remove("flash");
  void status.offsetWidth;         // restart the animation
  status.classList.add("flash");
}

$("start").addEventListener("click", () => {
  unlockAudio();
  session.start();
  updateReadout();
});
$("skip").addEventListener("click", () => {
  if (session.endRest()) tone(true);
  updateReadout();
});
$("next").addEventListener("click", () => {
  if (session.next()) selectionChanged();
  else finishSession();
});
$("finish").addEventListener("click", () => finishSession());

function setSound(on) {
  sound = on;
  store.settings.sound = on;
  $("sound").textContent = on ? "Sound on" : "Sound off";
  $("sound").classList.toggle("primary", on);
}
$("sound").addEventListener("click", () => {
  unlockAudio();
  setSound(!sound);
});

// A short tone when a repetition ends: higher if it ended in the target range.
function unlockAudio() {
  try {
    audio = audio || new AudioContext();
    if (audio.state === "suspended") audio.resume();
  } catch {
    audio = null;
  }
}

function tone(good) {
  if (!sound || !audio) return;
  const [freq, secs] = good ? [880, 0.12] : [440, 0.22];
  const t = audio.currentTime;
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(0.25, t + 0.01);
  gain.gain.setValueAtTime(0.25, t + secs - 0.03);
  gain.gain.linearRampToValueAtTime(0, t + secs);
  osc.connect(gain).connect(audio.destination);
  osc.start(t);
  osc.stop(t + secs);
}

// ----- finishing --------------------------------------------------------------

let pendingSave = false;

function finishSession() {
  const measured = session.state === "running" && session.finish();
  show(measured ? "feedback" : "done");
  if (measured) {
    pendingSave = true;
    resetFeedback();
  } else {
    showSummary(null, false);
  }
}

function resetFeedback() {
  $("pain").replaceChildren(...Array.from({ length: 11 }, (_, n) => choice(String(n), "pain")));
  $("effort").replaceChildren(...EFFORTS.map((e) => choice(cap(e), "effort")));
}

function choice(text, group) {
  const b = document.createElement("button");
  b.textContent = text;
  b.addEventListener("click", () => {
    const was = b.classList.contains("on");
    for (const other of $(group).children) other.classList.remove("on");
    b.classList.toggle("on", !was);
  });
  return b;
}

function chosen(group) {
  return [...$(group).children].findIndex((b) => b.classList.contains("on"));
}

function saveSession(feedback) {
  if (!pendingSave) return false;
  pendingSave = false;
  const ok = store.addSession(session.programme.patient, session.result(feedback));
  return ok;
}

$("fb-save").addEventListener("click", () => {
  const pain = chosen("pain");
  const effort = chosen("effort");
  let feedback = { pain: pain >= 0 ? pain : null, effort: effort >= 0 ? EFFORTS[effort] : null };
  if (feedback.pain === null && feedback.effort === null) feedback = null;
  const ok = saveSession(feedback);
  show("done");
  showSummary(feedback, ok);
});
$("fb-skip").addEventListener("click", () => {
  const ok = saveSession(null);
  show("done");
  showSummary(null, ok);
});

// Leaving at the question, or closing the app mid-session: save without answers.
window.addEventListener("pagehide", () => {
  if (page === "exercise" && session?.state === "running" && session.finish()) pendingSave = true;
  saveSession(null);
});

function describeFeedback(f) {
  const parts = [];
  if (f?.pain != null) parts.push(`pain ${f.pain} of 10`);
  if (f?.effort) parts.push(`effort ${f.effort}`);
  return parts.join(", ") || "not given";
}

function showSummary(feedback, saved) {
  const lines = session.summary();
  const complete = lines.every((l) => l.done);
  $("done-title").textContent = complete ? "Well done" : saved ? "Saved" : "Nothing saved";
  $("done-list").replaceChildren(...lines.map((l) => {
    const li = document.createElement("li");
    li.textContent = `${l.name}: ${l.reps} of ${l.total}${l.done ? " ✓" : ""}`;
    li.className = l.done ? "done" : "";
    return li;
  }));
  $("done-text").textContent = !saved
    ? (session.hasData() ? "The session could not be saved: this browser's storage is full or blocked."
      : "Nothing was measured today.")
    : (feedback ? `You said: ${describeFeedback(feedback)}. ` : "")
      + "Send your results to the clinic at your next visit, or now if you are there.";
  document.querySelector('#done [data-go="send"]').hidden = !saved;
}

// ----- sending results -----------------------------------------------------------

function drawQr(canvas, text) {
  const qr = qrcode(0, "M");
  qr.addData(text, "Alphanumeric");
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;
  const scale = Math.max(4, Math.floor(640 / (n + 2 * quiet)));
  const size = (n + 2 * quiet) * scale;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = "#000";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
    }
  }
}

async function startSend() {
  const saved = store.loadProgramme();
  if (!saved) return show("welcome");
  show("send");
  const p = saved.programme;
  const sessions = store.sessionsFor(p.patient);
  const canvas = $("qr");
  const partText = $("send-part");
  if (!sessions.length) {
    canvas.hidden = true;
    partText.textContent = "There are no sessions on this phone yet.";
    return;
  }
  canvas.hidden = false;
  let parts;
  try {
    parts = await encodeResults(p.patient, p.key, sessions);
  } catch (e) {
    partText.textContent = `The results could not be prepared (${e.message}).`;
    return;
  }
  let i = 0;
  const step = () => {
    drawQr(canvas, parts[i]);
    partText.textContent = `${plural(sessions.length, "session")} · part ${i + 1} of ${parts.length}`;
    i = (i + 1) % parts.length;
  };
  step();
  const timer = setInterval(step, SEND_PART_MS);
  keepAwake(true);
  leaving.push(() => { clearInterval(timer); keepAwake(false); });
}

// ----- start ----------------------------------------------------------------------

if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
store.loadProgramme() ? renderHome() : show("welcome");

// For the development page and tests: the state, read-only in spirit.
window.kinemaloom = { get session() { return session; }, get latest() { return latest; }, store };
