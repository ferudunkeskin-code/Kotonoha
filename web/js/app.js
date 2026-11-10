// Kotonoha web — arayüz denetleyicisi.
import * as store from "./store.js";
import * as tutor from "./tutor.js";
import * as furi from "./furigana.js";
import * as speech from "./speech.js";
import { Avatar } from "./avatar.js";
import { LLMError } from "./llm.js";

export const APP_VERSION = "0.1.0-web";
const esc = furi.esc;
const $ = s => document.querySelector(s);

const ui = {
  content: $("#content"), main: $("#main"), title: $("#title"), input: $("#input"),
  send: $("#btn-send"), mic: $("#btn-mic"), tr: $("#chk-tr"), furi: $("#sel-furi"),
  name: $("#char-name"), toast: $("#toast"),
};
const avatar = new Avatar($("#avatar"));

const state = {
  mode: "home", sessionId: null, chat: [], speak: [], gen: 0, busy: false, stopListen: null,
};

// ================= yardımcılar =================
let toastTimer;
function toast(msg, ms = 3500) {
  ui.toast.textContent = msg;
  ui.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove("show"), ms);
}

const S = () => store.settings();
const ja = text => furi.toRuby(text, S().furigana, S().furigana === "unknown" ? store.knownWords() : new Set());
const TOGGLE = '<button class="toggle" data-act="tr">TR</button>';

function scrollBottom() { ui.main.scrollTop = ui.main.scrollHeight; }

function setInput(enabled, placeholder) {
  ui.input.disabled = !enabled;
  ui.send.disabled = !enabled || state.busy;
  ui.mic.disabled = !enabled;
  if (placeholder) ui.input.placeholder = placeholder;
}

function setBusy(on) {
  state.busy = on;
  avatar.setThinking(on);
  ui.send.disabled = on || ui.input.disabled;
  $("#thinking")?.remove();
  if (on) {
    ui.content.insertAdjacentHTML("beforeend",
      `<div id="thinking" class="thinking">${esc(S().character_name)} düşünüyor…</div>`);
    scrollBottom();
  }
}

function guard(fn) {
  const g = state.gen;
  return (...a) => { if (g === state.gen) fn(...a); };
}

function speakText(text, i) {
  speech.speak(text, {
    voiceName: S().voice_name, rate: Number(S().rate) || 0.9, silent: !S().voice_on,
    onMouth: m => avatar.setMouth(m),
  });
}

function addSpeak(text) { state.speak.push(text); return state.speak.length - 1; }

function errorCard(msg) { return `<div class="card warn">⚠️ ${esc(msg)}</div>`; }

function showError(e) {
  setBusy(false);
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("API_KEY_MISSING")) {
    ui.content.insertAdjacentHTML("beforeend", errorCard("API anahtarı girilmemiş. ⚙️ Ayarlar'dan ekleyin."));
  } else {
    ui.content.insertAdjacentHTML("beforeend", errorCard(msg));
  }
  scrollBottom();
}

// ================= ekranlar arası geçiş =================
function setMode(mode, title) {
  state.gen++;
  if (state.busy) setBusy(false);
  stopListening();
  speech.stop();
  endSession();
  state.mode = mode;
  state.chat = [];
  state.speak = [];
  ui.title.textContent = title;
  document.querySelectorAll("#nav button").forEach(b => b.classList.toggle("on", b.dataset.nav === mode));
  setInput(mode === "free");
  ui.main.scrollTop = 0;
}

function endSession() {
  const sid = state.sessionId;
  state.sessionId = null;
  if (sid && store.userMessageCount(sid) >= 3 && store.apiKey()) {
    tutor.summarize(sid).catch(() => {});
  }
}

async function catchUpSummaries() {
  if (!store.apiKey()) return;
  for (const sid of store.unsummarizedSessions(3)) {
    try { await tutor.summarize(sid); } catch (e) { return; }
  }
}

// ================= ana sayfa =================
function showHome() {
  setMode("home", "Ana sayfa");
  const s = S();
  const stats = store.vocabStats();
  const level = store.get("level_estimate");
  let html = `<h2>こんにちは${s.learner_name ? "、" + esc(s.learner_name) + "さん" : ""}！</h2>
    <div class="muted">Ben ${esc(s.character_name)}. Bugün ne çalışalım?</div>`;
  if (!store.apiKey()) html += `<div class="card warn">Başlamak için <b>⚙️ Ayarlar</b>'dan bir API anahtarı girin.
    <br><button class="btn" data-nav="settings">Ayarlara git</button></div>`;
  if (!furi.ready()) html += `<div class="card muted">Furigana sözlüğü yükleniyor… (ilk açılışta biraz sürer)</div>`;
  if (s.voice_on && speech.ttsAvailable() && !speech.japaneseVoices().length)
    html += `<div class="card warn">Bu cihazda Japonca ses bulunamadı. iPad'de: Ayarlar → Erişilebilirlik →
      Seslendirilen İçerik → Sesler → Japonca → Kyoko.</div>`;
  if (store.sessionCount() === 0) html += `<div class="card">👋 İlk kez mi buradasın? Önce <b>serbest sohbet</b>
      yapalım; birkaç mesajda seviyeni anlarım.<br><button class="btn warm" data-nav="free">Sohbete başla</button></div>`;
  else html += `<div class="card">💬 <b>Serbest sohbet</b><br><button class="btn warm" data-nav="free">Sohbete başla</button></div>`;
  html += `<div class="card">📘 <b>Üniteler</b> ve 🔁 <b>kelime tekrarı</b> bir sonraki sürümde geliyor.
    <div class="muted">Şimdilik sohbette öğrenilen kelimeler biriktiriliyor: ${stats.total} kelime.</div></div>`;
  if (level) html += `<div class="muted">Tahmini seviye: ${esc(level)}</div>`;
  ui.content.innerHTML = html;
}

// ================= serbest sohbet =================
function startFree() {
  setMode("free", "💬 Serbest sohbet");
  setInput(true, "Japonca yaz… (Türkçe soru da sorabilirsin)");
  state.sessionId = store.newSession("free");
  renderChat();
  ask("");
}

function renderChat() {
  let html = `<h2>自由会話 · Serbest sohbet</h2><div class="muted">İstediğin konuda yaz.
    Hatalarını en fazla birer birer düzeltirim; yeni kelimeler tekrar listene eklenir.</div>`;
  for (const item of state.chat) html += item.type === "user" ? userMsg(item.text) : aiMsg(item.data, item.speak);
  ui.content.innerHTML = html;
  if (state.busy) setBusy(true);
  scrollBottom();
}

function userMsg(text) {
  return `<div class="msg me"><div class="b">${esc(text).replace(/\n/g, "<br>")}</div></div>`;
}

function aiMsg(d, si) {
  const tr = d.reply_tr ? `${TOGGLE}<div class="tr">${esc(d.reply_tr)}</div>` : "";
  let fix = "";
  const c = d.correction;
  if (c) fix = `<div class="fix">✏️ 「${esc(c.original)}」 → <b>「${ja(c.corrected)}」</b><br>${esc(c.explanation_tr)}</div>`;
  let words = "";
  const nw = (d.new_words || []).filter(w => w && typeof w === "object");
  if (nw.length) words = `<div class="muted" style="margin-top:6px">Yeni: ` + nw.map(w =>
    `<span class="pill">${esc(w.word)}（${esc(w.reading)}） ${esc(w.meaning_tr)}</span>`).join(" ") + "</div>";
  return `<div class="msg ai"><div class="b"><span class="ja">${ja(d.reply_ja)}</span>
    <button class="icon" data-act="say" data-i="${si}" title="Seslendir">🔊</button>${tr}${fix}${words}</div></div>`;
}

function send() {
  const text = ui.input.value.trim();
  if (!text || state.busy || ui.input.disabled) return;
  stopListening();
  ui.input.value = "";
  state.chat.push({ type: "user", text });
  ui.content.insertAdjacentHTML("beforeend", userMsg(text));
  scrollBottom();
  ask(text);
}

function ask(text) {
  if (!store.apiKey()) { showError(new LLMError("API_KEY_MISSING")); return; }
  setBusy(true);
  tutor.converse(state.sessionId, text)
    .then(guard(onReply))
    .catch(guard(showError));
}

function onReply(d) {
  setBusy(false);
  const si = addSpeak(d.reply_ja);
  state.chat.push({ type: "ai", data: d, speak: si });
  ui.content.insertAdjacentHTML("beforeend", aiMsg(d, si));
  scrollBottom();
  speakText(d.reply_ja, si);
}

// ================= mikrofon =================
function stopListening() {
  if (state.stopListen) { const f = state.stopListen; state.stopListen = null; f(); }
  ui.mic.classList.remove("rec");
  ui.mic.textContent = "🎤";
}

function toggleMic() {
  if (state.stopListen) { stopListening(); return; }
  if (!speech.sttAvailable()) {
    toast("Bu tarayıcıda konuşma tanıma yok. Klavyedeki 🎤 (dikte) tuşunu kullanabilirsiniz.", 6000);
    return;
  }
  if (state.busy || ui.input.disabled) return;
  const base = ui.input.value.trim();
  ui.mic.classList.add("rec");
  ui.mic.textContent = "⏹";
  toast("🎤 Dinliyorum… Bitince ⏹'e bas.");
  state.stopListen = speech.listen({
    onText: (t, final) => {
      ui.input.value = (base ? base + " " : "") + t;
      if (final && t) toast("Yazıyı kontrol et, sonra Gönder.", 4000);
    },
    onEnd: () => { state.stopListen = null; ui.mic.classList.remove("rec"); ui.mic.textContent = "🎤"; },
    onError: msg => toast(msg, 6000),
  });
}

// ================= ilerleme =================
function showProgress() {
  setMode("progress", "📈 İlerleme");
  const st = store.vocabStats();
  const mist = store.mistakeStats(8).map(m =>
    `<tr><td>${esc(m.category)}</td><td>${m.count}</td><td>「${esc(m.original)}」→「${esc(m.corrected)}」</td></tr>`).join("");
  const facts = store.facts(20).map(f => `<span class="pill">${esc(f)}</span>`).join("");
  const sums = store.recentSummaries(6).map(s => `<li>${esc(s)}</li>`).join("");
  ui.content.innerHTML = `<h2>İlerleme</h2>
    <div class="card"><b>Tahmini seviye:</b> ${esc(store.get("level_estimate") || "henüz belli değil")}</div>
    <div class="card"><b>Kelimeler</b><br>Toplam ${st.total} · İyi bilinen ${st.known} · Tekrar bekleyen ${st.due}</div>
    <div class="card"><b>Sık yapılan hatalar</b>${mist ? `<table><tr><th>Tür</th><th>Sayı</th><th>Son örnek</th></tr>${mist}</table>`
      : '<div class="muted">Henüz kayıt yok.</div>'}</div>
    <div class="card"><b>${esc(S().character_name)} seni nasıl tanıyor</b><div>${facts || '<span class="muted">Henüz bir şey öğrenmedi.</span>'}</div></div>
    <div class="card"><b>Son oturumlar</b><ul>${sums || '<li class="muted">Henüz yok</li>'}</ul></div>`;
}

// ================= ayarlar =================
function showSettings() {
  setMode("settings", "⚙️ Ayarlar");
  const s = S();
  const voices = speech.japaneseVoices();
  const vopts = [`<option value="">Otomatik (Kyoko → O-ren)</option>`]
    .concat(voices.map(v => `<option ${v === s.voice_name ? "selected" : ""}>${esc(v)}</option>`)).join("");
  ui.content.innerHTML = `<h2>Ayarlar</h2><div class="form">
  <div class="card"><b>Yapay zekâ</b>
    <label>Kullanılacak</label>
    <select id="f-provider"><option value="claude">Claude (Anthropic)</option><option value="openai">OpenAI (ChatGPT)</option></select>
    <label>Claude API anahtarı</label><input type="password" id="f-ckey" autocomplete="off" value="${esc(s.claude_key)}">
    <label>Claude modeli</label><input type="text" id="f-cmodel" value="${esc(s.claude_model)}" autocapitalize="off">
    <label>OpenAI API anahtarı</label><input type="password" id="f-okey" autocomplete="off" value="${esc(s.openai_key)}">
    <label>OpenAI modeli</label><input type="text" id="f-omodel" value="${esc(s.openai_model)}" autocapitalize="off">
    <div class="hint">Anahtarlar yalnızca bu cihazda saklanır; yedek dosyasına da girmez.</div>
  </div>
  <div class="card"><b>Karakter ve öğrenci</b>
    <label>Avatarın adı</label><input type="text" id="f-name" value="${esc(s.character_name)}">
    <label>Karakteri</label><textarea id="f-persona">${esc(s.persona)}</textarea>
    <label>Öğrencinin adı</label><input type="text" id="f-learner" value="${esc(s.learner_name)}">
  </div>
  <div class="card"><b>Ses</b>
    <label class="row"><input type="checkbox" id="f-voice" ${s.voice_on ? "checked" : ""}> Avatar sesli konuşsun</label>
    <label>Ses</label><select id="f-vname">${vopts}</select>
    <label>Konuşma hızı: <span id="f-rate-v">${Number(s.rate).toFixed(2)}</span></label>
    <input type="range" id="f-rate" min="0.6" max="1.2" step="0.05" value="${s.rate}" style="width:100%">
    <button class="btn alt" data-act="test-voice">▶ Dene</button>
    ${voices.length ? "" : '<div class="hint">Japonca ses bulunamadı. iPad: Ayarlar → Erişilebilirlik → Seslendirilen İçerik → Sesler → Japonca.</div>'}
  </div>
  <div class="card"><b>Yedekleme</b>
    <div class="hint">Hafıza ve kelime ilerlemesi yalnızca bu cihazda durur. Ara sıra yedek alın.</div>
    <button class="btn alt" data-act="export">⬇ Yedeği indir</button>
    <label class="btn alt" style="margin-top:6px">⬆ Yedekten geri yükle<input type="file" id="f-import" accept=".json,application/json" hidden></label>
  </div>
  <button class="btn warm" data-act="save-settings">Kaydet</button>
  <div class="muted" style="margin-top:20px">Kotonoha ${APP_VERSION}</div></div>`;
  $("#f-provider").value = s.provider;
  $("#f-rate").oninput = e => { $("#f-rate-v").textContent = Number(e.target.value).toFixed(2); };
  $("#f-import").onchange = importBackup;
}

function readSettingsForm() {
  const v = id => $(id).value.trim();
  return {
    provider: $("#f-provider").value,
    claude_key: v("#f-ckey"), claude_model: v("#f-cmodel") || "claude-sonnet-5-5",
    openai_key: v("#f-okey"), openai_model: v("#f-omodel") || "gpt-4o",
    character_name: v("#f-name") || "Kotonoha", persona: v("#f-persona"), learner_name: v("#f-learner"),
    voice_on: $("#f-voice").checked, voice_name: $("#f-vname").value, rate: Number($("#f-rate").value),
  };
}

function saveSettings() {
  const f = readSettingsForm();
  if (!f.claude_key && !f.openai_key) { toast("En az bir API anahtarı girmelisiniz."); return; }
  for (const [k, val] of Object.entries(f)) store.setSetting(k, val);
  store.saveNow();
  applySettings();
  toast("Ayarlar kaydedildi.");
  catchUpSummaries();
}

function testVoice() {
  const f = readSettingsForm();
  speech.speak(`こんにちは。わたしは${f.character_name === "Kotonoha" ? "コトノハ" : f.character_name}です。よろしくお願いします。`, {
    voiceName: f.voice_name, rate: f.rate, silent: !f.voice_on, onMouth: m => avatar.setMouth(m),
  });
}

function exportBackup() {
  const blob = new Blob([store.exportJSON()], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `kotonoha-yedek-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}

function importBackup(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  if (!confirm("Bu cihazdaki hafıza, yedekteki ile değiştirilsin mi?")) return;
  file.text().then(t => {
    store.importJSON(t);
    applySettings();
    toast("Yedek geri yüklendi.");
    showSettings();
  }).catch(err => toast("Yedek okunamadı: " + err.message, 6000));
}

function applySettings() {
  const s = S();
  ui.name.textContent = s.character_name;
  ui.tr.checked = !!s.show_tr;
  document.body.classList.toggle("show-tr", !!s.show_tr);
  ui.furi.value = s.furigana;
}

// ================= olaylar =================
ui.content.addEventListener("click", e => {
  const t = e.target.closest("[data-act],[data-nav]");
  if (!t) return;
  if (t.dataset.nav) { go(t.dataset.nav); return; }
  const act = t.dataset.act;
  if (act === "say") { const i = Number(t.dataset.i); if (state.speak[i]) speakText(state.speak[i], i); }
  else if (act === "tr") t.parentNode.querySelector(".tr")?.classList.toggle("open");
  else if (act === "save-settings") saveSettings();
  else if (act === "test-voice") testVoice();
  else if (act === "export") exportBackup();
});

function go(nav) {
  if (nav === "home") showHome();
  else if (nav === "free") startFree();
  else if (nav === "progress") showProgress();
  else if (nav === "settings") showSettings();
}
document.querySelectorAll("#nav button").forEach(b => b.addEventListener("click", () => go(b.dataset.nav)));

ui.send.addEventListener("click", send);
ui.mic.addEventListener("click", toggleMic);
ui.input.addEventListener("keydown", e => {
  // Japonca klavyede dönüşüm sırasında Enter göndermesin
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); send(); }
});
ui.tr.addEventListener("change", () => {
  store.setSetting("show_tr", ui.tr.checked);
  document.body.classList.toggle("show-tr", ui.tr.checked);
});
ui.furi.addEventListener("change", () => {
  store.setSetting("furigana", ui.furi.value);
  if (state.mode === "free") renderChat();
});
// iPad'de ses ilk dokunuşla açılır
document.addEventListener("pointerdown", () => speech.unlock(), { once: true, capture: true });
document.addEventListener("visibilitychange", () => { if (document.hidden) store.saveNow(); });

// ================= başlangıç =================
applySettings();
showHome();
store.requestPersist();
furi.init().then(t => {
  if (state.mode === "home") showHome();
  else if (state.mode === "free") renderChat();
  if (!t) toast("Furigana sözlüğü yüklenemedi; metinler furiganasız gösterilecek.", 6000);
});
catchUpSummaries();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
