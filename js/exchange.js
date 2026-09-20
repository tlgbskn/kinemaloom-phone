// KinemaLoom exchange between the clinic computer and the patient's phone.
//
// The format is specified in the docstring of motionloom_exchange.py; this is
// the phone's side of it. test/exchange.test.mjs checks it against
// exchange_test_vectors.json and against the Python module itself.
//
// Works in browsers and in Node 18+: WebCrypto for AES-GCM, and
// CompressionStream("deflate"), which is the zlib format Python uses.

export const VERSION = 1;
export const PROGRAMME_PREFIX = "KLP1";
export const RESULTS_PREFIX = "KLR1";
export const CHUNK_BYTES = 180;
export const B45 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:";

export const EXERCISE_CODES = { "Shoulder abduction": "SA", "Elbow flexion": "EF", "Knee flexion": "KF" };
export const SIDE_CODES = { left: "L", right: "R" };
export const EFFORT_CODES = { easy: "E", "about right": "A", hard: "H" };
const invert = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [v, k]));
export const CODE_EXERCISES = invert(EXERCISE_CODES);
export const CODE_SIDES = invert(SIDE_CODES);
export const CODE_EFFORTS = invert(EFFORT_CODES);

export class ExchangeError extends Error {}

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder("utf-8", { fatal: true });

// ----- Base45 (RFC 9285) ------------------------------------------------

export function b45encode(data) {
  let out = "";
  for (let i = 0; i + 1 < data.length; i += 2) {
    let n = data[i] * 256 + data[i + 1];
    const e = Math.floor(n / 2025);
    n %= 2025;
    out += B45[n % 45] + B45[Math.floor(n / 45)] + B45[e];
  }
  if (data.length % 2) {
    const n = data[data.length - 1];
    out += B45[n % 45] + B45[Math.floor(n / 45)];
  }
  return out;
}

export function b45decode(text) {
  const values = [...text].map((ch) => B45.indexOf(ch));
  if (values.includes(-1)) throw new ExchangeError("not Base45 text");
  const out = [];
  for (let i = 0; i < values.length; i += 3) {
    const chunk = values.slice(i, i + 3);
    if (chunk.length === 3) {
      const n = chunk[0] + chunk[1] * 45 + chunk[2] * 2025;
      if (n > 0xffff) throw new ExchangeError("not Base45 text");
      out.push(n >> 8, n & 0xff);
    } else if (chunk.length === 2) {
      const n = chunk[0] + chunk[1] * 45;
      if (n > 0xff) throw new ExchangeError("not Base45 text");
      out.push(n);
    } else {
      throw new ExchangeError("not Base45 text");
    }
  }
  return Uint8Array.from(out);
}

// ----- compression, keys ----------------------------------------------------

async function through(stream, data) {
  const piped = new Blob([data]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(piped).arrayBuffer());
}

async function pack(obj) {
  return through(new CompressionStream("deflate"), utf8.encode(JSON.stringify(obj)));
}

async function unpack(data) {
  try {
    return JSON.parse(fromUtf8.decode(await through(new DecompressionStream("deflate"), data)));
  } catch {
    throw new ExchangeError("damaged data");
  }
}

function keyBytes(key) {
  let raw;
  try {
    const b64 = key.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (key.length % 4)) % 4);
    raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch {
    throw new ExchangeError("bad key");
  }
  if (raw.length !== 16) throw new ExchangeError("bad key");
  return raw;
}

async function aes(key) {
  return crypto.subtle.importKey("raw", keyBytes(key), "AES-GCM", false, ["encrypt", "decrypt"]);
}

const associated = (code) => utf8.encode(`${RESULTS_PREFIX}|${code}`);

// Python's round(): halves go to the even neighbour.
export function pyRound(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

// ----- Programme: clinic -> phone ------------------------------------------

export async function decodeProgramme(text) {
  text = (text || "").trim();
  if (!text.startsWith(PROGRAMME_PREFIX)) throw new ExchangeError("not a KinemaLoom programme");
  const p = await unpack(b45decode(text.slice(PROGRAMME_PREFIX.length)));
  if (p.v !== VERSION) throw new ExchangeError(`programme format version ${p.v} is not supported`);
  const items = p.i.map(([ex, side, reps, sets, rest, lo, hi]) => {
    if (!(ex in CODE_EXERCISES) || !(side in CODE_SIDES)) throw new ExchangeError("damaged data");
    return { exercise: CODE_EXERCISES[ex], side: CODE_SIDES[side], reps, sets, rest, target: [lo, hi] };
  });
  keyBytes(p.k);
  return { patient: p.p, clinician: p.c, issued: p.d, key: p.k, language: p.l || "en", items };
}

// The clinic computer makes programmes; this exists for tests and demonstrations.
export async function encodeProgramme(code, clinician, key, items, ranges, issued, language) {
  const rows = items.map((it) => {
    const [lo, hi] = ranges[it.exercise];
    return [EXERCISE_CODES[it.exercise], SIDE_CODES[it.side], it.reps, it.sets ?? 1, it.rest ?? 30,
            pyRound(lo), pyRound(hi)];
  });
  const payload = { v: VERSION, p: code, c: clinician || "", d: issued, k: key, i: rows };
  if (language && language !== "en") payload.l = language;   // English is the fallback
  return PROGRAMME_PREFIX + b45encode(await pack(payload));
}

// ----- Results: phone -> clinic ------------------------------------------

// sessions: compact sessions (see compactSession). Returns the QR texts to cycle through.
// msgId and nonce are for tests only; left out, they are random.
export async function encodeResults(code, key, sessions, { chunk = CHUNK_BYTES, msgId, nonce } = {}) {
  const codeBytes = utf8.encode(code);
  if (!(codeBytes.length > 0 && codeBytes.length < 256)) throw new ExchangeError("patient code too long");
  nonce = nonce || crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: associated(code) }, await aes(key),
    await pack({ v: VERSION, s: sessions })));
  const blob = new Uint8Array(1 + codeBytes.length + 12 + sealed.length);
  blob[0] = codeBytes.length;
  blob.set(codeBytes, 1);
  blob.set(nonce, 1 + codeBytes.length);
  blob.set(sealed, 13 + codeBytes.length);
  const total = Math.ceil(blob.length / chunk);
  if (total > 99) throw new ExchangeError("too many sessions for one transfer");
  const msg = msgId ?? crypto.getRandomValues(new Uint16Array(1))[0];
  const head = (i) => RESULTS_PREFIX + msg.toString(16).toUpperCase().padStart(4, "0")
    + String(i).padStart(2, "0") + String(total).padStart(2, "0");
  const parts = [];
  for (let i = 0; i < total; i++) {
    parts.push(head(i + 1) + b45encode(blob.subarray(i * chunk, (i + 1) * chunk)));
  }
  return parts;
}

// The clinic computer reads results; this exists so the phone's tests can read
// the Python module's messages. parts: every part of one message, in any order.
export async function decodeResults(parts, keyFor) {
  const pieces = new Map();
  let total = 0;
  for (const text of parts) {
    const t = text.trim();
    if (!t.startsWith(RESULTS_PREFIX)) continue;
    pieces.set(Number(t.slice(8, 10)), b45decode(t.slice(12)));
    total = Number(t.slice(10, 12));
  }
  if (!total || pieces.size !== total) throw new ExchangeError("not all parts received yet");
  const blob = new Uint8Array([...Array(total).keys()].flatMap((i) => [...pieces.get(i + 1)]));
  const n = blob[0];
  const code = fromUtf8.decode(blob.subarray(1, 1 + n));
  const key = keyFor(code);
  if (!key) throw new ExchangeError(`no programme was issued to ${code} from this computer`);
  let data;
  try {
    data = new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: blob.subarray(1 + n, 13 + n), additionalData: associated(code) },
      await aes(key), blob.subarray(13 + n)));
  } catch {
    throw new ExchangeError("these results do not match this patient's programme");
  }
  const payload = await unpack(data);
  if (payload.v !== VERSION) throw new ExchangeError(`results format version ${payload.v} is not supported`);
  return [code, payload.s];
}

// One finished session on the phone, in the compact form the results carry.
//   started: Date or milliseconds; feedback: {pain, effort} or null;
//   exercises: [{exercise, side, reps, prescribed, repsInTarget, furthest,
//                inTargetPct, target: [lo, hi], peaks: [...]}]
export function compactSession({ started, duration, model = "full", feedback = null, exercises }) {
  const x10 = (v) => pyRound(v * 10);
  return {
    t: Math.floor(Number(started) / 1000),
    u: pyRound(duration || 0),
    m: model,
    f: [feedback?.pain ?? null, EFFORT_CODES[feedback?.effort] ?? null],
    e: exercises.map((e) => [
      EXERCISE_CODES[e.exercise], SIDE_CODES[e.side], e.reps, e.prescribed ?? null,
      e.repsInTarget || 0, e.furthest == null ? null : x10(e.furthest), x10(e.inTargetPct || 0),
      pyRound(e.target[0]), pyRound(e.target[1]), (e.peaks || []).map(x10),
    ]),
  };
}
