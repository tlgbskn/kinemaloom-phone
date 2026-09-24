// KinemaLoom on the phone: the patient's side only.
//
// Scan the programme QR from the clinic, do the exercises in front of the
// phone's camera, answer two questions, and show the results as an animated
// QR for the clinic computer to read. The measuring is core.js through
// session.js, the same rules as the desktop; this file is the screens.
//
// Everything runs on the phone. The camera picture is never stored or sent.

import { FilesetResolver, PoseLandmarker } from "./vendor/vision_bundle.mjs?v=f658e47a3e";
import qrcode from "./vendor/qrcode.mjs?v=f658e47a3e";
import { angle3pt, exerciseByName, framingHint, landmarkConfidence, MIN_CONFIDENCE } from "./core.js?v=f658e47a3e";
import { decodeProgramme, encodeResults, encodeResultsV2, programmeVersion } from "./exchange.js?v=f658e47a3e";
import { HomeSession, itemExercise } from "./session.js?v=f658e47a3e";
import { drawFigure, facingText } from "./figure.js?v=f658e47a3e";
import * as store from "./store.js?v=f658e47a3e";
import { t, useLanguage, currentLanguage, chooseLanguage, sideWords, LANGUAGES } from "./i18n.js?v=f658e47a3e";

const MODEL = "full";
const SEND_PART_MS = 500;          // each results QR part stays this long on screen
const EFFORTS = ["easy", "about right", "hard"];   // stored as they are; shown translated
// Development only: ?video=<url> measures a video file instead of the camera.
const DEV_VIDEO = new URLSearchParams(location.search).get("video");

const $ = (id) => document.getElementById(id);
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const sessionsWord = (n) => t(n === 1 ? "patient.sessions.one" : "patient.sessions.other", { n });

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

// ----- the language ------------------------------------------------------------

// The clinic can put the patient's language in the programme; the patient can
// change it here, and that choice holds until the next programme arrives, which
// carries a decision someone has just made. See chooseLanguage.
async function applyLanguage(chosen) {
  if (chosen) store.settings.language = chosen;
  await useLanguage(chooseLanguage({ chosen: store.settings.language,
                                     programme: store.loadProgramme()?.programme?.language,
                                     phone: navigator.language }));
  document.documentElement.lang = currentLanguage();
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  // The language button offers the other language, in that language.
  const other = Object.keys(LANGUAGES).find((l) => l !== currentLanguage());
  for (const id of ["language", "language-welcome"]) {
    const button = $(id);
    if (button) {
      button.textContent = LANGUAGES[other];
      button.onclick = () => applyLanguage(other).then(() => redraw());
    }
  }
}

// Whatever page is showing, drawn again in the language now in use.
function redraw() {
  installAdvice();
  if (page === "home") renderHome();
  else if (page === "exercise") {
    selectionChanged();
    buildStrip();
  } else if (page === "scan") $("scan-msg").textContent = t("patient.scan.hint");
  else if (page === "send") startSend();
}

// ----- keeping the data on an iPhone -------------------------------------------

// Safari on iPhone deletes a site's stored data after seven days of use in
// which the site is not opened (WebKit, "7-day cap on all script-writeable
// storage"). An app added to the Home Screen is exempt: its days follow its
// own use. A patient who opens the app once a week would lose the programme
// and every unsent session. The Home Screen app has its own storage, separate
// from Safari's, so the advice is to add it first and scan the programme
// there - and, if sessions are already saved here, to send those from here.
const onIPhone = /iPhone|iPad|iPod/.test(navigator.userAgent)
  || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)    // iPadOS
  || new URLSearchParams(location.search).has("ios");                        // development only
const installed = navigator.standalone === true
  || window.matchMedia?.("(display-mode: standalone)").matches;

function installAdvice() {
  const show = onIPhone && !installed;
  const saved = store.loadProgramme();
  const unsent = saved ? store.sessionsFor(saved.programme.patient).length : 0;
  for (const box of document.querySelectorAll("[data-install]")) {
    box.hidden = !show;
    if (!show) continue;
    const title = document.createElement("b");
    title.textContent = t("patient.install.title");
    const body = document.createElement("span");
    body.textContent = t(unsent ? "patient.install.body.has_sessions" : "patient.install.body");
    box.replaceChildren(title, body);
  }
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
    case "NotAllowedError": return t("camera.blocked");
    case "NotFoundError": case "OverconstrainedError": return t("camera.none");
    case "NotReadableError": return t("camera.busy");
    case "InsecureError": return t("camera.insecure");
    default: return t("camera.failed", { message: e.message || e.name });
  }
}

function stopStream(stream) {
  stream?.getTracks().forEach((track) => track.stop());
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
  msg.textContent = t("patient.scan.hint");
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
      const ours = texts.find((text) => programmeVersion(text) !== 0);
      if (ours && programmeVersion(ours) < 0) {
        msg.textContent = t("patient.scan.newer");
      } else if (ours) {
        const programme = await decodeProgramme(ours);
        done = true;
        store.saveProgramme(ours, programme);
        if (navigator.vibrate) navigator.vibrate(80);
        // A new programme carries the language the clinic chose for this
        // patient, and saying so is a decision someone just made: it beats a
        // language this phone was switched to earlier. The patient can switch
        // again afterwards, and that choice then holds until the next programme.
        store.settings.language = "";
        await applyLanguage();
        renderHome();
      } else if (texts.length) {
        msg.textContent = t("patient.scan.not_ours");
      }
    } catch (e) {
      msg.textContent = t("patient.scan.failed", { message: e.message });
    } finally {
      busy = false;
    }
  }, 200);
  leaving.push(() => { clearInterval(timer); stopStream(stream); video.srcObject = null; });
}

// ----- the exercise list --------------------------------------------------------

function describeItem(it) {
  let plan = it.sets > 1 ? t("patient.item.sets", { sets: it.sets, reps: it.reps })
    : t(it.reps === 1 ? "patient.item.reps.one" : "patient.item.reps.other", { reps: it.reps });
  if (it.sets > 1 && it.rest) plan = t("patient.item.rest", { plan, rest: it.rest });
  return t("patient.item.plan", { plan, lo: it.target[0], hi: it.target[1] });
}

function formatDate(iso) {
  const d = new Date(`${iso}T12:00:00`);
  const locale = currentLanguage() === "fr" ? "fr-CA" : "en-GB";
  return Number.isNaN(d.getTime()) ? iso
    : d.toLocaleDateString(locale, { day: "numeric", month: "long", year: "numeric" });
}

function renderHome() {
  const saved = store.loadProgramme();
  if (!saved) return show("welcome");
  const p = saved.programme;
  show("home");
  $("home-title").textContent = t("patient.home.title", { patient: p.patient });
  $("home-from").textContent = t("patient.home.from", {
    clinician: p.clinician || t("patient.home.clinician"), date: formatDate(p.issued) });
  $("home-start").textContent = t("patient.home.start");
  $("home-send").textContent = t("patient.home.send");
  const list = $("home-list");
  list.replaceChildren(...p.items.map((it) => {
    const li = document.createElement("li");
    const b = document.createElement("b");
    const ex = exerciseByName(it.exercise);
    b.textContent = t("patient.item.title", { name: ex ? ex.displayName : it.exercise,
                                              ...sideWords(it.side) });
    const span = document.createElement("span");
    span.textContent = describeItem(it);
    li.append(b, span);
    if (!itemExercise(it)) {           // shown, so the patient knows it was prescribed
      const note = document.createElement("span");
      note.className = "unusable";
      note.textContent = t("patient.item.unusable");
      li.append(note);
    }
    return li;
  }));
  const n = store.sessionsFor(p.patient).length;
  $("home-sessions").textContent = n
    ? t("patient.home.sessions.some", { sessions: sessionsWord(n) })
    : t("patient.home.sessions.none");
  $("home-send").disabled = n === 0;
  installAdvice();
}

$("home-start").addEventListener("click", () => startExercises());

$("forget").addEventListener("click", () => {
  if (confirm(t("patient.forget.confirm"))) {
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
    alert(t("patient.no_exercises"));
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
  loading.textContent = t("patient.loading.camera");
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
      sourceError = t("camera.measuring_stopped", { message: e.message });
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
    sourceError = DEV_VIDEO ? t("camera.video_failed", { message: e.message }) : cameraError(e);
    loading.textContent = sourceError;
    updateReadout();
    return;
  }
  if (!running) return;
  keepAwake(true);

  loading.textContent = t("patient.loading.tracker");
  try {
    landmarker = landmarker || (await createLandmarker());
  } catch (e) {
    sourceError = t("camera.tracker_failed", { message: e.message });
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
  $("ex-title").textContent = t("patient.item.title", { name: ex.displayName, ...sideWords(session.side) });
  $("ex-cue").textContent = t("patient.cue.full", { cue: ex.cueFor(session.side), facing: facingText(ex),
                                                    lo: ex.target[0], hi: ex.target[1] });
  latest = null;
  updateReadout();
}

function warningState() {
  if (sourceError) return [sourceError, "bad"];
  if (!latest) return [t("warning.waiting_camera"), "muted"];
  const parts = [];
  let level = "ok";
  if (!latest.pose) {
    parts.push(t("warning.no_person"));
    level = "bad";
  } else if (!latest.confident) {
    parts.push(cap(latest.reason) || t("warning.low_confidence"));
    level = "bad";
  }
  if (latest.hint) {
    parts.push(latest.hint);
    if (level === "ok") level = "warn";
  }
  if (session.measuredLimbFar()) {
    const limb = session.ex.jointNames[1] === "knee" ? "leg" : "arm";
    parts.push(t(`warning.far_limb.${limb}`, sideWords(session.side)));
    if (level === "ok") level = "warn";
  }
  if (!parts.length) return [`✓  ${t("warning.tracking_ok")}`, "ok"];
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
  setText(next, t(session.isLast() ? "patient.button.finish" : "patient.button.next"));
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

// The session so far, kept on the phone: after every repetition, and whenever
// the page goes out of sight, which may be the last this page ever hears.
function keepDraft() {
  if (session?.state === "running" && session.hasData()) {
    store.saveDraft(session.programme.patient, session.result(null));
  }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && page === "exercise") keepDraft();
});

function announceRep(rep) {
  keepDraft();
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
  $("sound").textContent = t(on ? "patient.sound.on" : "patient.sound.off");
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
  $("effort").replaceChildren(...EFFORTS.map((e) => choice(t(`effort.${e.replace(/ /g, "_")}`), "effort")));
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
  if (ok) store.clearDraft();       // the finished session replaces the draft
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
  if (f?.pain != null) parts.push(t("feedback.pain", { n: f.pain }));
  if (f?.effort) parts.push(t("feedback.effort", { effort: t(`effort.${f.effort.replace(/ /g, "_")}`).toLowerCase() }));
  return parts.join(", ") || t("feedback.none");
}

function showSummary(feedback, saved) {
  const lines = session.summary();
  const complete = lines.every((l) => l.done);
  $("done-title").textContent = t(complete ? "patient.done.well" : saved ? "patient.done.saved"
                                             : "patient.done.nothing");
  $("done-list").replaceChildren(...lines.map((l) => {
    const li = document.createElement("li");
    li.textContent = t("patient.done.line", { name: l.name, done: l.reps, total: l.total })
                     + (l.done ? " ✓" : "");
    li.className = l.done ? "done" : "";
    return li;
  }));
  $("done-text").textContent = !saved
    ? t(session.hasData() ? "patient.done.save_failed" : "patient.done.nothing_measured")
    : (feedback ? t("patient.done.you_said", { feedback: describeFeedback(feedback) }) : "")
      + t("patient.done.send_later");
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
  const batches = store.batchesFor(p.patient);
  const canvas = $("qr");
  const partText = $("send-part");
  const batchText = $("send-batch");
  const nextBtn = $("send-next");
  if (!batches.length) {
    canvas.hidden = true;
    batchText.hidden = nextBtn.hidden = true;
    partText.textContent = t("patient.send.none");
    return;
  }
  canvas.hidden = false;
  keepAwake(true);
  let timer = null;
  leaving.push(() => { clearInterval(timer); keepAwake(false); });

  // More sessions than one transfer carries go in several; the clinic computer
  // reads one, saves it, and reads the next.
  const showBatch = async (b) => {
    clearInterval(timer);
    const sessions = batches[b];
    batchText.hidden = batches.length < 2;
    batchText.textContent = t("patient.send.batch", { n: b + 1, total: batches.length });
    nextBtn.hidden = batches.length < 2;
    nextBtn.textContent = t(b + 1 < batches.length ? "patient.send.next" : "patient.send.first");
    nextBtn.onclick = () => showBatch((b + 1) % batches.length);
    let parts;
    try {
      // A version 2 programme names the clinic's public key: seal for it and sign
      // as this phone. A programme scanned before that still carries a shared key.
      parts = p.clinicKey
        ? await encodeResultsV2(p.patient, p.clinicKey, await store.phoneKey(), sessions)
        : await encodeResults(p.patient, p.key, sessions);
    } catch (e) {
      partText.textContent = t("patient.send.failed", { message: e.message });
      return;
    }
    let i = 0;
    const step = () => {
      drawQr(canvas, parts[i]);
      partText.textContent = t("patient.send.part", { sessions: sessionsWord(sessions.length),
                                                      n: i + 1, total: parts.length });
      i = (i + 1) % parts.length;
    };
    step();
    timer = setInterval(step, SEND_PART_MS);
  };
  await showBatch(0);
}

// ----- start ----------------------------------------------------------------------

if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
await applyLanguage();               // nothing is shown before the messages are in

// What the QR exchange needs from the browser. Without the compression streams
// (Safari before iOS 16.4) every scan failed with an engine error that read like
// a bad scan, so the patient kept moving closer. Better to say it once, plainly.
const missing = ["CompressionStream", "DecompressionStream"].filter((name) => !(name in window));
if (!window.crypto?.subtle) missing.push("crypto.subtle");

if (missing.length) {
  show("unsupported");
  $("unsupported-text").textContent = t("patient.unsupported.body", { missing: missing.join(", ") });
} else {
  store.recoverDraft();              // a session the page was closed in the middle of
  installAdvice();
  store.loadProgramme() ? renderHome() : show("welcome");
}

// For the development page and tests: the state, read-only in spirit.
window.kinemaloom = { get session() { return session; }, get latest() { return latest; }, store };
