// Kotonoha hafızası — tarayıcının kendi deposunda (localStorage), yalnızca bu cihazda.
// Masaüstündeki SQLite veritabanının karşılığı: oturumlar, mesajlar, öğrenci bilgileri,
// hatalar, kelimeler (SRS), ünite içeriği ve ilerleme.

const KEY = "kotonoha-v1";

export const DEFAULT_SETTINGS = {
  provider: "claude",
  claude_key: "", claude_model: "claude-sonnet-5-5",
  openai_key: "", openai_model: "gpt-4o",
  character_name: "Kotonoha",
  persona: "Sakin, meraklı ve biraz esprili. Çizime, edebiyata ve oyunlara ilgi duyar. " +
           "Hata yapmaktan korkmamayı öğütler.",
  learner_name: "",
  voice_on: true, voice_name: "", rate: 0.9,
  furigana: "unknown", show_tr: false,
};

function blank() {
  return {
    settings: { ...DEFAULT_SETTINGS }, kv: {}, sessions: [], messages: [], facts: [],
    mistakes: [], vocab: [], unit_content: {}, unit_progress: {}, next_id: 1,
  };
}

const now = () => new Date().toISOString().slice(0, 19);

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const d = JSON.parse(raw);
      const b = blank();
      return { ...b, ...d, settings: { ...b.settings, ...(d.settings || {}) } };
    }
  } catch (e) { console.warn("hafıza okunamadı", e); }
  return blank();
}

let db = load();
let saveTimer = null;

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 150);
}

export function saveNow() {
  clearTimeout(saveTimer);
  trim();
  try { localStorage.setItem(KEY, JSON.stringify(db)); }
  catch (e) { console.error("hafıza yazılamadı", e); }
}

function trim() {
  // Depo sınırını aşmamak için: özeti çıkarılmış eski oturumların mesajlarını sil.
  if (db.messages.length <= 3000) return;
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
export const settings = () => db.settings;
export function setSetting(k, v) { db.settings[k] = v; save(); }
export function apiKey() {
  const s = db.settings;
  return s.provider === "openai" ? s.openai_key : s.claude_key;
}

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
export function addWord(word, reading = "", meaning_tr = "", example_ja = "", example_tr = "", source = "") {
  word = (word || "").trim();
  if (!word || db.vocab.some(w => w.word === word)) return;
  db.vocab.push({ id: id(), word, reading, meaning_tr, example_ja, example_tr, source,
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
  copy.settings.claude_key = "";
  copy.settings.openai_key = "";
  return JSON.stringify({ app: "Kotonoha", version: 1, exported: now(), data: copy }, null, 1);
}
export function importJSON(text) {
  const obj = JSON.parse(text);
  if (obj.app !== "Kotonoha" || !obj.data) throw new Error("Bu bir Kotonoha yedeği değil.");
  const keep = { claude_key: db.settings.claude_key, openai_key: db.settings.openai_key };
  const b = blank();
  db = { ...b, ...obj.data, settings: { ...b.settings, ...obj.data.settings, ...keep } };
  saveNow();
}

// Testler için
export function _reset() { db = blank(); }
