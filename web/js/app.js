// Kotonoha web — arayüz denetleyicisi.
import * as store from "./store.js";
import * as tutor from "./tutor.js";
import { TEXT_TASKS } from "./prompts.js";
import * as furi from "./furigana.js";
import * as speech from "./speech.js";
import { Avatar } from "./avatar.js";
import { LLMError, chat, cleanKey, describeKey } from "./llm.js";
import { VoiceMode, voiceModeAvailable } from "./voicemode.js";

export const APP_VERSION = "0.3.0-web";
const esc = furi.esc;
const $ = s => document.querySelector(s);

const ui = {
  content: $("#content"), main: $("#main"), title: $("#title"), input: $("#input"),
  send: $("#btn-send"), mic: $("#btn-mic"), tr: $("#chk-tr"), furi: $("#sel-furi"),
  name: $("#char-name"), toast: $("#toast"), voice: $("#btn-voice"),
  vbar: $("#vbar"), vstate: $("#vbar-state"), vtext: $("#vbar-text"),
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
  ui.mic.disabled = !enabled || vm.on;
  ui.voice.disabled = !enabled;
  if (placeholder) ui.input.placeholder = placeholder;
}

function setBusy(on) {
  state.busy = on;
  avatar.setThinking(on);
  ui.send.disabled = on || ui.input.disabled;
  $("#thinking")?.remove();
  if (vm.state === "waiting") ui.vtext.textContent = on ? "düşünüyor…" : "konuşuyor…";
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

function speakText(text, i, onEnd = () => {}) {
  speech.speak(text, {
    voiceName: S().voice_name, rate: Number(S().rate) || 0.9, silent: !S().voice_on,
    onMouth: m => avatar.setMouth(m), onEnd,
  });
}

function addSpeak(text) { state.speak.push(text); return state.speak.length - 1; }

function errorCard(msg) { return `<div class="card warn">⚠️ ${esc(msg)}</div>`; }

function showError(e) {
  setBusy(false);
  if (vm.on) {
    // Konuşma modunda hata: anahtar yoksa kapat, değilse dinlemeye dön.
    const m = e instanceof Error ? e.message : String(e);
    if (m.includes("API_KEY_MISSING") || m.includes("401")) vm.stop(); else vm.resume(1500);
  }
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
  if (vm.on) vm.stop();
  state.gen++;
  if (state.busy) setBusy(false);
  stopListening();
  speech.stop();
  endSession();
  state.mode = mode;
  state.header = null;
  state.task = null;
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
    // Özet birkaç saniye sürer; bitince İlerleme ekranı açıksa kendini yeniler.
    state.summarizing = tutor.summarize(sid).catch(() => {}).then(() => {
      state.summarizing = null;
      if (state.mode === "progress") showProgress();
    });
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
const FREE_HEADER = `<h2>自由会話 · Serbest sohbet</h2><div class="muted">İstediğin konuda yaz.
    Hatalarını en fazla birer birer düzeltirim; yeni kelimeler tekrar listene eklenir.</div>`;

function startFree() {
  setMode("free", "💬 Serbest sohbet");
  setInput(true, "Japonca yaz… (Türkçe soru da sorabilirsin)");
  state.sessionId = store.newSession("free");
  state.header = () => FREE_HEADER;
  state.task = null;
  renderChat();
  ask("");
}

// ================= 📄 metinle çalış =================
const KINDS = {
  exam: ["🎓 Sözlü sınav provası", "Kotonoha öğretmen olur; metinle ilgili sorular sorar, cevaplarını değerlendirir, sonunda genel bir değerlendirme yapar."],
  talk: ["💬 Metin hakkında sohbet", "Metnin konusunu doğal bir sohbette konuşursunuz; metindeki kelime ve kalıpları kullanmaya teşvik eder."],
  read: ["📖 Sesli okuma", "Metni yüksek sesle okursun (🎤 ya da 🎧 ile); takıldığın ya da yanlış okuduğun yerleri söyler."],
};
const MAX_TEXT = 6000;

function splitSentences(text) {
  return text.split(/(?<=[。！？!?])|\n+/).map(s => s.trim()).filter(Boolean);
}

function showTextSetup() {
  setMode("text", "📄 Metinle çalış");
  const saved = store.get("study_text", "");
  const kind = store.get("study_kind", "exam");
  const radios = Object.entries(KINDS).map(([k, [t, d]]) =>
    `<label><input type="radio" name="kind" value="${k}" ${k === kind ? "checked" : ""}><span><b>${t}</b><br><span class="muted">${d}</span></span></label>`).join("");
  ui.content.innerHTML = `<h2>テキスト練習 · Metinle çalış</h2>
    <div class="muted">Çalışmak istediğin Japonca metni aşağıya yapıştır (sınav metni, ders metni, konuşma konusu…).
    Metin yalnızca bu cihazda saklanır.</div>
    <div class="form">
      <label>Metin</label>
      <textarea id="t-text" style="min-height:180px" placeholder="ここにテキストを貼り付けてください">${esc(saved)}</textarea>
      <div class="hint"><span id="t-count">${saved.length}</span> / ${MAX_TEXT} karakter</div>
      <label>Nasıl çalışalım?</label>
      <div class="kinds">${radios}</div>
      <button class="btn warm" data-act="text-start">Başla</button>
    </div>`;
  $("#t-text").oninput = e => { $("#t-count").textContent = e.target.value.length; };
}

function startTextFromForm() {
  const text = $("#t-text").value.trim().slice(0, MAX_TEXT);
  const kind = document.querySelector('input[name="kind"]:checked')?.value || "exam";
  if (text.length < 5) { toast("Önce bir metin yapıştır."); return; }
  startText(text, kind);
}

function startText(text, kind) {
  store.set("study_text", text);
  store.set("study_kind", kind);
  setMode("text", "📄 " + KINDS[kind][0].slice(2).trim());
  setInput(true, kind === "read" ? "🎤 ya da 🎧 ile metni oku… (yazabilirsin de)" : "Cevabını yaz ya da 🎧 ile konuş…");
  state.sessionId = store.newSession("text:" + kind);
  state.task = TEXT_TASKS[kind](text);
  const sents = splitSentences(text).map(s => ({ s, i: addSpeak(s) }));
  state.header = () => `<h2>${KINDS[kind][0]}</h2>
    <details class="card text-card" ${kind === "read" ? "open" : ""}><summary>📄 Metin (${sents.length} cümle) · 🔊 ile dinle</summary>
      ${sents.map(({ s, i }) => `<div class="sent"><span class="ja">${ja(s)}</span><button class="icon" data-act="say" data-i="${i}">🔊</button></div>`).join("")}
      <button class="btn alt" data-nav="text">✏️ Metni değiştir</button>
    </details>`;
  renderChat();
  ask("");
}

function renderChat() {
  let html = (state.header || (() => FREE_HEADER))();
  for (const item of state.chat) html += item.type === "user" ? userMsg(item.text, item.spoken) : aiMsg(item.data, item.speak);
  ui.content.innerHTML = html;
  if (state.busy) setBusy(true);
  scrollBottom();
}

function userMsg(text, spoken = false) {
  return `<div class="msg me"><div class="b">${esc(text).replace(/\n/g, "<br>")}${spoken ? '<span class="via">🎧</span>' : ""}</div></div>`;
}

function aiMsg(d, si) {
  const final = d.goal_reached && state.mode === "text";   // sınav provasının son değerlendirmesi: hep açık
  const tr = d.reply_tr ? `${TOGGLE}<div class="tr${final ? " open" : ""}">${esc(d.reply_tr)}</div>` : "";
  let fix = "";
  const c = d.correction;
  if (c) fix = `<div class="fix">✏️ 「${esc(c.original)}」 → <b>「${ja(c.corrected)}」</b><br>${esc(c.explanation_tr)}</div>`;
  let words = "";
  const nw = (d.new_words || []).filter(w => w && typeof w === "object");
  if (nw.length) words = `<div class="muted" style="margin-top:6px">Yeni: ` + nw.map(w =>
    `<span class="pill">${esc(w.word)}（${esc(w.reading)}） ${esc(w.meaning_tr)}</span>`).join(" ") + "</div>";
  return `<div class="msg ai"><div class="b"><span class="ja">${ja(d.reply_ja)}</span>
    <button class="icon" data-act="say" data-i="${si}" title="Seslendir">🔊</button>${tr}${fix}${words}
    ${final ? '<div><button class="btn warm" data-act="text-again">🔁 Yeniden prova</button><button class="btn alt" data-nav="text">✏️ Başka metin</button></div>' : ""}</div></div>`;
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
  tutor.converse(state.sessionId, text, { voice: vm.on, task: state.task })
    .then(guard(onReply))
    .catch(guard(showError));
}

function onReply(d) {
  setBusy(false);
  const si = addSpeak(d.reply_ja);
  state.chat.push({ type: "ai", data: d, speak: si });
  ui.content.insertAdjacentHTML("beforeend", aiMsg(d, si));
  scrollBottom();
  speakText(d.reply_ja, si, guard(() => vm.resume()));
}

// ================= 🎧 konuşma modu =================
const STATE_LABEL = {
  listening: "🎧 Dinliyorum…", waiting: "💭", sleeping: "💤 Uykuda — uyandırmak için 「ねえ、コトノハ」",
};
const vm = new VoiceMode({
  onUtterance: text => {
    state.chat.push({ type: "user", text, spoken: true });
    ui.content.insertAdjacentHTML("beforeend", userMsg(text, true));
    scrollBottom();
    ask(text);
  },
  onState: (st, detail) => {
    ui.vbar.hidden = st === "off";
    ui.vbar.className = st;
    ui.voice.classList.toggle("on", st !== "off");
    ui.mic.disabled = st !== "off" || ui.input.disabled;
    ui.vstate.textContent = STATE_LABEL[st] || "";
    ui.vtext.textContent = st === "listening" ? detail : st === "waiting" ? (state.busy ? "düşünüyor…" : "konuşuyor…") : "";
    if (st === "off") avatar.setSleeping(false);
  },
  onSleep: () => {
    speech.stop();
    avatar.setSleeping(false);
    speakText("おやすみなさい。またね！", -1, () => { avatar.setSleeping(true); vm.listenForWake(); });
  },
  onWake: () => {
    avatar.setSleeping(false);
    speakText("はい！おかえりなさい。", -1, () => vm.resume());
  },
  onError: msg => toast(msg, 6000),
});

function toggleVoice() {
  if (vm.on) { vm.stop(); speech.stop(); toast("Konuşma modu kapandı."); return; }
  if (!voiceModeAvailable()) { toast("Bu tarayıcıda konuşma tanıma yok.", 5000); return; }
  if (ui.input.disabled) return;
  stopListening();
  speech.unlock();
  vm.start();
  if (state.busy) vm.pause();     // cevap bekleniyorsa, cevaptan sonra dinlemeye başlar
  toast("🎧 Konuşma modu açık. Konuş; kısa bir sessizlikten sonra kendiliğinden gönderilir. Uyutmak için 「おやすみ」.", 7000);
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
    ${state.summarizing ? '<div class="card muted">⏳ Son sohbetin özeti çıkarılıyor; bu sayfa birazdan kendini yenileyecek.</div>' : ""}
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
    <label>Claude API anahtarı</label><input type="password" id="f-ckey" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" value="${esc(s.claude_key)}">
    <div class="hint">Kayıtlı: ${esc(describeKey(s.claude_key))}</div>
    <label>Claude modeli</label><input type="text" id="f-cmodel" value="${esc(s.claude_model)}" autocapitalize="off">
    <label>OpenAI API anahtarı</label><input type="password" id="f-okey" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" value="${esc(s.openai_key)}">
    <label>OpenAI modeli</label><input type="text" id="f-omodel" value="${esc(s.openai_model)}" autocapitalize="off">
    <button class="btn alt" data-act="test-key">🔌 Bağlantıyı dene</button>
    <div id="f-keytest" class="hint"></div>
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
    claude_key: cleanKey(v("#f-ckey")), claude_model: v("#f-cmodel") || "claude-sonnet-5-5",
    openai_key: cleanKey(v("#f-okey")), openai_model: v("#f-omodel") || "gpt-4o",
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

async function testKey() {
  const f = readSettingsForm();
  const out = $("#f-keytest");
  const key = f.provider === "openai" ? f.openai_key : f.claude_key;
  out.textContent = `Deneniyor… anahtar: ${describeKey(key)}`;
  try {
    const reply = await chat({ ...S(), ...f }, "Kısa cevap ver.", [{ role: "user", content: "「はい」とだけ答えて" }], 20);
    out.innerHTML = `✅ Bağlantı çalışıyor. Cevap: ${esc(reply)} — şimdi <b>Kaydet</b>'e basın.`;
  } catch (e) {
    out.textContent = `❌ ${e.message}  ·  Anahtar: ${describeKey(key)}`;
  }
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
  else if (act === "test-key") testKey();
  else if (act === "text-start") startTextFromForm();
  else if (act === "text-again") startText(store.get("study_text", ""), store.get("study_kind", "exam"));
  else if (act === "export") exportBackup();
});

function go(nav) {
  if (nav === "home") showHome();
  else if (nav === "free") startFree();
  else if (nav === "text") showTextSetup();
  else if (nav === "progress") showProgress();
  else if (nav === "settings") showSettings();
}
document.querySelectorAll("#nav button").forEach(b => b.addEventListener("click", () => go(b.dataset.nav)));

ui.send.addEventListener("click", send);
ui.voice.addEventListener("click", toggleVoice);
$("#vbar-off").addEventListener("click", () => { vm.stop(); speech.stop(); });
// Avatar konuşurken avatara dokunmak: sustur ve dinlemeye geç
$("#avatar").addEventListener("click", () => {
  if (vm.state === "waiting" && !state.busy) { speech.stop(); vm.resume(100); }
  else if (vm.state === "sleeping") { speech.stop(); vm.wake(); }
});
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
  if (state.mode === "free" || (state.mode === "text" && state.sessionId)) renderChat();
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
