// Ders motoru: yapay zekâ + hafıza (masaüstündeki tutor/engine.py'nin karşılığı).
import * as store from "./store.js";
import { chat, extractJson } from "./llm.js";
import * as P from "./prompts.js";

export function learnerContext() {
  const lines = [`- Tahmini seviye: ${store.get("level_estimate") || "henüz bilinmiyor"}`];
  for (const f of store.facts(12)) lines.push(`- ${f}`);
  const ms = store.mistakeStats(5);
  if (ms.length) {
    lines.push("- Sık yaptığı hatalar:");
    for (const m of ms) lines.push(`  * ${m.category} (${m.count} kez), örn. 「${m.original}」→「${m.corrected}」`);
  }
  const sums = store.recentSummaries(3);
  if (sums.length) { lines.push("- Son oturumlar:"); for (const s of sums) lines.push(`  * ${s}`); }
  return lines.join("\n");
}

function persona() {
  const s = store.settings();
  return P.PERSONA({ name: s.character_name, learner: s.learner_name || "öğrenci",
                     persona: s.persona, context: learnerContext() });
}

export function parseReply(raw) {
  let d = extractJson(raw);
  if (!d || typeof d !== "object" || !d.reply_ja) d = { reply_ja: (raw || "").trim() || "……", reply_tr: "" };
  d.reply_tr ??= "";
  if (!d.correction || typeof d.correction !== "object") d.correction = null;
  if (!Array.isArray(d.new_words)) d.new_words = [];
  d.goal_reached = !!d.goal_reached;
  return d;
}

export async function converse(sessionId, userText, { voice = false, task = null } = {}) {
  const system = persona() + "\n" + (task || P.FREE_TALK) + (voice ? P.VOICE_TALK : "") + P.REPLY_FORMAT;
  if (userText) store.addMessage(sessionId, "user", userText);
  const raw = await chat(store.settings(), system, store.history(sessionId, 24), 1200);
  const d = parseReply(raw);
  store.addMessage(sessionId, "assistant", d.reply_ja, JSON.stringify(d));
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
