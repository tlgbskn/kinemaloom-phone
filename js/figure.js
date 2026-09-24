// How to do the movement: a figure doing it, with the prescribed range.
// A canvas port of ExerciseAnimation in motionloom_qt.py; the geometry is the
// same, in the same 200 x 230 model space.

import { t } from "./i18n.js?v=f658e47a3e";

export const COLOURS = {
  bg: "#1e2020", fg: "#e8eeee", muted: "#909696", ok: "#78be6e", tile: "#292c2c", edge: "#424646",
};

const CYCLE = 3.6;                 // seconds for out, hold, back, rest

function currentAngle(ex, seconds) {
  const [lo, hi] = ex.target;
  const goal = (lo + hi) / 2;
  const rest = ex.decreasing ? 170 : 15;
  const f = (seconds % CYCLE) / CYCLE;
  let u = f < 0.35 ? f / 0.35 : f < 0.5 ? 1 : f < 0.85 ? 1 - (f - 0.5) / 0.35 : 0;
  u = 0.5 - 0.5 * Math.cos(Math.PI * u);
  return rest + (goal - rest) * u;
}

const frontView = (ex) => ex.jointNames[1] === "shoulder";

// [grey segments, [reference, vertex, moving], extra measured segment or null]
function pose(ex, side, a) {
  const r = (a * Math.PI) / 180;
  const grey = [];
  if (frontView(ex)) {
    const s = side === "right" ? 1 : -1;
    grey.push([[100, 48], [100, 130]], [[78, 58], [122, 58]], [[88, 130], [112, 130]],
              [[90, 130], [87, 180]], [[87, 180], [85, 225]], [[110, 130], [113, 180]], [[113, 180], [115, 225]]);
    const other = [100 - 22 * s, 58];
    grey.push([other, [other[0] - 3 * s, 106]], [[other[0] - 3 * s, 106], [other[0] - 4 * s, 150]]);
    const shoulder = [100 + 22 * s, 58];
    const hip = [100 + 12 * s, 130];
    const d = [s * Math.sin(r), Math.cos(r)];
    const elbow = [shoulder[0] + 48 * d[0], shoulder[1] + 48 * d[1]];
    const wrist = [shoulder[0] + 92 * d[0], shoulder[1] + 92 * d[1]];
    return [grey, [hip, shoulder, elbow], [elbow, wrist]];
  }
  const f = side === "right" ? -1 : 1;
  grey.push([[100, 48], [100, 130]]);
  if (ex.jointNames[1] === "elbow") {
    grey.push([[100, 130], [100, 180]], [[100, 180], [100, 225]], [[100, 225], [100 + 14 * f, 225]]);
    const shoulder = [100, 60];
    const elbow = [100 + 2 * f, 110];
    const d = [f * Math.sin(r), -Math.cos(r)];
    return [grey, [shoulder, elbow, [elbow[0] + 44 * d[0], elbow[1] + 44 * d[1]]], null];
  }
  grey.push([[100, 60], [102 + 2 * f, 110]], [[102 + 2 * f, 110], [103 + 3 * f, 150]],
            [[97, 130], [97, 180]], [[97, 180], [97, 225]], [[97, 225], [97 + 14 * f, 225]]);
  const hip = [103, 130];
  const knee = [103, 180];
  const d = [-f * Math.sin(r), -Math.cos(r)];
  return [grey, [hip, knee, [knee[0] + 45 * d[0], knee[1] + 45 * d[1]]], null];
}

// Draws into a canvas already scaled to CSS pixels (w x h).
export function drawFigure(ctx, w, h, ex, side, seconds) {
  ctx.clearRect(0, 0, w, h);
  if (!ex) return;
  const topRoom = frontView(ex) ? 38 : 4;
  const k = Math.min((w - 16) / 240, (h - 8) / (231 + topRoom));
  const ox = w / 2 - 100 * k;
  const oy = 4 + topRoom * k;
  const P = ([x, y]) => [ox + x * k, oy + y * k];

  const a = currentAngle(ex, seconds);
  const [lo, hi] = ex.target;
  const inside = lo <= a && a <= hi;
  const [grey, [ref, vertex, moving], extra] = pose(ex, side, a);
  const [, [, , mLo]] = pose(ex, side, lo);
  const [, [, , mHi]] = pose(ex, side, hi);
  const screenAngle = (pt) => Math.atan2(pt[1] - vertex[1], pt[0] - vertex[0]);
  const V = P(vertex);

  // the prescribed range as a wedge at the joint
  const aLo = screenAngle(mLo);
  let sweep = screenAngle(mHi) - aLo;
  sweep = ((sweep + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
  ctx.fillStyle = "rgba(120, 190, 110, 0.3)";
  ctx.beginPath();
  ctx.moveTo(...V);
  ctx.arc(V[0], V[1], 30 * k, aLo, aLo + sweep, sweep < 0);
  ctx.closePath();
  ctx.fill();

  ctx.lineCap = "round";
  ctx.strokeStyle = COLOURS.muted;
  ctx.lineWidth = Math.max(2, 3.2 * k);
  const headX = frontView(ex) ? 100 : 100 + 4 * (side === "right" ? -1 : 1);
  ctx.beginPath();
  ctx.arc(...P([headX, 30]), 15 * k, 0, 2 * Math.PI);
  ctx.stroke();
  const line = (p, q) => { ctx.beginPath(); ctx.moveTo(...P(p)); ctx.lineTo(...P(q)); ctx.stroke(); };
  grey.forEach(([p, q]) => line(p, q));

  const col = inside ? COLOURS.ok : COLOURS.fg;
  ctx.strokeStyle = col;
  ctx.lineWidth = Math.max(2.5, 4.2 * k);
  line(ref, vertex);
  line(vertex, moving);
  if (extra) line(...extra);
  ctx.fillStyle = col;
  for (const [pt, size] of [[ref, 3.5], [vertex, 5], [moving, 3.5]]) {
    ctx.beginPath();
    ctx.arc(...P(pt), size * k + 1, 0, 2 * Math.PI);
    ctx.fill();
  }

  // the current angle as a number beside the joint
  const aRef = screenAngle(ref);
  let span = screenAngle(moving) - aRef;
  span = ((span + 3 * Math.PI) % (2 * Math.PI)) - Math.PI;
  let mid = aRef + span / 2;
  if (Math.abs(span) < Math.PI / 4) mid += Math.sign(span) * (Math.PI / 3);
  ctx.font = `600 ${Math.max(11, 13 * k)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(`${Math.round(a)}°`, V[0] + (42 * k) * Math.cos(mid), V[1] + (42 * k) * Math.sin(mid));
}

export const facingText = (ex) => t(frontView(ex) ? "patient.facing.front" : "patient.facing.side");
