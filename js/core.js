// KinemaLoom measuring core for the phone: a line-by-line port of motionloom_core.py.
//
// The Python module is the reference. test/core.test.mjs replays the inputs in
// test/core_fixture.json (written by the Python core) and requires the same
// outputs, so a change on either side that is not made on both fails the tests.
// Comments explaining why each rule exists live in the Python original.

// ----- small Python-compatible helpers -------------------------------------

// Python formats "{:.0f}" with round-half-to-even; Math.round rounds halves up.
export function fmt0(x) {
  const r = Math.round(x);
  const halfway = Math.abs(x - Math.trunc(x)) === 0.5;
  return String(halfway && r % 2 !== 0 ? r - 1 : r);   // Math.round rounds halves up
}

// str(float) in Python: 100.0 prints as "100.0".
function pyFloat(x) {
  return Number.isInteger(x) ? x.toFixed(1) : String(x);
}

const hypot = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

function median(values) {
  const v = [...values].sort((p, q) => p - q);
  const n = v.length;
  const mid = Math.floor(n / 2);
  return n % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

// ----- exercises --------------------------------------------------------------

export const SIDES = ["left", "right"];
export const JOINTS = {
  shoulder: [11, 12], elbow: [13, 14], wrist: [15, 16],
  hip: [23, 24], knee: [25, 26], ankle: [27, 28],
};
export const MIN_CONFIDENCE = 0.55;
export const TRACE_SAMPLES = 300;

export class Exercise {
  constructor({ name, jointNames, target, downBelow, upAbove, cue, minSpan = 0.18,
                minPlausible = 0.0 }) {
    Object.assign(this, { name, jointNames, target: [...target], downBelow, upAbove, cue,
                          minSpan, minPlausible });
  }

  resolve(side) {
    const s = SIDES.indexOf(side);
    return this.jointNames.map((n) => JOINTS[n][s]);
  }

  measuredJoint(side) {
    return `${side} ${this.jointNames[1]}`;
  }

  get decreasing() {
    return this.downBelow > this.upAbove;
  }

  withTarget(lo, hi) {
    if (!(lo >= 0 && lo < hi && hi <= 180)) {
      throw new RangeError(`target range must satisfy 0 <= lo < hi <= 180, got ${pyFloat(lo)}-${pyFloat(hi)}`);
    }
    const oldEdge = this.decreasing ? this.target[1] : this.target[0];
    const newEdge = this.decreasing ? hi : lo;
    const up = this.upAbove + (newEdge - oldEdge);
    let down = this.downBelow;
    if (this.decreasing) down = Math.min(180, Math.max(down, up + 20));
    else down = Math.max(0, Math.min(down, up - 20));
    if (Math.abs(down - up) < 20) {
      const edge = this.decreasing ? "top" : "bottom";
      throw new RangeError(`the ${edge} of the range is too close to the end of the scale `
                           + "to count repetitions reliably");
    }
    return new Exercise({ ...this, target: [lo, hi], upAbove: up, downBelow: down });
  }

  get isDefault() {
    const base = EXERCISES.find((e) => e.name === this.name);
    return !!base && base.target[0] === this.target[0] && base.target[1] === this.target[1];
  }

  cueFor(side = null) {
    return this.cue.replace("{limb}", side ? `your ${side}` : "the measured");
  }

  plausible(angle) {
    return angle >= this.minPlausible;
  }

  rate(peak) {
    const [lo, hi] = this.target;
    if (lo <= peak && peak <= hi) return "in target";
    const past = this.decreasing ? peak < lo : peak > hi;
    return past ? "past target" : "short of target";
  }
}

export const EXERCISES = [
  new Exercise({ name: "Shoulder abduction", jointNames: ["hip", "shoulder", "elbow"],
                 target: [80, 170], downBelow: 40, upAbove: 80,
                 cue: "Face the camera, raise {limb} arm sideways, elbow straight", minSpan: 0.18 }),
  new Exercise({ name: "Elbow flexion", jointNames: ["shoulder", "elbow", "wrist"],
                 target: [40, 90], downBelow: 150, upAbove: 90,
                 cue: "Stand side-on with {limb} arm nearest the camera; bend the elbow, upper arm still",
                 minSpan: 0.14, minPlausible: 25 }),
  new Exercise({ name: "Knee flexion", jointNames: ["hip", "knee", "ankle"],
                 target: [60, 130], downBelow: 160, upAbove: 120,
                 cue: "Stand side-on with {limb} leg nearest the camera; bend the knee back",
                 minSpan: 0.22, minPlausible: 25 }),
];

export const exerciseByName = (name) => EXERCISES.find((e) => e.name === name);

// ----- measurement ----------------------------------------------------------------

export function angle3pt(a, b, c) {
  const v1 = [a[0] - b[0], a[1] - b[1]];
  const v2 = [c[0] - b[0], c[1] - b[1]];
  const n1 = Math.hypot(...v1);
  const n2 = Math.hypot(...v2);
  if (n1 === 0 || n2 === 0) return null;
  let cosine = (v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2);
  cosine = Math.max(-1, Math.min(1, cosine));
  return (Math.acos(cosine) * 180) / Math.PI;
}

export class AngleSmoother {
  constructor(window = 5, minCount = 3) {
    this.window = window;
    this.minCount = minCount;
    this.values = [];
  }
  reset() { this.values = []; }
  update(angle) {
    if (angle === null || angle === undefined) {
      this.values = [];
      return null;
    }
    this.values.push(angle);
    if (this.values.length > this.window) this.values.shift();
    if (this.values.length < this.minCount) return null;
    return median(this.values);
  }
}

export class SegmentCheck {
  static MIN_PROXIMAL = 0.70;
  static MIN_DISTAL = 0.55;
  static MAX_RATIO = 1.45;

  constructor(window = 60, minSamples = 10) {
    this.window = window;
    this.minSamples = minSamples;
    this.reset();
  }
  reset() { this.proximal = []; this.distal = []; }
  ready() { return this.proximal.length >= this.minSamples; }

  update(points, angle, ex) {
    const [a, b, c] = points;
    const prox = hypot(a, b);
    const dist = hypot(b, c);
    const atStart = ex.decreasing ? angle > ex.downBelow : angle < ex.downBelow;
    let ok = true;
    let reason = "";
    if (this.ready()) {
      const rp = prox / Math.max(median(this.proximal), 1e-6);
      const rd = dist / Math.max(median(this.distal), 1e-6);
      const short = rp < SegmentCheck.MIN_PROXIMAL || rd < SegmentCheck.MIN_DISTAL;
      if (short || Math.max(rp, rd) > SegmentCheck.MAX_RATIO) {
        ok = false;
        const advice = ex.jointNames[1] === "shoulder" ? "face the camera squarely" : "turn fully side-on";
        reason = `${ex.jointNames[1]} position uncertain – limb looks `
                 + `${short ? "shortened" : "stretched"}; ${advice}`;
      }
    }
    if (atStart && ok) {
      this.proximal.push(prox);
      this.distal.push(dist);
      if (this.proximal.length > this.window) this.proximal.shift();
      if (this.distal.length > this.window) this.distal.shift();
    }
    return [ok, reason];
  }
}

export class FramePipeline {
  constructor() {
    this.segments = new SegmentCheck();
    this.smoother = new AngleSmoother();
  }
  reset() { this.segments.reset(); this.smoother.reset(); }

  // points: [a, vertex, c] in pixels or null. Returns [smoothed or null, confident, reason].
  step(ex, points, angle, confident, reason = "") {
    if (confident && points && angle !== null && angle !== undefined) {
      const [ok, why] = this.segments.update(points, angle, ex);
      if (!ok) {
        confident = false;
        reason = why;
      } else if (!ex.plausible(angle)) {
        confident = false;
        const j = ex.jointNames[1];
        reason = `${j} angle ${fmt0(angle)}° is not physically possible – check the view of the ${j}`;
      }
    }
    const smoothed = this.smoother.update(confident ? angle : null);
    return [smoothed, confident, reason];
  }
}

export class RepCounter {
  constructor(ex) {
    this.ex = ex;
    this.decreasing = ex.decreasing;
    this.reset();
  }
  reset() {
    this.reps = 0;
    this.state = "ready";
    this.best = null;
    this.inTarget = 0;
    this.samples = 0;
    this.repPeaks = [];
    this._peak = null;
  }
  get peaks() { return this._peak === null ? [...this.repPeaks] : [...this.repPeaks, this._peak]; }
  get phase() {
    if (this.state === "ready") return "ready";
    return this.state === "flexed" || this.state === "high" ? "working" : "start";
  }
  get currentPeak() { return this._peak; }
  repsInTarget(includeCurrent = false) {
    const peaks = includeCurrent ? this.peaks : this.repPeaks;
    return peaks.filter((p) => this.ex.rate(p) === "in target").length;
  }
  _further(a, b) { return this.decreasing ? Math.min(a, b) : Math.max(a, b); }

  update(angle) {
    if (angle === null || angle === undefined) return;
    this.samples += 1;
    const [lo, hi] = this.ex.target;
    if (lo <= angle && angle <= hi) this.inTarget += 1;
    this.best = this.best === null ? angle : this._further(this.best, angle);

    let start, working, leftStart, backAtStart;
    if (this.decreasing) {
      [start, working] = ["extended", "flexed"];
      leftStart = angle < this.ex.upAbove;
      backAtStart = angle > this.ex.downBelow;
    } else {
      [start, working] = ["low", "high"];
      leftStart = angle > this.ex.upAbove;
      backAtStart = angle < this.ex.downBelow;
    }
    if (this.state === "ready" && backAtStart) {
      this.state = start;
    } else if (this.state === start && leftStart) {
      this.state = working;
      this.reps += 1;
      this._peak = angle;
    } else if (this.state === working) {
      if (backAtStart) {
        this.state = start;
        this.repPeaks.push(this._peak);
        this._peak = null;
      } else {
        this._peak = this._further(this._peak, angle);
      }
    }
  }

  get inTargetPct() { return this.samples === 0 ? 0 : (100 * this.inTarget) / this.samples; }
}

// ----- guidance ---------------------------------------------------------------------

// landmarks: [{x, y, visibility, presence}] as the pose model returns them.
export function landmarkConfidence(landmarks, indices, names = null) {
  let worstConf = 1.0;
  let worstName = "";
  let worstReason = "";
  indices.forEach((i, pos) => {
    const lm = landmarks[i];
    const v = lm.visibility || 0;
    const p = lm.presence || 0;
    const inside = Number.isFinite(lm.x) && Number.isFinite(lm.y)
      && lm.x >= -0.02 && lm.x <= 1.02 && lm.y >= -0.02 && lm.y <= 1.02;
    const scores = [v, p].filter((x) => x);
    let conf, reason;
    if (!inside) [conf, reason] = [0, "out of frame"];
    else if (!scores.length) [conf, reason] = [0.5, "confidence unavailable"];
    else [conf, reason] = [Math.min(...scores), "not clearly visible"];
    if (conf < worstConf) {
      worstConf = conf;
      worstName = names ? names[pos] : String(i);
      worstReason = reason;
    }
  });
  return [worstConf, worstName ? `${worstName} ${worstReason}` : ""];
}

export function framingHint(points, ex, frameH) {
  if (!points || frameH <= 0) return "";
  const [a, b, c] = points;
  const ratio = (hypot(a, b) + hypot(b, c)) / frameH;
  if (ratio < ex.minSpan * 0.75) return "Too far away - move closer to the camera";
  if (ratio < ex.minSpan) return "A little far - move closer for a steadier reading";
  if (ratio > ex.minSpan * 3.0) return "Too close - step back so the whole movement fits";
  return "";
}
