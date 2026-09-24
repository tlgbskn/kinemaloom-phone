// What the phone keeps: the programme it scanned and the sessions done since.
// Only on this phone, in the browser's storage for this site. Nothing is sent
// anywhere; results leave only as the QR codes shown on the Send screen.

const PROGRAMME = "kl.programme";
const SESSIONS = "kl.sessions";
const DRAFT = "kl.draft";
const PHONE_KEY = "kl.phonekey";
// The phone never learns whether the clinic read a session, so it keeps them
// long enough that a missed visit or two cannot cost one. A year of twice-daily
// sessions is a few hundred kilobytes.
const KEEP_DAYS = 365;
// Sessions per transfer. Forty real sessions are about 24 QR parts, twelve
// seconds a round on screen; more go in further transfers, never left out.
export const SEND_BATCH = 40;

function read(key, fallback) {
  try {
    const text = localStorage.getItem(key);
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

// {qr, programme}: the QR text as scanned, and its decoded form.
export const loadProgramme = () => read(PROGRAMME, null);
export const saveProgramme = (qr, programme) => write(PROGRAMME, { qr, programme, saved: Date.now() });

// [{patient, session}], session in compact form (exchange.compactSession).
export function loadSessions() {
  const cutoff = Date.now() / 1000 - KEEP_DAYS * 86400;
  return read(SESSIONS, []).filter((s) => s.session && s.session.t >= cutoff);
}

// Saving the same session again replaces it: a session is known by its start,
// as the clinic knows it, so a draft and the finished session are one entry.
export function addSession(patient, session) {
  const all = loadSessions().filter((s) => !(s.patient === patient && s.session.t === session.t));
  all.push({ patient, session });
  return write(SESSIONS, all);
}

// Every session of this patient on the phone, oldest first.
export function sessionsFor(patient) {
  return loadSessions().filter((s) => s.patient === patient).map((s) => s.session)
    .sort((a, b) => a.t - b.t);
}

// ... in transfers of SEND_BATCH.
export function batchesFor(patient) {
  const all = sessionsFor(patient);
  const batches = [];
  for (let i = 0; i < all.length; i += SEND_BATCH) batches.push(all.slice(i, i + SEND_BATCH));
  return batches;
}

// A session still being done, kept as it goes. A phone may close a page in the
// background without warning - a call, another app, low memory - and the page
// then never hears about it; what was measured must not go with it.
export const saveDraft = (patient, session) => write(DRAFT, { patient, session });
export const clearDraft = () => {
  try { localStorage.removeItem(DRAFT); } catch { /* nothing to clear */ }
};

// On opening: a draft left behind means the page was closed mid-session. It
// becomes a saved session, without answers, as leaving the question page does.
export function recoverDraft() {
  const draft = read(DRAFT, null);
  if (!draft?.session) return false;
  const ok = addSession(draft.patient, draft.session);
  if (ok) clearDraft();
  return ok;
}

// This phone's signing key, made the first time it is needed and kept. The clinic
// knows a patient's phone by it, so a new one - after "Delete my data", or in a
// Home Screen app, whose storage is separate from Safari's - is shown to the
// clinician as a different phone before anything is saved.
export async function phoneKey() {
  let key = read(PHONE_KEY, null);
  if (!key?.privateJwk || !key?.publicRaw) {
    const { newPhoneKey } = await import("./exchange.js?v=a682c2ee8c");
    key = await newPhoneKey();
    write(PHONE_KEY, key);
  }
  return key;
}

export function forgetAll() {
  try {
    localStorage.removeItem(PROGRAMME);
    localStorage.removeItem(SESSIONS);
    localStorage.removeItem(DRAFT);
    localStorage.removeItem(PHONE_KEY);
  } catch {
    // nothing stored, or storage blocked: nothing to forget
  }
}

export const settings = {
  get sound() { return read("kl.sound", true); },
  set sound(on) { write("kl.sound", on); },
  // Empty until the patient chooses: the programme's language is used until then.
  get language() { return read("kl.language", ""); },
  set language(lang) { write("kl.language", lang); },
};
