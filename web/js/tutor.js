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
  const est = store.get("level_estimate"), self = store.profile().level_self;
  const level = est || (self === "0" ? "yeni başlıyor" : self) || "bilinmiyor (ünitenin seviyesini esas al)";
  const mistakes = store.mistakeStats(3).map(m => m.category).join(", ") || "henüz yok";
  const prompt = P.UNIT_GEN({ u, level, profile: store.profile(), mistakes });
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
