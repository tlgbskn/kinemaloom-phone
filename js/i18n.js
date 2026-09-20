// The language of what the phone shows. The messages are the same files the
// desktop reads (i18n/<language>.json, copied into the build), so the two say
// the same thing. See motionloom_i18n.py.
//
// The catalogue has to be loaded before anything is shown: `await useLanguage()`.

export const DEFAULT = "en";
export const LANGUAGES = { en: "English", fr: "Français" };

const catalogs = new Map();
let language = DEFAULT;

// Where the message files are: beside the built application, or - running from
// the source tree, as the tests do - in the project's own i18n folder.
async function read(lang, base) {
  const bases = base ? [base] : ["../i18n/", "../../i18n/"].map((b) => new URL(b, import.meta.url));
  // The build gives this file a ?v=<version>; the messages are asked for under
  // the same one, so a page can never be served with another build's wording.
  const version = new URL(import.meta.url).search;
  let last;
  for (const b of bases) {
    const url = new URL(`${lang}.json${version}`, b);
    try {
      if (url.protocol === "file:") {
        const { readFile } = await import("node:fs/promises");
        return JSON.parse(await readFile(url, "utf-8"));
      }
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${url}: ${res.status}`);
      return await res.json();
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

// Loads the language (and English to fall back on) and shows everything in it.
export async function useLanguage(lang, base) {
  lang = LANGUAGES[lang] ? lang : DEFAULT;
  for (const l of new Set([DEFAULT, lang])) {
    if (!catalogs.has(l)) {
      try {
        catalogs.set(l, await read(l, base));
      } catch {
        catalogs.set(l, {});
      }
    }
  }
  language = lang;
  return lang;
}

export const currentLanguage = () => language;

// For tests and for a language shipped inside another file.
export const setCatalog = (lang, messages) => catalogs.set(lang, messages);

export function t(key, values = {}) {
  const text = catalogs.get(language)?.[key] || catalogs.get(DEFAULT)?.[key] || key;
  // An unknown {name} stays as it is: it shows up in the tests as text rather
  // than breaking the screen it is on.
  return text.includes("{")
    ? text.replace(/\{(\w+)\}/g, (whole, name) => (name in values ? values[name] : whole))
    : text;
}

// Both forms of "left" and "right"; French needs "le genou droit" but "la jambe droite".
export const sideWords = (side) => ({ side: t(`side.${side}`), side_m: t(`side_m.${side}`) });

// Which language to show, in order: the one the patient chose on this phone,
// then the one the clinic put in their programme, then the phone's own. A
// newly scanned programme clears the patient's choice (see app.js), so the
// clinic's decision is not overridden by a tap from weeks ago.
export function chooseLanguage({ chosen, programme, phone } = {}) {
  for (const lang of [chosen, programme, (phone || "").slice(0, 2)]) {
    if (lang && LANGUAGES[lang]) return lang;
  }
  return DEFAULT;
}

// A joint's name in words; anything not in the catalogue stays as it is.
export function jointWord(name) {
  const key = `joint.${name}`;
  return catalogs.get(language)?.[key] || catalogs.get(DEFAULT)?.[key] || name;
}
