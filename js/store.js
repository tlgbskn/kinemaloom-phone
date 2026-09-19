// What the phone keeps: the programme it scanned and the sessions done since.
// Only on this phone, in the browser's storage for this site. Nothing is sent
// anywhere; results leave only as the QR codes shown on the Send screen.

const PROGRAMME = "kl.programme";
const SESSIONS = "kl.sessions";
const KEEP_DAYS = 90;              // older sessions are dropped: the clinic has them by then
export const SEND_MAX = 40;        // sessions per transfer; keeps it to a few dozen QR parts

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

export function addSession(patient, session) {
  const all = loadSessions();
  all.push({ patient, session });
  return write(SESSIONS, all);
}

// The most recent sessions of this patient, oldest first.
export function sessionsFor(patient) {
  return loadSessions().filter((s) => s.patient === patient).map((s) => s.session)
    .sort((a, b) => a.t - b.t).slice(-SEND_MAX);
}

export function forgetAll() {
  try {
    localStorage.removeItem(PROGRAMME);
    localStorage.removeItem(SESSIONS);
  } catch {
    // nothing stored, or storage blocked: nothing to forget
  }
}

export const settings = {
  get sound() { return read("kl.sound", true); },
  set sound(on) { write("kl.sound", on); },
};
