// Kotonoha hafızası — tarayıcının kendi deposunda (localStorage), yalnızca bu cihazda.
// Her dilin hafızası ayrıdır: "kotonoha-v1-ja", "kotonoha-v1-de", "kotonoha-v1-en".
// API anahtarları ve yapay zekâ seçimi dillerin ORTAK deposunda durur ("kotonoha-shared"):
// aynı tarayıcıda bir kez girmek yeter. (iPad'de ana ekrana eklenen her uygulamanın deposu
// ayrı olduğu için orada her simgede bir kez girilir.)
import { pack } from "./lang/index.js";

export const LEGACY_KEY = "kotonoha-v1";            // 0.3.x: tek dil (Japonca) dönemi
export const KEY = `kotonoha-v1-${pack.code}`;
export const SHARED_KEY = "kotonoha-shared";

export const DEFAULT_SHARED = {
  provider: "claude",
  claude_key: "", claude_model: "claude-sonnet-5-5",
  openai_key: "", openai_model: "gpt-4o",
};
const SHARED_FIELDS = Object.keys(DEFAULT_SHARED);

export const blankProfile = () => ({ level_self: "", goals: [], about: "", interests: "" });

export const DEFAULT_SETTINGS = {
  character_name: pack.defaultCharacter,
  persona: "Sakin, meraklı ve biraz esprili. Hata yapmaktan korkmamayı öğütler.",
  learner_name: "",
  profile: blankProfile(),
  profile_done: false,
  voice_on: true, voice_name: "", rate: 0.9, silence_ms: 1400,
  furigana: "unknown", show_tr: false,
};

function blank() {
  return {
    settings: { ...DEFAULT_SETTINGS, profile: blankProfile() }, kv: {}, sessions: [], messages: [], facts: [],
    mistakes: [], vocab: [], unit_content: {}, unit_progress: {}, next_id: 1,
  };
}

const now = () => new Date().toISOString().slice(0, 19);
const LS = () => globalThis.localStorage;

function readJSON(key) {
  try { const raw = LS().getItem(key); return raw ? JSON.parse(raw) : null; }
  catch (e) { console.warn("okunamadı:", key, e); return null; }
}

// ---------- 0.3.x → 0.4 taşıma (yalnızca Japonca) ----------
// Eski tek-dilli hafıza "kotonoha-v1" anahtarındaydı. Japonca sürüm ilk açıldığında:
//  - hafıza "kotonoha-v1-ja"ya taşınır,
//  - API anahtarları ortak depoya geçer,
//  - eskiden talimata gömülü olan öğrenci bilgisi (Japon Dili ve Edebiyatı, Japonya planı)
//    öğrenci profiline yazılır; profil ekranından değiştirilebilir.
// Yeni kayıt hiç kullanılmamışsa (oturum, kelime, profil yok) boş sayılır; taşıma yine yapılır.
function isEmptyStore(d) {
  return !d || (!(d.sessions || []).length && !(d.vocab || []).length && !d.settings?.profile_done);
}

export function migrateLegacy() {
  if (pack.code !== "ja") return false;
  const ls = LS();
  if (!ls.getItem(LEGACY_KEY) || !isEmptyStore(readJSON(KEY))) return false;
  const d = readJSON(LEGACY_KEY);
  if (!d || typeof d !== "object") return false;
  const s = d.settings || (d.settings = {});
  const shared = { ...DEFAULT_SHARED, ...(readJSON(SHARED_KEY) || {}) };
  for (const k of SHARED_FIELDS) {
    if (k in s) {
      if (s[k] && (!shared[k] || shared[k] === DEFAULT_SHARED[k])) shared[k] = s[k];
      delete s[k];
    }
  }
  if (!s.profile) {
    s.profile = {
      level_self: "", goals: ["school", "travel"],
      about: "Japon Dili ve Edebiyatı bölümünde okuyor; yazın iki aylığına Japonya'ya gitmeyi planlıyor.",
      interests: "çizim, anime, oyunlar, edebiyat",
    };
  }
  s.profile_done = true;
  try {
    ls.setItem(SHARED_KEY, JSON.stringify(shared));
    ls.setItem(KEY, JSON.stringify(d));
    if (ls.getItem(KEY)) ls.removeItem(LEGACY_KEY);   // yeni kayıt yerindeyse eskisini sil
    return true;
  } catch (e) {
    console.error("taşıma yapılamadı", e);
    return false;
  }
}

function load() {
  const d = readJSON(KEY);
  const b = blank();
  if (!d) return b;
  const st = { ...b.settings, ...(d.settings || {}) };
  st.profile = { ...blankProfile(), ...(st.profile || {}) };
  for (const k of SHARED_FIELDS) delete st[k];
  return { ...b, ...d, settings: st };
}

function loadShared() {
  return { ...DEFAULT_SHARED, ...(readJSON(SHARED_KEY) || {}) };
}

let db, shared;
export function init() {
  try { migrateLegacy(); } catch (e) { console.error(e); }
  db = load();
  shared = loadShared();
}
init();

let saveTimer = null;

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 150);
}

export function saveNow() {
  clearTimeout(saveTimer);
  trim();
  try {
    LS().setItem(KEY, JSON.stringify(db));
    LS().setItem(SHARED_KEY, JSON.stringify(shared));
  } catch (e) { console.error("hafıza yazılamadı", e); }
}

function trim() {
  // Depo sınırını aşmamak için: özeti çıkarılmış eski oturumların mesajlarını sil.
  // (localStorage sınırı ~5 MB ve üç dil aynı sınırı paylaşıyor.)
  if (db.messages.length <= 2500) return;
  const keep = new Set(db.sessions.slice(-40).map(s => s.id));
  const summarized = new Set(db.sessions.filter(s => s.summarized).map(s => s.id));
  db.messages = db.messages.filter(m => keep.has(m.session_id) || !summarized.has(m.session_id));
}

const id = () => db.next_id++;

// Ana ekrana eklenmiş uygulamada verilerin silinmemesini iste
export async function requestPersist() {
  try { if (navigator.storage?.persist) return await navigator.storage.persist(); }
  catch (e) { /* önemli değil */ }
  return false;
}

// ---------- ayarlar ----------
// Dile ait ayarlar + ortak (anahtar/model) ayarlar tek nesne olarak görünür.
export const settings = () => ({ ...db.settings, ...shared });
export function setSetting(k, v) {
  if (SHARED_FIELDS.includes(k)) shared[k] = v; else db.settings[k] = v;
  save();
}
export function apiKey() {
  return shared.provider === "openai" ? shared.openai_key : shared.claude_key;
}
export const profile = () => db.settings.profile || blankProfile();

// ---------- anahtar/değer ----------
export const get = (k, d = null) => (k in db.kv ? db.kv[k] : d);
export function set(k, v) { db.kv[k] = v; save(); }

// ---------- oturumlar ve mesajlar ----------
export function newSession(mode, unit_id = null) {
  const s = { id: id(), mode, unit_id, started: now(), summary: null, summarized: false };
  db.sessions.push(s); save();
  return s.id;
}
export function addMessage(session_id, role, text, raw = null) {
  db.messages.push({ id: id(), session_id, role, text, raw: raw ?? text, ts: now() });
  save();
}
export function history(session_id, limit = 24) {
  return db.messages.filter(m => m.session_id === session_id).slice(-limit)
    .map(m => ({ role: m.role, content: m.raw }));
}
export function transcript(session_id) {
  return db.messages.filter(m => m.session_id === session_id)
    .map(m => `${m.role === "user" ? "Öğrenci" : "Avatar"}: ${m.text}`).join("\n");
}
export const userMessageCount = sid =>
  db.messages.filter(m => m.session_id === sid && m.role === "user").length;
export function saveSummary(sid, summary) {
  const s = db.sessions.find(x => x.id === sid);
  if (s) { s.summary = summary; s.summarized = true; save(); }
}
export function markSummarized(sid) {
  const s = db.sessions.find(x => x.id === sid);
  if (s) { s.summarized = true; save(); }
}
export function unsummarizedSessions(minUser = 3) {
  return db.sessions.filter(s => !s.summarized && userMessageCount(s.id) >= minUser).map(s => s.id);
}
export const recentSummaries = (n = 3) => db.sessions.filter(s => s.summarized && s.summary)
  .slice(-n).reverse().map(s => `${s.started.slice(0, 10)}: ${s.summary}`);
export const sessionCount = () => db.sessions.filter(s => s.summarized).length;

// ---------- öğrenci hakkında bilgiler ----------
export function addFact(text) {
  text = (text || "").trim();
  if (text && !db.facts.some(f => f.text === text)) { db.facts.push({ text, ts: now() }); save(); }
}
export const facts = (n = 15) => db.facts.slice(-n).reverse().map(f => f.text);

// ---------- hatalar ----------
export function addMistake(category, original, corrected, explanation) {
  db.mistakes.push({ category: category || "diğer", original, corrected, explanation, ts: now() });
  save();
}
export function mistakeStats(n = 5) {
  const by = {};
  for (const m of db.mistakes) (by[m.category] ||= []).push(m);
  return Object.entries(by).sort((a, b) => b[1].length - a[1].length).slice(0, n)
    .map(([category, list]) => {
      const last = list[list.length - 1];
      return { category, count: list.length, original: last.original, corrected: last.corrected };
    });
}

// ---------- kelimeler ve aralıklı tekrar ----------
export function addWord(word, reading = "", meaning_tr = "", example = "", example_tr = "", source = "") {
  word = (word || "").trim();
  if (!word || db.vocab.some(w => w.word === word)) return;
  db.vocab.push({ id: id(), word, reading, meaning_tr, example_ja: example, example_tr, source,
                  interval_days: 0, ease: 2.5, reps: 0, lapses: 0, due: now(), created: now() });
  save();
}
export const dueWords = (limit = 20) => db.vocab.filter(w => w.due <= now())
  .sort((a, b) => a.due.localeCompare(b.due)).slice(0, limit).map(w => ({ ...w }));
export function reviewWord(wid, remembered) {
  const w = db.vocab.find(x => x.id === wid);
  if (!w) return;
  const t = new Date();
  if (remembered) {
    w.interval_days = w.reps === 0 ? 1 : w.reps === 1 ? 3 : Math.round(w.interval_days * w.ease * 10) / 10;
    w.ease = Math.min(3.0, w.ease + 0.05);
    w.reps += 1;
    t.setTime(t.getTime() + w.interval_days * 86400000);
  } else {
    w.interval_days = 0; w.reps = 0; w.lapses += 1;
    w.ease = Math.max(1.3, w.ease - 0.2);
    t.setTime(t.getTime() + 10 * 60000);
  }
  w.due = new Date(t.getTime() - t.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
  save();
}
export const knownWords = (minInterval = 7) =>
  new Set(db.vocab.filter(w => w.interval_days >= minInterval).map(w => w.word));
export function vocabStats() {
  const n = now();
  return { total: db.vocab.length, known: db.vocab.filter(w => w.interval_days >= 7).length,
           due: db.vocab.filter(w => w.due <= n).length };
}

// ---------- üniteler (sonraki sürüm) ----------
export const completedUnits = () => Object.fromEntries(
  Object.entries(db.unit_progress).filter(([, st]) => (st.quiz ?? 0) >= 0.7)
    .map(([u, st]) => [u, st.quiz]));

// ---------- yedekleme ----------
// API anahtarları yedeğe girmez: dosya başka yere gitse bile anahtar sızmaz.
export function exportJSON() {
  saveNow();
  const copy = JSON.parse(JSON.stringify(db));
  for (const k of SHARED_FIELDS) delete copy.settings[k];
  return JSON.stringify({ app: "Kotonoha", lang: pack.code, version: 2, exported: now(), data: copy }, null, 1);
}
export function importJSON(text) {
  const obj = JSON.parse(text);
  if (obj.app !== "Kotonoha" || !obj.data) throw new Error("Bu bir Kotonoha yedeği değil.");
  const lang = obj.lang || "ja";        // 0.3.x yedekleri dil bilgisi taşımaz; hepsi Japonca
  if (lang !== pack.code) throw new Error(`Bu yedek ${lang.toUpperCase()} sürümüne ait; ${pack.code.toUpperCase()} sürümüne yüklenemez.`);
  const b = blank();
  const st = { ...b.settings, ...(obj.data.settings || {}) };
  for (const k of SHARED_FIELDS) delete st[k];
  st.profile = { ...blankProfile(), ...(st.profile || {}) };
  if (!obj.lang && !obj.data.settings?.profile) st.profile_done = false;   // eski yedek: profili sorsun
  db = { ...b, ...obj.data, settings: st };
  saveNow();
}

// Testler için
export function _reset() { db = blank(); shared = { ...DEFAULT_SHARED }; }
