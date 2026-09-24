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
// Version 2: the programme QR carries the clinic's public key and nothing secret;
// results are sealed for that key and signed by this phone. See the format in
// motionloom_exchange.py.
export const VERSION_2 = 2;
export const PROGRAMME_PREFIX_V2 = "KLP2";
export const RESULTS_PREFIX_V2 = "KLR2";
const POINT_BYTES = 65;
const SIGNATURE_BYTES = 64;
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

export function b64u(bytes) {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64u(text) {
  try {
    const b64 = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch {
    throw new ExchangeError("bad key");
  }
}

const P256 = { name: "ECDH", namedCurve: "P-256" };
const SIGN = { name: "ECDSA", namedCurve: "P-256" };

async function importPoint(raw, algorithm) {
  if (raw.length !== POINT_BYTES) throw new ExchangeError("bad key");
  try {
    return await crypto.subtle.importKey("raw", raw, algorithm, true,
                                         algorithm.name === "ECDSA" ? ["verify"] : []);
  } catch {
    throw new ExchangeError("bad key");
  }
}

// HKDF-SHA256(shared, salt = nonce, info = "KLR2|" + code) -> an AES-128-GCM key.
async function sealingKey(shared, nonce, codeBytes) {
  const base = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  const info = new Uint8Array([...utf8.encode("KLR2|"), ...codeBytes]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: nonce, info }, base,
                                 { name: "AES-GCM", length: 128 }, false, ["encrypt", "decrypt"]);
}

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

// This phone's own key: an ECDSA P-256 pair, made once and kept by the caller
// (store.js). Returned as JWKs, which is how it is stored.
export async function newPhoneKey() {
  const pair = await crypto.subtle.generateKey(SIGN, true, ["sign", "verify"]);
  return { privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey),
           publicRaw: b64u(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))) };
}

// Python's round(): halves go to the even neighbour.
export function pyRound(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

// ----- Programme: clinic -> phone ------------------------------------------

// Which programme format a scanned text is: 1 or 2; 0 if it is no KinemaLoom
// programme; -1 for "KLP" and a version this app does not know - a programme from
// a newer clinic computer, where the patient should update the app, not move closer.
// The scanner asks this rather than checking a prefix of its own: it once checked
// for "KLP1" and turned every version 2 programme away as not ours.
export function programmeVersion(text) {
  const t = (text || "").trim();
  if (!t.startsWith("KLP")) return 0;
  return { [PROGRAMME_PREFIX]: VERSION, [PROGRAMME_PREFIX_V2]: VERSION_2 }[t.slice(0, 4)] ?? -1;
}

export async function decodeProgramme(text) {
  text = (text || "").trim();
  const version = programmeVersion(text);
  if (version <= 0) throw new ExchangeError("not a KinemaLoom programme");
  const p = await unpack(b45decode(text.slice(4)));
  if (p.v !== version) throw new ExchangeError(`programme format version ${p.v} is not supported`);
  const items = p.i.map(([ex, side, reps, sets, rest, lo, hi]) => {
    if (!(ex in CODE_EXERCISES) || !(side in CODE_SIDES)) throw new ExchangeError("damaged data");
    return { exercise: CODE_EXERCISES[ex], side: CODE_SIDES[side], reps, sets, rest, target: [lo, hi] };
  });
  if (version === VERSION) keyBytes(p.k);
  else await importPoint(unb64u(p.ck || ""), P256);     // a usable clinic key, or refused now
  return { patient: p.p, clinician: p.c, issued: p.d, version, key: p.k || null,
           clinicKey: p.ck || null, language: p.l || "en", items };
}

// The clinic computer makes programmes; this exists for tests and demonstrations.
export async function encodeProgramme(code, clinician, key, items, ranges, issued, language,
                                      clinicKey = null) {
  const rows = items.map((it) => {
    const [lo, hi] = ranges[it.exercise];
    return [EXERCISE_CODES[it.exercise], SIDE_CODES[it.side], it.reps, it.sets ?? 1, it.rest ?? 30,
            pyRound(lo), pyRound(hi)];
  });
  const payload = { v: VERSION, p: code, c: clinician || "", d: issued, k: key, i: rows };
  if (language && language !== "en") payload.l = language;   // English is the fallback
  if (clinicKey) {
    delete payload.k;
    Object.assign(payload, { v: VERSION_2, ck: clinicKey });
    return PROGRAMME_PREFIX_V2 + b45encode(await pack(payload));
  }
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

function splitIntoParts(prefix, blob, chunk, msgId) {
  const total = Math.ceil(blob.length / chunk);
  if (total > 99) throw new ExchangeError("too many sessions for one transfer");
  const msg = msgId ?? crypto.getRandomValues(new Uint16Array(1))[0];
  const head = (i) => prefix + msg.toString(16).toUpperCase().padStart(4, "0")
    + String(i).padStart(2, "0") + String(total).padStart(2, "0");
  const parts = [];
  for (let i = 0; i < total; i++) parts.push(head(i + 1) + b45encode(blob.subarray(i * chunk, (i + 1) * chunk)));
  return parts;
}

// Version 2: sealed for the clinic key (base64url, from the programme), signed
// with this phone's key ({privateJwk, publicRaw}). msgId, nonce and ephemeral are
// for tests only; left out, they are fresh every time.
export async function encodeResultsV2(code, clinicKey, phoneKey, sessions,
                                      { chunk = CHUNK_BYTES, msgId, nonce, ephemeral } = {}) {
  const codeBytes = utf8.encode(code);
  if (!(codeBytes.length > 0 && codeBytes.length < 256)) throw new ExchangeError("patient code too long");
  nonce = nonce || crypto.getRandomValues(new Uint8Array(12));
  const eph = ephemeral || await crypto.subtle.generateKey(P256, true, ["deriveBits"]);
  const ephPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const clinic = await importPoint(unb64u(clinicKey), P256);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: clinic },
                                                               eph.privateKey, 256));
  const payload = { v: VERSION_2, s: sessions, pk: phoneKey.publicRaw };
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: concat(utf8.encode("KLR2|"), codeBytes, ephPub) },
    await sealingKey(shared, nonce, codeBytes), await pack(payload)));
  const body = concat(Uint8Array.of(codeBytes.length), codeBytes, ephPub, nonce, sealed);
  const signer = await crypto.subtle.importKey("jwk", phoneKey.privateJwk, SIGN, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" },
                                                            signer, body));
  return splitIntoParts(RESULTS_PREFIX_V2, concat(body, signature), chunk, msgId);
}

// The clinic computer reads results; this exists so the phone's tests can read
// the Python module's messages. parts: every part of one message, in any order.
// Version 2 needs the clinic's private key (base64url PKCS#8) and also returns
// the public key of the phone that signed it.
export async function decodeResultsV2(parts, clinicPrivate) {
  const pieces = new Map();
  let total = 0;
  for (const text of parts) {
    const t = text.trim();
    if (!t.startsWith(RESULTS_PREFIX_V2)) continue;
    pieces.set(Number(t.slice(8, 10)), b45decode(t.slice(12)));
    total = Number(t.slice(10, 12));
  }
  if (!total || pieces.size !== total) throw new ExchangeError("not all parts received yet");
  const blob = concat(...[...Array(total).keys()].map((i) => pieces.get(i + 1)));
  const n = blob[0];
  const codeBytes = blob.subarray(1, 1 + n);
  const ephPub = blob.subarray(1 + n, 1 + n + POINT_BYTES);
  const nonce = blob.subarray(1 + n + POINT_BYTES, 13 + n + POINT_BYTES);
  const sealed = blob.subarray(13 + n + POINT_BYTES, blob.length - SIGNATURE_BYTES);
  const body = blob.subarray(0, blob.length - SIGNATURE_BYTES);
  const signature = blob.subarray(blob.length - SIGNATURE_BYTES);
  const own = await crypto.subtle.importKey("pkcs8", unb64u(clinicPrivate), P256, false, ["deriveBits"]);
  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: await importPoint(ephPub, P256) }, own, 256));
  let data;
  try {
    data = new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce, additionalData: concat(utf8.encode("KLR2|"), codeBytes, ephPub) },
      await sealingKey(shared, nonce, codeBytes), sealed));
  } catch {
    throw new ExchangeError("these results cannot be opened on this computer");
  }
  const payload = await unpack(data);
  const verifier = await importPoint(unb64u(payload.pk || ""), SIGN);
  if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifier, signature, body)) {
    throw new ExchangeError("the signature on these results does not match");
  }
  return [fromUtf8.decode(codeBytes), payload.s, payload.pk];
}

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
