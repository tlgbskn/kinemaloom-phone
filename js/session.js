// One home session on the phone: the programme worked through exercise by
// exercise, with sets, rests and the count. No screen and no camera here, so
// the rules can be tested in Node; app.js feeds it measurements and draws it.
//
// It follows motionloom_patient.py (PatientWindow) and the parts of
// MainWindow.on_measured it inherits: the same pipeline per frame, counting
// only while running and not resting, a set closing when its last repetition
// returns to the start, and the same saved figures.

import { exerciseByName, FramePipeline, RepCounter } from "./core.js";
import { compactSession } from "./exchange.js";

export const FAR_MARGIN = 0.03;   // relative depth by which the measured limb counts as the farther
const FAR_WINDOW = 30;

// A decoded programme (exchange.decodeProgramme) as items with their exercise
// definitions, the patient's own range applied. Unknown exercises are dropped.
export function programmeItems(programme) {
  const items = [];
  for (const it of programme.items) {
    const base = exerciseByName(it.exercise);
    if (!base) continue;
    const [lo, hi] = it.target;
    let ex = base;
    if (base.target[0] !== lo || base.target[1] !== hi) {
      try {
        ex = base.withTarget(lo, hi);
      } catch {
        ex = base;                 // a range the counter cannot use: the built-in one
      }
    }
    items.push({ ex, side: it.side, reps: Math.max(1, it.reps), sets: Math.max(1, it.sets || 1),
                 rest: Math.max(0, it.rest ?? 30) });
  }
  return items;
}

export class HomeSession {
  constructor(programme, { now = () => Date.now(), model = "full" } = {}) {
    this.programme = programme;
    this.items = programmeItems(programme);
    this.now = now;
    this.model = model;
    this.state = "idle";           // idle, running, ended
    this.counters = new Map();
    this.pipeline = new FramePipeline();
    this.farVotes = [];
    this.startedAt = null;
    this.endedAt = null;
    this.repDoneAt = null;
    this.select(0);
  }

  // ----- the programme ------------------------------------------------------

  item() { return this.items[this.itemIndex] || null; }
  get ex() { return this.item().ex; }
  get side() { return this.item().side; }
  static total(item) { return item.reps * item.sets; }
  isLast() { return this.itemIndex + 1 >= this.items.length; }

  counter(item = this.item()) {
    const key = `${item.ex.name} (${item.side})`;
    if (!this.counters.has(key)) this.counters.set(key, new RepCounter(item.ex));
    return this.counters.get(key);
  }

  itemDone(item = this.item()) {
    return this.counter(item).reps >= HomeSession.total(item);
  }

  select(i) {
    this.itemIndex = i;
    this.setNo = 1;
    this.restUntil = null;
    this.pipeline.reset();         // a new limb: its own segment lengths and smoothing
    this.farVotes = [];
  }

  // Returns false when there is no next exercise.
  next() {
    if (this.isLast()) return false;
    this.select(this.itemIndex + 1);
    return true;
  }

  // ----- sets and rest ------------------------------------------------------

  resting() { return this.restUntil !== null; }

  restLeft() {
    return this.resting() ? Math.max(0, Math.round((this.restUntil - this.now()) / 1000)) : 0;
  }

  endRest() {
    if (!this.resting()) return false;
    this.restUntil = null;
    this.setNo += 1;
    return true;
  }

  // Call regularly; true when a rest has just run out.
  tick() {
    return this.resting() && this.now() >= this.restUntil && this.endRest();
  }

  // ----- measuring ---------------------------------------------------------

  start() {
    this.counters.clear();
    this.pipeline.reset();
    this.startedAt = this.now();
    this.endedAt = null;
    this.repDoneAt = null;
    this.state = "running";
  }

  // m: {pose, points (pixels) or null, angle or null, confident, reason, depthGap}
  // Returns {angle (smoothed, or raw while the smoother fills), confident, reason,
  //          inTarget, rep: {peak, rating} when a repetition just ended}.
  measure(m) {
    const ex = this.ex;
    if (m.pose && m.depthGap != null && ex.jointNames[1] !== "shoulder") {
      this.farVotes.push(m.depthGap > FAR_MARGIN);
      if (this.farVotes.length > FAR_WINDOW) this.farVotes.shift();
    }
    const [smoothed, confident, reason] = this.pipeline.step(
      ex, m.points, m.angle, !!(m.pose && m.confident), m.reason || "");
    let rep = null;
    if (smoothed !== null && this.state === "running" && !this.resting()) {
      const counter = this.counter();
      const completed = counter.repPeaks.length;
      counter.update(smoothed);
      if (counter.repPeaks.length > completed) rep = this.repEnded(counter);
    }
    const angle = smoothed ?? m.angle;
    return { angle, confident, reason, rep,
             inTarget: angle == null ? null : ex.target[0] <= angle && angle <= ex.target[1] };
  }

  // A repetition finished. If it closed a set, rest before the next one. The set
  // ends when its last repetition returns to the start, not when it is counted,
  // so that repetition is never cut off halfway.
  repEnded(counter) {
    this.repDoneAt = this.now();
    const peak = counter.repPeaks[counter.repPeaks.length - 1];
    const item = this.item();
    if (counter.reps >= this.setNo * item.reps && counter.reps < HomeSession.total(item)) {
      if (item.rest > 0) this.restUntil = this.now() + item.rest * 1000;
      else this.setNo += 1;
    }
    return { peak, rating: this.ex.rate(peak) };
  }

  // The measured limb has been the farther one for most of the last second.
  measuredLimbFar() {
    const v = this.farVotes;
    return v.length >= 20 && v.filter(Boolean).length / v.length >= 0.7;
  }

  // ----- what the screen shows ----------------------------------------------

  // The big count and the line under it.
  countText() {
    const item = this.item();
    const counter = this.counter();
    if (this.resting()) {
      return { big: `Rest ${this.restLeft()}s`,
               sub: `Set ${this.setNo} of ${item.sets} done, then set ${this.setNo + 1} of ${item.sets}` };
    }
    const inSet = counter.reps - (this.setNo - 1) * item.reps;
    const head = this.itemDone() ? "Done – well done!"
      : item.sets > 1 ? `Set ${this.setNo} of ${item.sets}` : "repetitions";
    return { big: `${Math.min(Math.max(inSet, 0), item.reps)} / ${item.reps}`,
             sub: `${head} · ${counter.repsInTarget()} ended in your target range` };
  }

  // Where the repetition stands and what to do next, as in the desktop's
  // show_rep_status: [main line, hint, level ("in", "off" or "none")].
  repStatus(verdictMs = 3000) {
    const ex = this.ex;
    const counter = this.counter();
    if (this.resting()) {
      return [`Rest – ${this.restLeft()} s`,
              `Counting is paused. Set ${this.setNo + 1} of ${this.item().sets} starts after the rest.`, "none"];
    }
    const r = (x) => Math.round(x);
    const [go, back, reach] = ex.decreasing
      ? [`bend below ${r(ex.upAbove)}°`, `straighten past ${r(ex.downBelow)}°`, "deepest"]
      : [`raise above ${r(ex.upAbove)}°`, `lower below ${r(ex.downBelow)}°`, "highest"];
    const cap = (s) => s[0].toUpperCase() + s.slice(1);
    const level = (p) => (ex.rate(p) === "in target" ? "in" : "off");
    const last = counter.repPeaks.length ? counter.repPeaks[counter.repPeaks.length - 1] : null;
    const verdict = (n, p) => `Rep ${n} · ${r(p)}° · ${ex.rate(p)}`;
    if (this.state === "idle") return ["Ready when you are", "Press Start when you are in position", "none"];
    if (this.state === "ended") {
      return [last === null ? "Session ended" : `Last: ${verdict(counter.repPeaks.length, last)}`, "", "none"];
    }
    if (counter.phase === "ready") return ["Get into the starting position", `${cap(back)} to begin`, "none"];
    if (counter.phase === "working") {
      const p = counter.currentPeak;
      const rating = ex.rate(p);
      return [`Rep ${counter.reps} · ${reach} ${r(p)}° · `
              + (rating === "in target" ? "in target so far" : rating), `${cap(back)} to finish`, level(p)];
    }
    if (last !== null && this.repDoneAt !== null && this.now() - this.repDoneAt < verdictMs) {
      return [verdict(counter.repPeaks.length, last), `Next: ${go}`, level(last)];
    }
    return [`Ready for rep ${counter.reps + 1}`, `${cap(go)} to count it`, "none"];
  }

  // ----- finishing ------------------------------------------------------------

  hasData() {
    return [...this.counters.values()].some((c) => c.samples > 0);
  }

  finish() {
    if (this.state === "running") {
      this.state = "ended";
      this.endedAt = this.now();
      this.restUntil = null;
    }
    return this.hasData();
  }

  // The session in the form the results QR carries. feedback: {pain, effort} or null.
  result(feedback = null) {
    const prescribed = new Map(this.items.map((it) => [`${it.ex.name} (${it.side})`, HomeSession.total(it)]));
    const exercises = [];
    for (const [key, c] of this.counters) {
      if (c.samples === 0) continue;
      const side = key.slice(key.lastIndexOf("(") + 1, -1);
      exercises.push({ exercise: c.ex.name, side, reps: c.reps, prescribed: prescribed.get(key) ?? null,
                       repsInTarget: c.repsInTarget(true), furthest: c.best, inTargetPct: c.inTargetPct,
                       target: c.ex.target, peaks: c.peaks });
    }
    return compactSession({ started: this.startedAt, duration: ((this.endedAt ?? this.now()) - this.startedAt) / 1000,
                            model: this.model, feedback, exercises });
  }

  // For the done screen: one line per exercise in the programme.
  summary() {
    return this.items.map((it) => {
      const reps = this.counter(it).reps;
      const total = HomeSession.total(it);
      return { name: `${it.ex.name} (${it.side})`, reps: Math.min(reps, total), total, done: reps >= total };
    });
  }
}
