// Ders motoru: yapay zekâ + hafıza.
import * as store from "./store.js";
import { chat, extractJson } from "./llm.js";
import * as P from "./prompts.js";
import { pack } from "./lang/index.js";
import * as cur from "./curriculum.js";

export function learnerContext() {
  const est = store.get("level_estimate");
  const self = store.profile().level_self;
  const level = est ? `${est} (sohbetlerden tahmin)`
    : self === "0" ? "yeni başlıyor (kendi söyledi)"
    : self ? `${self} (kendi söyledi)` : "henüz bilinmiyor";
  const lines = [`- Seviye: ${level}`];
  for (const f of store.facts(12)) lines.push(`- ${f}`);
  const ms = store.mistakeStats(5);
  const [a, b] = pack.q;
  if (ms.length) {
    lines.push("- Sık yaptığı hatalar:");
    for (const m of ms) lines.push(`  * ${m.category} (${m.count} kez), örn. ${a}${m.original}${b}→${a}${m.corrected}${b}`);
  }
  const sums = store.recentSummaries(3);
  if (sums.length) { lines.push("- Son oturumlar:"); for (const s of sums) lines.push(`  * ${s}`); }
  const done = store.completedUnits();
  const nxt = cur.nextUnit(done);
  lines.push(`- Tamamlanan üniteler: ${Object.keys(done).join(", ") || "yok"}${nxt ? ` · sıradaki: ${nxt}` : ""}`);
  lines.push("- Ünite listesi: " + cur.all().map(u => `${u.id} ${u.title_tr}`).join("; "));
  return lines.join("\n");
}

function persona() {
  const s = store.settings();
  return P.PERSONA({ name: s.character_name, learner: s.learner_name || "öğrenci",
                     persona: s.persona, profile: store.profile(), context: learnerContext() });
}

export function parseReply(raw) {
  let d = extractJson(raw);
  if (d && typeof d === "object" && !d.reply && d.reply_ja) d.reply = d.reply_ja;   // eski biçim
  if (!d || typeof d !== "object" || !d.reply) d = { reply: (raw || "").trim() || "……", reply_tr: "" };
  delete d.reply_ja;
  d.reply_tr ??= "";
  if (!d.correction || typeof d.correction !== "object") d.correction = null;
  if (!Array.isArray(d.new_words)) d.new_words = [];
  d.goal_reached = !!d.goal_reached;
  d.open_unit = cur.unit(d.open_unit) ? d.open_unit : null;
  return d;
}

export function systemPrompt({ voice = false, task = null } = {}) {
  return persona() + "\n" + (task || P.FREE_TALK) + (voice ? P.VOICE_TALK : "") + P.REPLY_FORMAT;
}

export async function converse(sessionId, userText, { voice = false, task = null } = {}) {
  const system = systemPrompt({ voice, task });
  if (userText) store.addMessage(sessionId, "user", userText);
  const raw = await chat(store.settings(), system, store.history(sessionId, 24), 1200, pack.startToken);
  const d = parseReply(raw);
  store.addMessage(sessionId, "assistant", d.reply, JSON.stringify(d));
  const c = d.correction;
  if (c?.original && c?.corrected) store.addMistake(c.category, c.original, c.corrected, c.explanation_tr || "");
  for (const w of d.new_words) if (w && typeof w === "object") store.addWord(w.word, w.reading || "", w.meaning_tr || "", "", "", "sohbet");
  return d;
}

export async function summarize(sessionId) {
  if (store.userMessageCount(sessionId) < 3) return false;
  const raw = await chat(store.settings(), "Sen bir dil öğretmeninin not defterisin.",
    [{ role: "user", content: P.SUMMARY(store.transcript(sessionId).slice(-12000)) }], 800);
  const d = extractJson(raw);
  if (!d) { store.markSummarized(sessionId); return false; }
  store.saveSummary(sessionId, d.summary_tr || "");
  for (const f of d.facts || []) store.addFact(f);
  if (d.level_estimate) store.set("level_estimate", d.level_estimate);
  return true;
}

// ---------------- 📘 üniteler ----------------
export function validateUnit(d) {
  try {
    return !!(d && typeof d === "object" && d.scene.lines.length && d.vocab.length && d.grammar.explanation_tr
      && d.roleplay.goal_tr && d.writing.task_tr && d.quiz.length
      && d.quiz.every(q => Array.isArray(q.options) && q.options.length >= 2 && Number(q.answer) >= 0 && Number(q.answer) < q.options.length));
  } catch (e) { return false; }
}

// Ünite içeriğini döndürür; yoksa yapay zekâyla üretip cihazda saklar (30-60 sn sürebilir).
export async function unitContent(unitId, regenerate = false) {
  if (!regenerate) { const c = store.getUnitContent(unitId); if (c) return c; }
  const u = cur.unit(unitId);
  const level = levelText() || "bilinmiyor (ünitenin seviyesini esas al)";
  const mistakes = store.mistakeStats(3).map(m => m.category).join(", ") || "henüz yok";
  const t = cur.trackById(u.track);
  const program = t?.custom ? `${t.title_tr} — ${t.request_tr || t.desc_tr}` : null;
  const prompt = P.UNIT_GEN({ u, level, profile: store.profile(), mistakes, program });
  for (let i = 0; i < 2; i++) {          // bozuk JSON gelirse bir kez daha dene
    const raw = await chat(store.settings(), `Sen deneyimli bir ${pack.nameTr} öğretmenisin ve ders materyali hazırlıyorsun.`,
      [{ role: "user", content: prompt }], 8000);
    const d = extractJson(raw);
    if (validateUnit(d)) { store.saveUnitContent(unitId, d); return d; }
  }
  throw new Error("Ünite içeriği üretilemedi (geçersiz cevap). Tekrar deneyin.");
}

export function addUnitVocab(unitId, content) {
  for (const w of content.vocab || []) store.addWord(w.word, w.reading || "", w.meaning_tr || "", w.example || "", w.example_tr || "", unitId);
}

// Rol yapmayı karşıdaki kişinin açılış repliğiyle başlatır (yapay zekâya gitmeden).
export function startRoleplay(sessionId, content) {
  const d = { reply: content.roleplay.opening || "…", reply_tr: "", correction: null, new_words: [], goal_reached: false };
  store.addMessage(sessionId, "assistant", d.reply, JSON.stringify(d));
  return d;
}

export async function checkWriting(unitId, content, text) {
  const u = cur.unit(unitId);
  const raw = await chat(store.settings(), `Sen titiz ama cesaret verici bir ${pack.nameTr} öğretmenisin.`,
    [{ role: "user", content: P.WRITING_CHECK(u, content.writing.task_tr, text) }], 2000);
  const d = extractJson(raw) || { corrected: "", comments: [], praise_tr: raw, score: 0.5 };
  for (const c of d.comments || []) if (c && c.original) store.addMistake(c.category, c.original, c.corrected || "", c.explanation_tr || "");
  let score = Number(d.score); if (!(score >= 0 && score <= 1)) score = 0.5;
  d.score = score;
  store.markStep(unitId, "writing", score);
  return d;
}

// ---------------- ➕ kullanıcının kendi programı ----------------
function levelText() {
  const est = store.get("level_estimate"), self = store.profile().level_self;
  return est || (self === "0" ? "yeni başlıyor" : self) || "";
}
const clean = (x, n = 300) => String(x ?? "").trim().slice(0, n);
function cleanUnit(u) {
  if (!u || typeof u !== "object" || !u.title_tr || !u.scenario_tr) return null;
  return { title: clean(u.title || u.title_tr, 120), title_tr: clean(u.title_tr, 120), scenario_tr: clean(u.scenario_tr, 400),
           can_do_tr: clean(u.can_do_tr, 300), grammar: (Array.isArray(u.grammar) ? u.grammar : []).map(g => clean(g, 120)).filter(Boolean).slice(0, 4) };
}
function cleanLevel(lv) {
  const units = (Array.isArray(lv?.units) ? lv.units : []).map(cleanUnit).filter(Boolean);
  return units.length ? { title_tr: clean(lv.title_tr || "Bölüm", 120), band: clean(lv.band || "", 20), units } : null;
}

// Öneri: { title_tr, desc_tr, levels } (henüz kimliksiz). previous/change: yeniden öneri için.
export async function proposeProgram({ request, count, previous = null, change = "" }) {
  const prompt = P.PROGRAM_GEN({ request, count, level: levelText() || "bilinmiyor", profile: store.profile(),
                                 previous: previous ? JSON.stringify(previous) : null, change });
  for (let i = 0; i < 2; i++) {
    const d = extractJson(await chat(store.settings(), `Sen deneyimli bir ${pack.nameTr} öğretmeni ve program tasarımcısısın.`,
      [{ role: "user", content: prompt }], 6000));
    const levels = (Array.isArray(d?.levels) ? d.levels : []).map(cleanLevel).filter(Boolean);
    if (d?.title_tr && levels.length) return { title_tr: clean(d.title_tr, 120), desc_tr: clean(d.desc_tr, 400), levels };
  }
  throw new Error("Program önerisi üretilemedi. Tekrar deneyin.");
}

// Öneriye kimlik verir ve kaydeder; programı seçili program yapar.
export function saveProgram(proposal, request) {
  const id = cur.newTrackId();
  const t = { id, title_tr: proposal.title_tr, desc_tr: proposal.desc_tr, request_tr: clean(request, 1500),
              created: new Date().toISOString(), next_no: 1, levels: [] };
  for (const lv of proposal.levels) appendLevel(t, lv);
  store.saveCustomTrack(t);
  cur.setTrack(id);
  return t;
}
function appendLevel(t, lv) {
  const n = t.levels.length + 1;
  t.levels.push({ id: `${t.id}-B${n}`, title_tr: lv.title_tr, band: lv.band,
                  units: lv.units.map(u => ({ ...u, id: `${t.id}-${String(t.next_no++).padStart(2, "0")}` })) });
}

// "Devamını oluştur": programa yeni bir bölüm önerir (kaydetmez).
export async function proposeMore(trackId, { count = 6, focus = "" } = {}) {
  const t = store.customTracks().find(x => x.id === trackId);
  if (!t) throw new Error("Program bulunamadı.");
  const prompt = P.UNITS_MORE({ track: t, count, level: levelText() || "bilinmiyor", done: store.completedUnits(),
                                mistakes: store.mistakeStats(3).map(m => m.category).join(", ") || "henüz yok", focus });
  for (let i = 0; i < 2; i++) {
    const lv = cleanLevel(extractJson(await chat(store.settings(), `Sen deneyimli bir ${pack.nameTr} öğretmeni ve program tasarımcısısın.`,
      [{ role: "user", content: prompt }], 5000)));
    if (lv) return lv;
  }
  throw new Error("Yeni üniteler üretilemedi. Tekrar deneyin.");
}
export function addLevel(trackId, lv) {
  const t = structuredClone(store.customTracks().find(x => x.id === trackId));
  appendLevel(t, lv);
  store.saveCustomTrack(t);
  return t;
}
export function removeUnit(unitId) {
  for (const t0 of store.customTracks()) {
    const t = structuredClone(t0);
    let hit = false;
    for (const lv of t.levels) { const n = lv.units.length; lv.units = lv.units.filter(u => u.id !== unitId); hit ||= lv.units.length !== n; }
    if (hit) { t.levels = t.levels.filter(lv => lv.units.length); store.saveCustomTrack(t); store.deleteUnitContent(unitId); return t; }
  }
  return null;
}

// Programı paylaşmak/saklamak için dosya (ilerleme ve üretilmiş içerik girmez; yalnızca program tanımı)
export function exportProgram(trackId) {
  const t = store.customTracks().find(x => x.id === trackId);
  return JSON.stringify({ app: "Kotonoha", type: "program", lang: pack.code, version: 1,
    program: { title_tr: t.title_tr, desc_tr: t.desc_tr, request_tr: t.request_tr,
               levels: t.levels.map(lv => ({ title_tr: lv.title_tr, band: lv.band, units: lv.units.map(({ id, ...u }) => u) })) } }, null, 1);
}
export function importProgram(text) {
  const o = JSON.parse(text);
  if (o.app !== "Kotonoha" || o.type !== "program" || !o.program) throw new Error("Bu bir Kotonoha program dosyası değil.");
  if (o.lang !== pack.code) throw new Error(`Bu program ${String(o.lang).toUpperCase()} sürümü için; buraya yüklenemez.`);
  const levels = (o.program.levels || []).map(cleanLevel).filter(Boolean);
  if (!levels.length) throw new Error("Program dosyasında ünite yok.");
  return saveProgram({ title_tr: clean(o.program.title_tr, 120) || "Program", desc_tr: clean(o.program.desc_tr, 400), levels }, o.program.request_tr || "");
}
