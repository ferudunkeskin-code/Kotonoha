// Kotonoha web — arayüz denetleyicisi (üç dil için ortak).
import { pack, PACKS } from "./lang/index.js";
import { buildShell } from "./shell.js";
import * as store from "./store.js";
import * as tutor from "./tutor.js";
import { TEXT_TASKS, GOALS } from "./prompts.js";
import * as furi from "./furigana.js";
import * as speech from "./speech.js";
import { Avatar } from "./avatar.js";
import { LLMError, chat, cleanKey, describeKey } from "./llm.js";
import { VoiceMode, voiceModeAvailable } from "./voicemode.js";
import * as cloud from "./cloud.js";
import * as cur from "./curriculum.js";
import * as P from "./prompts.js";

export const APP_VERSION = "0.6.3-web";
const ROOT = new URL("../", import.meta.url);      // sitenin kökü (web/), dil klasöründen bağımsız
const esc = furi.esc;
const $ = s => document.querySelector(s);

buildShell(pack);

const ui = {
  content: $("#content"), main: $("#main"), title: $("#title"), input: $("#input"),
  send: $("#btn-send"), mic: $("#btn-mic"), tr: $("#chk-tr"), furi: $("#sel-furi"),
  name: $("#char-name"), toast: $("#toast"), voice: $("#btn-voice"),
  vbar: $("#vbar"), vstate: $("#vbar-state"), vtext: $("#vbar-text"),
  vhold: $("#vbar-hold"), vsend: $("#vbar-send"), vclear: $("#vbar-clear"), vpause: $("#vbar-pause"),
  vrepeat: $("#vbar-repeat"), vcount: $("#vbar-count i"), sttlang: $("#btn-sttlang"), vlang: $("#vbar-lang"),
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
const [QA, QB] = pack.q;
const quote = s => `${QA}${s}${QB}`;
// Hedef dildeki metni ekrana hazırlar: Japoncada furigana, diğerlerinde düz metin.
const tl = text => pack.furigana
  ? furi.toRuby(text, S().furigana, S().furigana === "unknown" ? store.knownWords() : new Set())
  : esc(text).replace(/\n/g, "<br>");
// Tek satırın Türkçesini aç/kapat. Üstteki "Türkçe" kutusu işaretliyken hepsi açık olduğundan bu düğmeler gizlenir.
const TOGGLE = '<button class="toggle" data-act="tr" title="Bu satırın Türkçesini göster">Türkçesi</button>';
const FLAGS = { ja: "🇯🇵", de: "🇩🇪", en: "🇬🇧", tr: "🇹🇷" };

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

function speakText(text, i, onEnd = () => {}, rate = Number(S().rate) || 0.9, pitch = 1) {
  speech.speak(text, {
    voiceName: S().voice_name, rate, pitch, silent: !S().voice_on,
    onMouth: m => avatar.setMouth(m), onEnd,
  });
}

function addSpeak(text, pitch = 1) {
  state.speak.push(text);
  (state.speakPitch ||= [])[state.speak.length - 1] = pitch;
  return state.speak.length - 1;
}

function errorCard(msg, guide = false) {
  return `<div class="card warn">⚠️ ${esc(msg)}${guide ? '<br><button class="btn alt" data-act="key-guide">🔑 Anahtar nasıl alınır?</button>' : ""}</div>`;
}

function showError(e) {
  setBusy(false);
  if (vm.on) {
    // Konuşma modunda hata: anahtar yoksa kapat, değilse dinlemeye dön.
    const m = e instanceof Error ? e.message : String(e);
    if (m.includes("API_KEY_MISSING") || m.includes("401")) vm.stop(); else vm.resume(1500);
  }
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("API_KEY_MISSING")) {
    ui.content.insertAdjacentHTML("beforeend", errorCard("API anahtarı girilmemiş. ⚙️ Ayarlar'dan ekleyin.", true));
  } else {
    ui.content.insertAdjacentHTML("beforeend", errorCard(msg, msg.includes("401")));
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
  state.speakPitch = [];
  state.playTok = null;
  state.afterListen = null;      // ekran değişirse bekleyen "gönder" iptal
  state.finishing = false;
  ui.title.textContent = title;
  const navOf = { unit: "units", review: "units" }[mode] || mode;
  document.querySelectorAll("#nav button").forEach(b => b.classList.toggle("on", b.dataset.nav === navOf));
  setInput(mode === "free" || mode === "home");
  if (ui.input.disabled) ui.input.placeholder = "";
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
      cloud.backupNow().catch(() => {});
    });
  } else if (sid) cloud.backupNow().catch(() => {});
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
  setInput(true, `Merhaba de… (${pack.nameTr} ya da Türkçe)`);
  const s = S();
  const stats = store.vocabStats();
  const level = store.get("level_estimate");
  let html = `<h2>${esc(pack.greet(s.learner_name))}</h2>
    <div class="muted">Ben ${esc(s.character_name)}, ${esc(pack.nameTr)} konuşma partnerin. Bugün ne çalışalım?</div>`;
  if (!store.apiKey()) html += `<div class="card warn">Başlamak için <b>⚙️ Ayarlar</b>'dan bir API anahtarı girin.
    Anahtarın yoksa nasıl alınacağı orada adım adım anlatılıyor.
    <br><button class="btn" data-nav="settings">Ayarlara git</button><button class="btn alt" data-act="key-guide">🔑 Anahtar nasıl alınır?</button></div>`;
  if (store.get("code_note_pending") && cloud.enabled()) html += `<div class="card ok">☁️ <b>Hafızan artık Google Drive'a
    kendiliğinden yedekleniyor.</b> Uygulamayı silsen ya da yeni bir cihaza geçsen bile bu kodla geri yükleyebilirsin:
    <br><span class="code-box">${esc(cloud.code())}</span>
    <div class="hint">Kodu bir yere not et (Notlar, ekran görüntüsü…). Sonra da ⚙️ Ayarlar → Yedekleme'de görünür.</div>
    <button class="btn" data-act="code-noted">Not ettim</button> <button class="btn alt" data-act="copy-code">📋 Kopyala</button></div>`;
  else if (cloud.fileBackupDue()) html += `<div class="card warn">💾 <b>Son yedeğin üzerinden 7 günden fazla geçti.</b>
    Uygulama silinirse hafıza da silinir; bir yedek al (iPad'de "Dosyalar'a Kaydet" → iCloud Drive).
    <br><button class="btn" data-act="export">⬇ Yedeği al</button> <button class="btn alt" data-act="backup-later">Sonra</button></div>`;
  if (pack.furigana && !furi.ready()) html += `<div class="card muted">Furigana sözlüğü yükleniyor… (ilk açılışta biraz sürer)</div>`;
  if (s.voice_on && speech.ttsAvailable() && speech.voicesKnown() && !speech.targetVoices().length)
    html += `<div class="card warn">Bu cihazda ${esc(pack.nameTr)} ses bulunamadı. iPad'de: Ayarlar → Erişilebilirlik →
      Seslendirilen İçerik → Sesler → ${esc(pack.nameTr)}.</div>`;
  html += `<div class="card">💬 <b>Hemen konuşmaya başla:</b> aşağıya yaz, 🎤 ile söyle ya da 🎧 ile sesli sohbete geç.
    İlk sözü sen söylersin; Türkçe de olur (ör. „Merhaba, bugün nasılsın?“ ya da „Dünkü konuya devam edelim“).
    ${store.sessionCount() === 0 ? '<div class="muted">İlk kez buradasın: birkaç mesajda seviyeni anlarım.</div>' : ""}</div>`;
  const nx = cur.nextUnit(store.completedUnits());
  if (nx) {
    const u = cur.unit(nx);
    html += `<div class="card">📘 <b>Sıradaki ünite:</b> <span class="tl-s">${tl(u.title)}</span> · ${esc(u.title_tr)}
      <div class="muted">${esc(u.scenario_tr)}</div>
      <button class="btn" data-act="unit" data-unit="${nx}">Üniteye git</button> <button class="btn alt" data-nav="units">Tüm üniteler</button></div>`;
  }
  if (stats.due) html += `<div class="card">🔁 Tekrar bekleyen kelime: <b>${stats.due}</b> (toplam ${stats.total})
    <button class="btn alt" data-act="review">Kelime tekrarı</button></div>`;
  if (level) html += `<div class="muted">Tahmini seviye: ${esc(level)}</div>`;
  ui.content.innerHTML = html;
}

// ================= 👤 öğrenci profili =================
function showProfile(first = false) {
  setMode("profile", "👤 Öğrenci profili");
  const s = S();
  const pr = store.profile();
  const levels = [["", "Bilmiyorum — sohbetten anlaşılsın"], ["0", "Hiç bilmiyorum / yeni başlıyorum"],
    ...pack.levels.map(([c, d]) => [c, `${c} — ${d}`])];
  const lvOpts = levels.map(([v, t]) => `<option value="${v}" ${v === (pr.level_self || "") ? "selected" : ""}>${esc(t)}</option>`).join("");
  const goals = Object.entries(GOALS).map(([k, t]) =>
    `<label><input type="checkbox" name="goal" value="${k}" ${pr.goals?.includes(k) ? "checked" : ""}><span>${esc(t)}</span></label>`).join("");
  ui.content.innerHTML = `<h2>${first ? "👋 Hoş geldin!" : "Öğrenci profili"}</h2>
    <div class="muted">${first
      ? `Burada ${esc(pack.nameTr)} konuşma pratiği yapacaksın. Önce seni biraz tanıyayım; ${esc(s.character_name)} sohbetleri buna göre ayarlar.`
      : "Bu bilgiler avatarın seninle nasıl konuşacağını belirler."}
      Bilgiler yalnızca bu cihazda saklanır; istediğin zaman ⚙️ Ayarlar'dan değiştirebilirsin.</div>
    ${first && store.isEmpty() ? restoreCard() : ""}
    <div class="form">
      <label>Adın</label><input type="text" id="p-name" value="${esc(s.learner_name)}" autocomplete="given-name">
      <label>${esc(pack.nameTr)} seviyen <span class="hint">(${esc(pack.levelSystem)})</span></label>
      <select id="p-level">${lvOpts}</select>
      <label>Neden öğreniyorsun? <span class="hint">(birden fazla seçebilirsin)</span></label>
      <div class="kinds goals">${goals}</div>
      <label>Kendinden biraz bahset <span class="hint">(isteğe bağlı)</span></label>
      <textarea id="p-about" placeholder="${esc(pack.aboutPlaceholder)}">${esc(pr.about)}</textarea>
      <label>İlgi alanların <span class="hint">(isteğe bağlı; sohbet konuları buradan seçilir)</span></label>
      <input type="text" id="p-interests" value="${esc(pr.interests)}" placeholder="Ör. çizim, oyunlar, futbol, tarih">
      <button class="btn warm" data-act="profile-save">${first ? "Başlayalım →" : "Kaydet"}</button>
    </div>`;
}

function restoreCard() {
  return `<div class="card restore">🔄 <b>Daha önce kullandın mı?</b> Uygulamayı sildiysen ya da yeni bir cihazdaysan
    hafızanı yedekten geri yükleyebilirsin; o zaman bu formu doldurmana gerek kalmaz.
    ${cloud.configured() ? `<div class="form"><label>Yedek kodun</label>
      <input type="text" id="r-code" value="${esc(cloud.code())}" placeholder="KTN-XXXX-XXXX-XXXX" autocapitalize="characters" autocorrect="off" spellcheck="false"></div>
      <button class="btn" data-act="restore-code">☁️ Drive'dan geri yükle</button>` : ""}
    <label class="btn alt">📂 Yedek dosyası seç<input type="file" id="r-file" accept=".json,application/json" hidden></label>
  </div>`;
}

async function restoreWithCode() {
  const c = cloud.normalizeCode($("#r-code")?.value);
  if (!c) { toast("Kod KTN-XXXX-XXXX-XXXX biçiminde olmalı.", 5000); return; }
  toast("Drive'dan alınıyor…", 8000);
  try {
    await cloud.restoreFrom(c);
    applySettings();
    toast("✅ Hafızan geri yüklendi.");
    showHome();
  } catch (e) {
    if (e.notFound && confirm(`Bu kodda ${pack.nameTr} yedeği yok. Kod bu uygulamaya bağlansın mı? (Yeni başlarsın; bundan sonraki yedekler bu koda gider.)`)) {
      store.setSetting("backup_code", c); store.saveNow(); toast("Kod bağlandı. Şimdi profilini doldur.", 5000);
    } else if (!e.notFound) toast(e.message, 7000);
  }
}

function saveProfile() {
  const goals = [...document.querySelectorAll('input[name="goal"]:checked')].map(i => i.value);
  store.setSetting("learner_name", $("#p-name").value.trim());
  store.setSetting("profile", {
    level_self: $("#p-level").value, goals,
    about: $("#p-about").value.trim().slice(0, 600), interests: $("#p-interests").value.trim().slice(0, 300),
  });
  store.setSetting("profile_done", true);
  ensureBackupCode();
  store.saveNow();
  toast("Profil kaydedildi.");
  showHome();
}

// ================= serbest sohbet =================
const freeHeader = () => `<h2>${esc(pack.titles.free)} · Serbest sohbet</h2><div class="muted">İstediğin konuda yaz.
    Hatalarını en fazla birer birer düzeltirim; yeni kelimeler tekrar listene eklenir.</div>`;

// İlk sözü öğrenci söyler: avatar kendiliğinden açılış yapmaz (karşılıklı konuşma hissi).
// first: ana sayfada yazılıp gönderilen ilk mesaj. Öğrenci isterse "Sen başla" ile avatar açar.
function startFree(first = "") {
  setMode("free", "💬 Serbest sohbet");
  setInput(true, `${pack.nameTr} yaz… (Türkçe de yazabilirsin)`);
  state.sessionId = store.newSession("free");
  state.header = freeHeader;
  state.task = null;
  renderChat();
  if (first) sendText(first);
  else {
    ui.content.insertAdjacentHTML("beforeend", startHint());
    scrollBottom();
  }
}

const startHint = () => `<div class="card start-hint" id="start-hint">👋 İlk sözü sen söyle: yaz, 🎤 ile konuş ya da 🎧 ile
  sesli sohbete geç. Türkçe de olur (ör. „Dünkü konuya devam edelim“).
  <br><button class="btn alt" data-act="avatar-start">🗣 ${esc(S().character_name)} başlasın</button></div>`;

// ================= 📄 metinle çalış =================
const KINDS = () => ({
  exam: ["🎓 Sözlü sınav provası", `${S().character_name} öğretmen olur; metinle ilgili sorular sorar, cevaplarını değerlendirir, sonunda genel bir değerlendirme yapar.`],
  talk: ["💬 Metin hakkında sohbet", "Metnin konusunu doğal bir sohbette konuşursunuz; metindeki kelime ve kalıpları kullanmaya teşvik eder."],
  read: ["📖 Sesli okuma", "Metni yüksek sesle okursun (🎤 ya da 🎧 ile); takıldığın ya da yanlış okuduğun yerleri söyler."],
});
const MAX_TEXT = 6000;

function showTextSetup() {
  setMode("text", "📄 Metinle çalış");
  const saved = store.get("study_text", "");
  const kind = store.get("study_kind", "exam");
  const radios = Object.entries(KINDS()).map(([k, [t, d]]) =>
    `<label><input type="radio" name="kind" value="${k}" ${k === kind ? "checked" : ""}><span><b>${t}</b><br><span class="muted">${esc(d)}</span></span></label>`).join("");
  ui.content.innerHTML = `<h2>${esc(pack.titles.text)} · Metinle çalış</h2>
    <div class="muted">Çalışmak istediğin ${esc(pack.nameTr)} metni aşağıya yapıştır (sınav metni, ders metni, konuşma konusu…).
    Metin yalnızca bu cihazda saklanır.</div>
    <div class="form">
      <label>Metin</label>
      <textarea id="t-text" style="min-height:180px" placeholder="${esc(pack.textPlaceholder)}">${esc(saved)}</textarea>
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
  const kinds = KINDS();
  setMode("text", "📄 " + kinds[kind][0].slice(2).trim());
  setInput(true, kind === "read" ? "🎤 ya da 🎧 ile metni oku… (yazabilirsin de)" : "Cevabını yaz ya da 🎧 ile konuş…");
  state.sessionId = store.newSession("text:" + kind);
  state.task = TEXT_TASKS[kind](text);
  const sents = pack.splitSentences(text).map(s => ({ s, i: addSpeak(s) }));
  state.header = () => `<h2>${kinds[kind][0]}</h2>
    <details class="card text-card" ${kind === "read" ? "open" : ""}><summary>📄 Metin (${sents.length} cümle) · 🔊 ile dinle</summary>
      ${sents.map(({ s, i }) => `<div class="sent"><span class="tl">${tl(s)}</span><button class="icon" data-act="say" data-i="${i}">🔊</button></div>`).join("")}
      <button class="btn alt" data-nav="text">✏️ Metni değiştir</button>
    </details>`;
  renderChat();
  ask("");
}

function renderChat() {
  let html = (state.header || freeHeader)();
  for (const item of state.chat) html += item.type === "user" ? userMsg(item.text, item.spoken)
    : item.type === "html" ? item.html : aiMsg(item.data, item.speak);
  ui.content.innerHTML = html;
  if (state.busy) setBusy(true);
  scrollBottom();
}

function userMsg(text, spoken = false) {
  return `<div class="msg me"><div class="b">${esc(text).replace(/\n/g, "<br>")}${spoken ? '<span class="via">🎧</span>' : ""}</div></div>`;
}

function wordPill(w) {
  const [p1, p2] = pack.paren;
  const rd = w.reading ? `${p1}${esc(w.reading)}${p2}` : "";
  return `<span class="pill">${esc(w.word)}${rd} ${esc(w.meaning_tr)}</span>`;
}

function aiMsg(d, si) {
  const final = d.goal_reached && state.mode === "text";   // sınav provasının son değerlendirmesi: hep açık
  const tr = d.reply_tr ? `${final ? TOGGLE.replace(">Türkçesi<", ">gizle<") : TOGGLE}<div class="tr${final ? " open" : ""}">${esc(d.reply_tr)}</div>` : "";
  let fix = "";
  const c = d.correction;
  if (c) fix = `<div class="fix">✏️ ${quote(esc(c.original))} → <b>${quote(tl(c.corrected))}</b><br>${esc(c.explanation_tr)}</div>`;
  let words = "";
  const nw = (d.new_words || []).filter(w => w && typeof w === "object");
  if (nw.length) words = `<div class="muted" style="margin-top:6px">Yeni: ` + nw.map(wordPill).join(" ") + "</div>";
  return `<div class="msg ai"><div class="b"><span class="tl">${tl(d.reply)}</span>
    <button class="icon" data-act="say" data-i="${si}" title="Seslendir">🔊</button>${tr}${fix}${words}
    ${final ? '<div><button class="btn warm" data-act="text-again">🔁 Yeniden prova</button><button class="btn alt" data-nav="text">✏️ Başka metin</button></div>' : ""}
    ${d.goal_reached && state.mode === "unit" ? `<div class="card ok">🎉 Görevi başardın!</div>${nextBtn()}` : ""}
    ${d.open_unit && cur.unit(d.open_unit) ? `<div><button class="btn" data-act="unit" data-unit="${d.open_unit}">📘 ${esc(cur.unit(d.open_unit).title_tr)} ünitesine git</button></div>` : ""}</div></div>`;
}

function send() {
  // 🎤 açıkken "Gönder": mikrofonu hemen kesersek iPad'in henüz yazıya dökmediği son sözcük kaybolur.
  // Önce kibarca durdur, son sonucu bekle (en çok ~1.5 sn), sonra gönder.
  if (state.stopListen) { finishListeningThenSend(); return; }
  if (state.finishing) return;
  const text = ui.input.value.trim();
  if (!text || state.busy || ui.input.disabled) return;
  stopListening(true);
  ui.input.value = "";
  if (state.mode === "home") { startFree(text); return; }     // ana sayfadan doğrudan sohbete
  sendText(text);
}

function finishListeningThenSend() {
  if (state.finishing) return;
  state.finishing = true;
  ui.send.disabled = true;
  ui.mic.textContent = "⏳";
  const stop = state.stopListen;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    state.afterListen = null;
    state.finishing = false;
    stopListening(true);
    ui.send.disabled = state.busy || ui.input.disabled;
    send();
  };
  state.afterListen = finish;                       // mikrofon kapanınca (son sonuç geldikten sonra) çağrılır
  const timer = setTimeout(finish, 1800);           // iPad kapanmayı bildirmezse yine de gönder
  setTimeout(() => stop?.(false), 300);             // söylenen son sesin işlenmesi için kısa bir pay
}

function sendText(text) {
  $("#start-hint")?.remove();
  state.chat.push({ type: "user", text });
  ui.content.insertAdjacentHTML("beforeend", userMsg(text));
  scrollBottom();
  if (state.mode === "unit" && state.step === "writing") writingCheck(text);
  else ask(text);
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
  state.lastReply = d.reply;
  if (d.goal_reached && state.mode === "unit" && state.step === "roleplay") store.markStep(state.unitId, "roleplay", 1);
  const si = addSpeak(d.reply);
  state.chat.push({ type: "ai", data: d, speak: si });
  ui.content.insertAdjacentHTML("beforeend", aiMsg(d, si));
  scrollBottom();
  speakText(d.reply, si, guard(() => vm.resume()));
  updateVoiceButtons();
}

// ================= 🎧 konuşma modu =================
const stateLabel = st => ({
  listening: S().stt_tr ? "🎧 Dinliyorum (Türkçe)…" : "🎧 Dinliyorum…", waiting: "💭", paused: "⏸ Duraklatıldı — devam için ▶ ya da avatara dokun",
  sleeping: `💤 Uykuda — uyandırmak için ${pack.wakeHint(S().character_name)}`,
}[st] || "");
const vm = new VoiceMode({
  onUtterance: text => {
    $("#start-hint")?.remove();
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
    ui.vstate.textContent = stateLabel(st);
    ui.vtext.textContent = st === "listening" ? detail : st === "waiting" ? (state.busy ? "düşünüyor…" : "konuşuyor…") : "";
    if (st === "off") avatar.setSleeping(false);
    updateVoiceButtons();
  },
  onCountdown: ms => {
    ui.vhold.hidden = !ms;
    const bar = ui.vcount;
    bar.style.transition = "none";
    bar.style.width = ms ? "100%" : "0";
    if (ms) { void bar.offsetWidth; bar.style.transition = `width ${ms}ms linear`; bar.style.width = "0"; }
  },
  onSleep: () => {
    speech.stop();
    avatar.setSleeping(false);
    speakText(pack.sayGoodnight, -1, () => { avatar.setSleeping(true); vm.listenForWake(); });
  },
  onWake: () => {
    avatar.setSleeping(false);
    speakText(pack.sayWelcome, -1, () => vm.resume());
  },
  onError: msg => toast(msg, 6000),
  wakeWords: () => pack.wakeWords(S().character_name),
});

// ---- 🎤 mikrofon dili: hedef dil ↔ Türkçe ----
// Konuşma tanıma aynı anda tek dil dinler; Türkçe konuşmak için bu düğmeyle Türkçeye geçilir.
// Avatar yine hedef dilde cevap verir. Seçim cihazda hatırlanır.
const sttLocale = () => S().stt_tr ? "tr-TR" : pack.locale;
function updateSttLang() {
  const tr = !!S().stt_tr;
  const code = tr ? "tr" : pack.code;
  const label = `${FLAGS[code] || ""}<small>${tr ? "TR" : pack.code.toUpperCase()}</small>`;
  for (const b of [ui.sttlang, ui.vlang]) {
    b.innerHTML = label;
    b.classList.toggle("is-tr", tr);
    b.title = tr ? `Mikrofon Türkçe dinliyor — yeniden ${pack.nameTr} dinlemesi için dokun` : `Mikrofon ${pack.nameTr} dinliyor — Türkçe konuşmak için dokun`;
  }
}
function toggleSttLang() {
  store.setSetting("stt_tr", !S().stt_tr);
  store.saveNow();
  updateSttLang();
  vm.setLang(sttLocale());
  if (state.stopListen) { stopListening(); toast("Mikrofon dili değişti; 🎤'ya yeniden bas.", 3000); return; }
  if (vm.state === "listening") ui.vstate.textContent = stateLabel("listening");
  toast(S().stt_tr
    ? `🇹🇷 Mikrofon artık Türkçe dinliyor. ${S().character_name} yine ${pack.nameTr} cevap verir. Geri dönmek için düğmeye yeniden dokun.`
    : `${FLAGS[pack.code] || ""} Mikrofon yeniden ${pack.nameTr} dinliyor.`, 5000);
}

function updateVoiceButtons() {
  const st = vm.state;
  const hasText = st === "listening" && !!vm.text;
  ui.vsend.hidden = !(hasText && (vm.manual || vm.holding));
  ui.vclear.hidden = !hasText;
  if (vm.holding || vm.manual || !hasText) ui.vhold.hidden = true;
  ui.vpause.textContent = st === "paused" ? "▶ Devam" : "⏸";
  ui.vpause.hidden = st === "sleeping";
  ui.vrepeat.hidden = !state.lastReply || st === "sleeping";
}

// 🔁 Son cevabı biraz daha yavaş tekrarla; bitince (duraklatılmamışsa) dinlemeye dön.
function repeatLast() {
  if (!state.lastReply) return;
  const slow = Math.max(0.6, (Number(S().rate) || 0.9) * 0.85);
  const wasListening = vm.state === "listening";
  if (wasListening) vm.pause();
  speakText(state.lastReply, -1, () => { if (wasListening) vm.resume(200); }, slow);
}

// ---- hız ve sıra geçme süresi: anında kaydedilir, bir sonraki açılışta hatırlanır ----
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
function setRate(r) {
  r = Math.round(clamp(r, 0.6, 1.4) * 100) / 100;
  store.setSetting("rate", r);
  store.saveNow();
  showVoiceSettings();
}
function setWait(ms) {
  ms = Math.round(clamp(ms, 600, 4000) / 100) * 100;
  store.setSetting("silence_ms", ms);
  store.saveNow();
  vm.silenceMs = ms;
  showVoiceSettings();
}
function showVoiceSettings() {
  const s = S();
  $("#vctl-wait").textContent = (s.silence_ms / 1000).toFixed(1);
  $("#vctl-rate").textContent = Number(s.rate).toFixed(2);
  if ($("#f-wait-v")) { $("#f-wait-v").textContent = (s.silence_ms / 1000).toFixed(1); $("#f-wait").value = s.silence_ms / 1000; }
  if ($("#f-rate-v")) { $("#f-rate-v").textContent = Number(s.rate).toFixed(2); $("#f-rate").value = s.rate; }
}
ui.vbar.addEventListener("click", e => {
  const b = e.target.closest("button");
  if (b === ui.vlang) { toggleSttLang(); return; }
  if (b === ui.vhold) { vm.hold(); toast("✋ Acele yok. Konuşmaya devam et; bitince ➤ Gönder'e bas.", 4000); return; }
  if (b === ui.vsend) { vm.send(); return; }
  if (b === ui.vclear) { vm.clearText(); return; }
  if (b === ui.vrepeat) { repeatLast(); return; }
  if (b === ui.vpause) {
    if (vm.state === "paused") vm.unpause();
    else { speech.stop(); vm.pauseByUser(); }
    return;
  }
  const c = e.target.closest("[data-vctl]")?.dataset.vctl;
  if (!c) return;
  if (c === "wait-") setWait(S().silence_ms - 200);
  else if (c === "wait+") setWait(S().silence_ms + 200);
  else if (c === "rate-") setRate(Number(S().rate) - 0.05);
  else if (c === "rate+") setRate(Number(S().rate) + 0.05);
  if (c.startsWith("rate")) toast(`Konuşma hızı ${Number(S().rate).toFixed(2)} (kaydedildi)`, 1500);
  else toast(`Sıra geçme süresi ${(S().silence_ms / 1000).toFixed(1)} sn (kaydedildi)`, 1500);
});

function toggleVoice() {
  if (vm.on) { vm.stop(); speech.stop(); toast("Konuşma modu kapandı."); return; }
  if (!voiceModeAvailable()) { toast("Bu tarayıcıda konuşma tanıma yok.", 5000); return; }
  if (ui.input.disabled) return;
  if (state.mode === "home") startFree();
  stopListening();
  speech.unlock();
  vm.silenceMs = Number(S().silence_ms) || 1400;
  vm.manual = S().voice_send === "manual";
  vm.lang = sttLocale();
  showVoiceSettings();
  vm.start();
  if (state.busy) vm.pause();     // cevap bekleniyorsa, cevaptan sonra dinlemeye başlar
  toast(vm.manual
    ? `🎧 Konuşma modu açık. Konuş, bitince ➤ Gönder'e bas. ⏸ ile duraklatabilirsin. Uyutmak için ${pack.sleepHint}.`
    : `🎧 Konuşma modu açık. Konuş; kısa bir sessizlikten sonra gönderilir. Düşünmek için ✋ Bekle'ye bas. Uyutmak için ${pack.sleepHint}.`, 8000);
}

// ================= mikrofon =================
// discard: söyleneni bırak (gönderildikten sonra son tanıma sonucu kutuya geri yazılmasın)
function stopListening(discard = false) {
  if (state.stopListen) { const f = state.stopListen; state.stopListen = null; f(discard); }
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
  toast(S().stt_tr ? "🎤 Türkçe dinliyorum… Bitince ⏹'e bas." : "🎤 Dinliyorum… Bitince ⏹'e bas.");
  state.stopListen = speech.listen({
    lang: sttLocale(),
    onText: (t, final) => {
      ui.input.value = (base ? base + " " : "") + t;
      if (final && t && !state.finishing) toast("Yazıyı kontrol et, sonra Gönder.", 4000);
    },
    onEnd: () => {
      state.stopListen = null; ui.mic.classList.remove("rec"); ui.mic.textContent = "🎤";
      if (state.afterListen) state.afterListen();
    },
    onError: msg => toast(msg, 6000),
  });
}

// ================= 📘 üniteler =================
// Her ünite 6 adım: sahne → kelimeler → dilbilgisi → rol yapma → yazma → değerlendirme.
// İçerik ilk açılışta yapay zekâyla öğrencinin seviyesine/profiline göre üretilir ve cihazda saklanır.
const stepLabel = id => { const s = cur.step(id); return s ? `${esc(s.tl)} · ${esc(s.tr)}` : id; };
const nextBtn = (label = "Devam →") => `<div style="margin-top:14px"><button class="btn warm" data-act="unit-next">${esc(label)}</button></div>`;
const firstOpenStep = uid => { const d = store.unitStepsDone(uid); return cur.stepIds().find(s => !(s in d)) || "scene"; };

function showUnits() {
  setMode("units", "📘 Üniteler");
  const done = store.completedUnits();
  const next = cur.nextUnit(done);
  const st = store.vocabStats();
  let html = `<h2>Üniteler · ${esc(pack.nameTr)}</h2>
    <div class="muted">Her ünite bir konuşma senaryosu: ${cur.steps.map(s => esc(s.tr)).join(" → ")}.
      İçerik ilk açılışta senin seviyene ve hedeflerine göre hazırlanır (30-60 sn), sonra cihazda saklanır.
      Değerlendirmede %70 ve üstü üniteyi tamamlar; istediğin üniteden başlayabilirsin.</div>
    <div class="card">🔁 Tekrar bekleyen kelime: <b>${st.due}</b> · toplam ${st.total}
      <button class="btn ${st.due ? "" : "alt"}" data-act="review">Kelime tekrarı</button></div>`;
  for (const lv of cur.levels) {
    html += `<h3>${esc(lv.title_tr)} <span class="muted">(${esc(lv.band)})</span></h3><div class="unit-list">`;
    for (const u of lv.units) {
      const n = Object.keys(store.unitStepsDone(u.id)).length;
      const mark = u.id in done ? "✅" : u.id === next ? "▶️" : n ? "◐" : "○";
      const prog = u.id in done ? `%${Math.round(done[u.id] * 100)}` : n ? `${n}/${cur.steps.length}` : "";
      html += `<button class="unit-row${u.id === next ? " next" : ""}" data-act="unit" data-unit="${u.id}">
        <span class="u-mark">${mark}</span>
        <span class="u-title"><span class="tl-s">${tl(u.title)}</span> · ${esc(u.title_tr)}<br><span class="muted">${esc(u.scenario_tr)}</span></span>
        <span class="u-prog">${prog}</span></button>`;
    }
    html += "</div>";
  }
  ui.content.innerHTML = html;
}

function unitHeader(u, current) {
  const d = store.unitStepsDone(u.id);
  const pills = cur.steps.map(s => `<button class="step-pill${s.id === current ? " on" : ""}${s.id in d ? " done" : ""}"
    data-act="step" data-step="${s.id}" ${state.content ? "" : "disabled"}>${s.id in d ? "✓ " : ""}${esc(s.tr)}</button>`).join("");
  return `<div class="muted"><button class="linkish" data-act="units-list">← Üniteler</button> · ${esc(u.level_title)} · ${esc(u.band)}</div>
    <h2><span class="tl-s">${tl(u.title)}</span> <span class="muted">${esc(u.title_tr)}</span></h2>
    <div class="muted">🎯 ${esc(u.can_do_tr)}</div><div class="steps">${pills}</div>`;
}
const regenLink = () => `<div class="muted" style="margin-top:24px">İçerik beğenilmediyse:
  <button class="linkish" data-act="unit-regen">üniteyi yeniden üret</button></div>`;

async function openUnit(uid, regenerate = false) {
  const u = cur.unit(uid);
  if (!u) return;
  setMode("unit", `📘 ${u.title_tr}`);
  state.unitId = uid;
  state.content = null;
  const cached = !regenerate && store.getUnitContent(uid);
  if (cached) { state.content = cached; openStep(firstOpenStep(uid)); return; }
  if (!store.apiKey()) { ui.content.innerHTML = unitHeader(u, null); showError(new LLMError("API_KEY_MISSING")); return; }
  ui.content.innerHTML = unitHeader(u, null) + `<div class="card">⏳ <b>Ünite hazırlanıyor…</b> İlk açılışta 30-60 saniye
    sürebilir; sonra cihazda saklanır ve hemen açılır. Bu sırada başka ekrana geçersen hazırlık yarıda kalır.</div>`;
  setBusy(true);
  const g = state.gen;
  try {
    const c = await tutor.unitContent(uid, regenerate);
    if (g !== state.gen) return;
    setBusy(false);
    state.content = c;
    openStep(firstOpenStep(uid));
  } catch (e) { if (g === state.gen) showError(e); }
}

// Adımdaki seslendirilebilir metinler (🔊 sıraları sabit kalsın diye bir kez kaydedilir)
function registerSpeak(c, stepId) {
  const start = state.speak.length;
  if (stepId === "scene") {
    const first = c.scene.characters?.[0]?.id;
    for (const ln of c.scene.lines) addSpeak(ln.text || "", ln.speaker === first ? 1.05 : 0.88);
  } else if (stepId === "vocab") for (const w of c.vocab) addSpeak(w.word || "");
  else if (stepId === "grammar") for (const e of c.grammar.examples || []) addSpeak(e.text || "");
  return start;
}

function stepBody(u, c, stepId, start) {
  if (stepId === "scene") {
    const sc = c.scene;
    const names = Object.fromEntries((sc.characters || []).map(ch => [ch.id, ch.name || ch.id]));
    const roles = (sc.characters || []).map(ch => `<b>${esc(ch.name)}</b>: ${esc(ch.role_tr)}`).join(" · ");
    const lines = sc.lines.map((ln, i) => `<div class="line"><div class="who">${esc(names[ln.speaker] || ln.speaker)}</div>
      <div class="ln"><span class="tl">${tl(ln.text)}</span><button class="icon" data-act="say" data-i="${start + i}">🔊</button>${TOGGLE}
      <div class="tr">${esc(ln.tr)}</div></div></div>`).join("");
    return `<h3>${stepLabel("scene")}</h3>
      <div class="card"><div>${esc(sc.setting_tr)}</div><div class="muted">${roles}</div></div>
      <button class="btn" data-act="play-all">▶ Tümünü dinle</button> <button class="btn alt" data-act="stop-audio">■ Durdur</button>
      <div class="card">${lines}</div>
      <div class="muted">İpucu: her repliği dinleyip yüksek sesle tekrar et (shadowing). Çeviri için TR'ye dokun.
        Anlamadığın yeri aşağıya yazarak sorabilirsin.</div>${nextBtn()}`;
  }
  if (stepId === "vocab") {
    const rows = c.vocab.map((w, i) => `<tr><td><span class="tl-s">${esc(w.word)}</span><button class="icon" data-act="say" data-i="${start + i}">🔊</button></td>
      <td>${esc(w.reading || "")}</td><td>${esc(w.meaning_tr)}</td>
      <td><span class="tl-ex">${tl(w.example || "")}</span>${w.example_tr ? TOGGLE + `<div class="tr">${esc(w.example_tr)}</div>` : ""}</td></tr>`).join("");
    return `<h3>${stepLabel("vocab")}</h3>
      <div class="card vocab"><table><tr><th>Kelime</th><th>${pack.code === "ja" ? "Okunuş" : pack.code === "de" ? "Artikel / çoğul" : "Okunuş"}</th><th>Anlam</th><th>Örnek</th></tr>${rows}</table></div>
      <div class="muted">"Devam" dediğinde bu kelimeler tekrar listene eklenir.</div>${nextBtn("Tekrar listeme ekle ve devam →")}`;
  }
  if (stepId === "grammar") {
    const g = c.grammar;
    const paras = String(g.explanation_tr || "").split(/\n\s*\n/).map(p => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
    const ex = (g.examples || []).map((e, i) => `<div class="line"><div class="ln"><span class="tl">${tl(e.text)}</span>
      <button class="icon" data-act="say" data-i="${start + i}">🔊</button>${TOGGLE}<div class="tr">${esc(e.tr)}</div></div></div>`).join("");
    return `<h3>${stepLabel("grammar")}: ${esc(g.point || "")}</h3><div class="card">${paras}</div><div class="card">${ex}</div>
      <div class="muted">Anlamadığın bir yer varsa ya da kendi örnek cümleni denemek istersen aşağıya yaz.</div>${nextBtn()}`;
  }
  if (stepId === "roleplay") {
    const rp = c.roleplay;
    return `<h3>${stepLabel("roleplay")}</h3><div class="card">
      <b>Sen:</b> ${esc(rp.learner_role_tr)}<br><b>Karşındaki:</b> ${esc(rp.partner_name)} — ${esc(rp.partner_role_tr)}<br>
      <b>Görev:</b> ${esc(rp.goal_tr)}<div class="muted">Yazarak, 🎤 ya da 🎧 ile cevap ver. Takılırsan Türkçe sorabilirsin.</div></div>
      <button class="btn alt" data-act="unit-next">Sahneyi bitir →</button>`;
  }
  if (stepId === "writing") {
    const w = c.writing;
    return `<h3>${stepLabel("writing")}</h3><div class="card"><b>Görev:</b> ${esc(w.task_tr)}
      <div class="muted">💡 ${esc(w.hint_tr || "")}</div></div>
      <div class="muted">Metnini aşağıya ${esc(pack.nameTr)} yaz ve gönder (birkaç cümle). İstersen bu adımı
        <button class="linkish" data-act="unit-next">atlayabilirsin</button>.</div>`;
  }
  return "";
}

function openStep(stepId) {
  const u = cur.unit(state.unitId), c = state.content;
  if (!u || !c) return;
  // adım değişince önceki adımın oturumu kapanır (özeti hafızaya geçer)
  if (vm.on) vm.stop();
  state.gen++;
  if (state.busy) setBusy(false);
  stopListening(true);
  speech.stop();
  endSession();
  state.step = stepId;
  state.chat = [];
  state.speak = [];
  state.speakPitch = [];
  state.playTok = null;
  state.task = null;
  ui.title.textContent = `📘 ${u.title_tr} · ${cur.step(stepId).tr}`;
  ui.main.scrollTop = 0;
  if (stepId === "quiz") {
    state.sessionId = null;
    setInput(false, "Değerlendirmede seçeneklere dokun.");
    state.quiz = { i: 0, correct: 0, chosen: null };
    renderQuiz();
    return;
  }
  const start = registerSpeak(c, stepId);
  state.header = () => unitHeader(u, stepId) + stepBody(u, c, stepId, start) + regenLink();
  state.sessionId = store.newSession(`unit:${u.id}:${stepId}`, u.id);
  if (stepId === "roleplay") {
    state.task = P.ROLEPLAY(u, c.roleplay);
    setInput(true, "Rolündeki cevabını yaz ya da 🎧 ile konuş…");
    const d = tutor.startRoleplay(state.sessionId, c);
    const si = addSpeak(d.reply, 0.88);
    state.lastReply = d.reply;
    state.chat.push({ type: "ai", data: d, speak: si });
    renderChat();
    speakText(d.reply, si, undefined, undefined, 0.88);
    return;
  }
  if (stepId === "writing") setInput(true, `Metnini ${pack.nameTr} yaz ve gönder…`);
  else {
    state.task = P.LESSON_QA(u, cur.step(stepId).tr, c.grammar?.point || u.grammar.join(" · "));
    setInput(true, "Soru sor ya da kendi örnek cümleni dene…");
  }
  renderChat();
  ui.main.scrollTop = 0;
}

function unitNext() {
  const uid = state.unitId, st = state.step, c = state.content;
  if (st === "scene" || st === "grammar") store.markStep(uid, st, 1);
  else if (st === "vocab") { tutor.addUnitVocab(uid, c); store.markStep(uid, "vocab", 1); toast(`${c.vocab.length} kelime tekrar listene eklendi.`); }
  else if (st === "roleplay") store.markStep(uid, "roleplay", 0.5);
  else if (st === "writing") store.markStep(uid, "writing", 0.2);       // atlandıysa; yapıldıysa puanı zaten daha yüksek
  const ids = cur.stepIds();
  const i = ids.indexOf(st);
  if (i + 1 < ids.length) openStep(ids[i + 1]); else showUnits();
}

// ▶ Tümünü dinle: sahnenin repliklerini sırayla, iki kişi farklı perdeden
function playAll() {
  const c = state.content;
  if (!c) return;
  const tok = state.playTok = {};
  const n = c.scene.lines.length;
  let k = 0;
  const next = () => {
    if (state.playTok !== tok || k >= n) return;
    const i = k++;
    speakText(state.speak[i], i, () => setTimeout(next, 300), undefined, state.speakPitch[i] || 1);
  };
  next();
}

// ---- yazma ----
async function writingCheck(text) {
  if (!store.apiKey()) { showError(new LLMError("API_KEY_MISSING")); return; }
  setBusy(true);
  const g = state.gen;
  try {
    const fb = await tutor.checkWriting(state.unitId, state.content, text);
    if (g !== state.gen) return;
    setBusy(false);
    const comments = (fb.comments || []).filter(x => x && typeof x === "object").map(x =>
      `<div class="fix">${quote(esc(x.original))} → <b>${quote(tl(x.corrected || ""))}</b><br>${esc(x.explanation_tr || "")}</div>`).join("");
    const html = `<div class="card"><b>Düzeltilmiş hâli</b><div class="tl">${tl(fb.corrected || "")}</div>${comments}
      <p>🌸 ${esc(fb.praise_tr || "")}</p><div class="muted">Puan: %${Math.round(fb.score * 100)}
      · İstersen düzeltip yeniden gönderebilirsin.</div>${nextBtn()}</div>`;
    state.chat.push({ type: "html", html });
    ui.content.insertAdjacentHTML("beforeend", html);
    scrollBottom();
  } catch (e) { if (g === state.gen) showError(e); }
}

// ---- değerlendirme ----
function renderQuiz() {
  const u = cur.unit(state.unitId), c = state.content, q = state.quiz;
  const total = c.quiz.length;
  state.header = null;
  if (q.i >= total) {
    const score = q.correct / total;
    store.markStep(u.id, "quiz", score);
    const passed = score >= 0.7;
    const nx = cur.nextUnit(store.completedUnits());
    ui.content.innerHTML = unitHeader(u, "quiz") + `<h3>${stepLabel("quiz")} · Sonuç</h3>
      <div class="card"><div class="big">${q.correct} / ${total}</div>
      <p>${passed ? "🎉 Üniteyi tamamladın!" : "Biraz daha çalışalım; %70 ve üstüyle ünite tamamlanır."}</p>
      <button class="btn alt" data-act="step" data-step="quiz">🔁 Tekrar dene</button>
      ${passed && nx ? `<button class="btn warm" data-act="unit" data-unit="${nx}">Sıradaki ünite →</button>` : ""}
      <button class="btn alt" data-act="units-list">Üniteler</button></div>`;
    return;
  }
  const item = c.quiz[q.i];
  const ans = Number(item.answer);
  const opts = item.options.map((o, oi) => {
    const cls = q.chosen === null ? "" : oi === ans ? " right" : oi === q.chosen ? " wrong" : "";
    return `<button class="opt${cls}" data-act="quiz-answer" data-o="${oi}" ${q.chosen === null ? "" : "disabled"}>${tl(String(o))}</button>`;
  }).join("");
  const after = q.chosen === null ? "" : `<div class="card">${q.chosen === ans ? "✅ Doğru!" : "❌ Olmadı."} ${esc(item.explain_tr || "")}</div>
    <button class="btn" data-act="quiz-next">Devam →</button>`;
  ui.content.innerHTML = unitHeader(u, "quiz") + `<h3>${stepLabel("quiz")}</h3><div class="muted">Soru ${q.i + 1} / ${total}</div>
    <div class="card"><b>${esc(item.q_tr || "")}</b>${item.q ? `<div class="tl">${tl(item.q)}</div>` : ""}</div>${opts}${after}`;
}
function quizAnswer(oi) {
  const q = state.quiz;
  if (!q || q.chosen !== null) return;
  q.chosen = oi;
  if (oi === Number(state.content.quiz[q.i].answer)) q.correct++;
  renderQuiz();
}

// ================= 🔁 kelime tekrarı (aralıklı tekrar) =================
function showReview() {
  setMode("review", "🔁 Kelime tekrarı");
  state.review = { queue: store.dueWords(30), shown: false, ok: 0, n: 0 };
  renderReview();
}
function renderReview() {
  const r = state.review;
  state.speak = [];
  state.speakPitch = [];
  if (!r.queue.length) {
    ui.content.innerHTML = `<h2>🔁 Kelime tekrarı</h2><div class="card">${r.n ? `Bu turu bitirdin: <b>${r.ok} / ${r.n}</b> bildin. 👏` : "Şimdilik tekrar edilecek kelime yok."}
      <div class="muted">Kelimeler sohbetlerden ve ünitelerin kelime adımından gelir. Bildikçe tekrar aralığı uzar (1 gün, 3 gün, 1 hafta…);
      bilemediğin kelime aynı turda yeniden sorulur.</div></div>
      <button class="btn" data-nav="home">Ana sayfa</button> <button class="btn alt" data-nav="units">Üniteler</button>`;
    return;
  }
  const w = r.queue[0];
  addSpeak(w.word);
  const back = r.shown
    ? `<div class="rv-read">${esc(w.reading || "")} <button class="icon" data-act="say" data-i="0">🔊</button></div>
       <div class="rv-mean">${esc(w.meaning_tr || "")}</div>
       ${w.example_ja ? `<div class="tl" style="font-size:18px">${tl(w.example_ja)}</div><div class="muted">${esc(w.example_tr || "")}</div>` : ""}
       <div class="rv-btns"><button class="btn warm" data-act="rv-fail">Bilemedim</button><button class="btn" data-act="rv-ok">Bildim</button></div>`
    : `<div class="rv-btns"><button class="btn" data-act="rv-show">Cevabı göster</button></div>`;
  ui.content.innerHTML = `<h2>🔁 Kelime tekrarı</h2>
    <div class="muted">Kalan: ${r.queue.length} · Anlamını${pack.code === "ja" ? " ve okunuşunu" : pack.code === "de" ? " ve artikelini" : ""} aklından söyle, sonra cevabı aç.</div>
    <div class="card rv-card"><div class="rv-word">${esc(w.word)}</div>${back}</div>`;
}
function reviewGrade(ok) {
  const r = state.review;
  const w = r.queue.shift();
  store.reviewWord(w.id, ok);
  r.n++;
  if (ok) r.ok++; else r.queue.push(w);      // bilemediğini aynı turda yeniden sor
  r.shown = false;
  renderReview();
}

// ================= ilerleme =================
function showProgress() {
  setMode("progress", "📈 İlerleme");
  const st = store.vocabStats();
  const mist = store.mistakeStats(8).map(m =>
    `<tr><td>${esc(m.category)}</td><td>${m.count}</td><td>${quote(esc(m.original))}→${quote(esc(m.corrected))}</td></tr>`).join("");
  const facts = store.facts(20).map(f => `<span class="pill">${esc(f)}</span>`).join("");
  const sums = store.recentSummaries(6).map(s => `<li>${esc(s)}</li>`).join("");
  ui.content.innerHTML = `<h2>İlerleme · ${esc(pack.nameTr)}</h2>
    ${state.summarizing ? '<div class="card muted">⏳ Son sohbetin özeti çıkarılıyor; bu sayfa birazdan kendini yenileyecek.</div>' : ""}
    <div class="card"><b>Tahmini seviye:</b> ${esc(store.get("level_estimate") || "henüz belli değil")}</div>
    <div class="card"><b>Üniteler:</b> ${Object.keys(store.completedUnits()).length} / ${cur.order.length} tamamlandı
      <button class="btn alt" data-nav="units">📘 Üniteler</button></div>
    <div class="card"><b>Kelimeler</b><br>Toplam ${st.total} · İyi bilinen ${st.known} · Tekrar bekleyen ${st.due}</div>
    <div class="card"><b>Sık yapılan hatalar</b>${mist ? `<table><tr><th>Tür</th><th>Sayı</th><th>Son örnek</th></tr>${mist}</table>`
      : '<div class="muted">Henüz kayıt yok.</div>'}</div>
    <div class="card"><b>${esc(S().character_name)} seni nasıl tanıyor</b><div>${facts || '<span class="muted">Henüz bir şey öğrenmedi.</span>'}</div></div>
    <div class="card"><b>Son oturumlar</b><ul>${sums || '<li class="muted">Henüz yok</li>'}</ul></div>`;
}

// ================= ayarlar =================
// API anahtarı alma rehberi (Ayarlar'da her anahtar alanının altında açılır kutu).
// Bağlantılar yeni sekmede açılır; ana ekrana eklenen uygulamada Safari'ye geçer, uygulama yerinde kalır.
const ext = (href, text) => `<a class="btn alt" href="${href}" target="_blank" rel="noopener">${text} ↗</a>`;
function keyGuide(provider, open) {
  if (provider === "openai") return `<details class="guide" id="g-openai" ${open ? "open" : ""}>
    <summary>🔑 OpenAI anahtarım yok — nasıl alırım?</summary>
    <ol>
      <li><b>platform.openai.com</b> adresinde hesap aç (Google hesabıyla da olur). Burası ChatGPT'den
        ayrı bir sitedir; <b>ChatGPT Plus aboneliği API kullanımını kapsamaz</b>.</li>
      <li><b>Billing</b> (Faturalandırma) sayfasında kart ekleyip ön ödemeli kredi yükle (az bir miktar yeter).</li>
      <li><b>API keys</b> sayfasında <b>Create new secret key</b>'e bas, bir ad ver (ör. Kotonoha).</li>
      <li><code>sk-</code> ile başlayan anahtar <b>yalnızca bir kez</b> gösterilir: hemen kopyala,
        yukarıdaki kutuya yapıştır, <b>🔌 Bağlantıyı dene</b>, sonra <b>Kaydet</b>.</li>
    </ol>
    ${ext("https://platform.openai.com/api-keys", "API anahtarları")}
    ${ext("https://platform.openai.com/settings/organization/billing/overview", "Kredi yükle")}
  </details>`;
  return `<details class="guide" id="g-claude" ${open ? "open" : ""}>
    <summary>🔑 Claude anahtarım yok — nasıl alırım?</summary>
    <ol>
      <li><b>Claude Console</b>'a (platform.claude.com) gir ya da hesap aç. Burası claude.ai'den ayrıdır;
        <b>Claude Pro aboneliği API kullanımını kapsamaz</b>, kredi ayrıca yüklenir.</li>
      <li><b>Billing</b> sayfasında kart ekleyip kredi satın al (az bir miktar yeter; harcadıkça azalır).</li>
      <li><b>API keys</b> sayfasında <b>Create key</b>'e bas, bir ad ver (ör. Kotonoha). Süre sorarsa
        uzun bir süre seçebilirsin; süresi dolunca yeni anahtar almak gerekir.</li>
      <li><code>sk-ant-</code> ile başlayan anahtar <b>yalnızca bir kez</b> gösterilir: hemen kopyala,
        yukarıdaki kutuya yapıştır, <b>🔌 Bağlantıyı dene</b>, sonra <b>Kaydet</b>.</li>
    </ol>
    ${ext("https://platform.claude.com/settings/keys", "API anahtarları")}
    ${ext("https://platform.claude.com/settings/billing", "Kredi yükle")}
  </details>`;
}
const KEY_TIPS = `<div class="hint">💡 Anahtar bir şifre gibidir: kimseyle paylaşma, ekran görüntüsüne çıkarma.
  Kullanım ücreti bu anahtarın sahibinin hesabından düşer; Console'da harcama sınırı koyabilirsin.
  Bir aile üyesi kendi anahtarını senin için girebilir.</div>`;

function openKeyGuide() {
  const prov = S().provider === "openai" ? "openai" : "claude";
  showSettings(prov);
  setTimeout(() => $("#g-" + prov)?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
}

function langLink(code) {
  const p = PACKS[code];
  const href = new URL(code === "ja" ? "./" : `${code}/`, ROOT).href;
  return `<a class="btn alt" href="${href}">${FLAGS[code] || ""} ${esc(p.nameTr)}</a>`;
}

function showSettings(guideOpen = null) {
  setMode("settings", "⚙️ Ayarlar");
  const s = S();
  const pr = store.profile();
  const voices = speech.targetVoices();
  const vopts = [`<option value="">${esc(pack.voiceAutoLabel)}</option>`]
    .concat(voices.map(v => `<option ${v === s.voice_name ? "selected" : ""}>${esc(v)}</option>`)).join("");
  const others = Object.keys(PACKS).filter(c => c !== pack.code).map(langLink).join("");
  ui.content.innerHTML = `<h2>Ayarlar</h2><div class="form">
  <div class="card"><b>Yapay zekâ</b>
    <label>Kullanılacak</label>
    <select id="f-provider"><option value="claude">Claude (Anthropic)</option><option value="openai">OpenAI (ChatGPT)</option></select>
    <label>Claude API anahtarı</label><input type="password" id="f-ckey" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" value="${esc(s.claude_key)}">
    <div class="hint">Kayıtlı: ${esc(describeKey(s.claude_key))}</div>
    ${keyGuide("claude", (!s.claude_key && s.provider !== "openai") || guideOpen === "claude")}
    <label>Claude modeli</label><input type="text" id="f-cmodel" value="${esc(s.claude_model)}" autocapitalize="off">
    <label>OpenAI API anahtarı <span class="hint">(isteğe bağlı; Claude yerine kullanmak istersen)</span></label><input type="password" id="f-okey" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" value="${esc(s.openai_key)}">
    ${keyGuide("openai", (!s.openai_key && s.provider === "openai") || guideOpen === "openai")}
    ${KEY_TIPS}
    <label>OpenAI modeli</label><input type="text" id="f-omodel" value="${esc(s.openai_model)}" autocapitalize="off">
    <button class="btn alt" data-act="test-key">🔌 Bağlantıyı dene</button>
    <div id="f-keytest" class="hint"></div>
    <div class="hint">Anahtarlar yalnızca bu cihazda saklanır; yedek dosyasına da girmez. Aynı tarayıcıdaki
      diğer dil sürümleri de bu anahtarı kullanır.</div>
  </div>
  <div class="card"><b>Öğrenci</b>
    <div>${esc(s.learner_name || "Adın girilmemiş")}${pr.level_self ? " · seviye: " + esc(pr.level_self === "0" ? "yeni başlıyor" : pr.level_self) : ""}</div>
    <div class="hint">${esc([pr.about, pr.interests].filter(Boolean).join(" · ") || "Profil boş.")}</div>
    <button class="btn alt" data-act="profile">👤 Profili düzenle</button>
  </div>
  <div class="card"><b>Karakter</b>
    <label>Avatarın adı</label><input type="text" id="f-name" value="${esc(s.character_name)}">
    <div class="hint">🎧 Konuşma modunda avatarı uyandırmak için bu adı söylersin: ${esc(pack.wakeHint(s.character_name))}</div>
    <label>Karakteri</label><textarea id="f-persona">${esc(s.persona)}</textarea>
  </div>
  <div class="card"><b>Ses</b>
    <label class="row"><input type="checkbox" id="f-voice" ${s.voice_on ? "checked" : ""}> Avatar sesli konuşsun</label>
    <label>Ses</label><select id="f-vname">${vopts}</select>
    <label>Konuşma hızı: <span id="f-rate-v">${Number(s.rate).toFixed(2)}</span></label>
    <input type="range" id="f-rate" min="0.6" max="1.4" step="0.05" value="${s.rate}" style="width:100%">
    <label>🎧 Konuşma modunda sıra geçme süresi: <span id="f-wait-v">${(s.silence_ms / 1000).toFixed(1)}</span> sn</label>
    <input type="range" id="f-wait" min="0.6" max="4" step="0.2" value="${s.silence_ms / 1000}" style="width:100%">
    <div class="hint">Sustuktan kaç saniye sonra söylediğin gönderilsin. Kısa: hızlı karşılıklı konuşma; uzun: düşünmek için zaman. Varsayılan 1.4 sn.
      Hız ve süre değiştirdiğin anda kaydedilir; konuşma modundaki ⏱ ve 🗣 düğmeleriyle de ayarlanabilir.</div>
    <label>🎧 Konuşma modunda söylediğim ne zaman gönderilsin?</label>
    <select id="f-vsend">
      <option value="auto" ${s.voice_send !== "manual" ? "selected" : ""}>Kısa bir sessizlikten sonra kendiliğinden (✋ Bekle ile durdurabilirim)</option>
      <option value="manual" ${s.voice_send === "manual" ? "selected" : ""}>Ben ➤ Gönder'e basınca (düşünmek için bol zaman)</option>
    </select>
    <div class="hint">Konuşma modunda: ⏸ duraklat · 🔁 son cümleyi yavaşça tekrarla · ✋ Bekle (geri sayımı durdurur) ·
      🗑 söylediğini sil. "えーと / ähm / um" gibi duraksama sözcükleriyle biterse kendiliğinden daha uzun beklenir.</div>
    <button class="btn alt" data-act="test-voice">▶ Dene</button>
    ${voices.length || !speech.voicesKnown() ? "" : `<div class="hint">${esc(pack.nameTr)} ses bulunamadı. iPad: Ayarlar → Erişilebilirlik → Seslendirilen İçerik → Sesler → ${esc(pack.nameTr)}.</div>`}
  </div>
  <div class="card" id="backup-card"><b>Yedekleme</b>
    ${cloudBlock()}
    <div class="hint" style="margin-top:10px"><b>Dosyaya yedek</b> (Drive'dan bağımsız; iPad'de "Dosyalar'a Kaydet" → iCloud Drive).
      Her dilin yedeği ayrıdır; API anahtarı yedeğe girmez.</div>
    <button class="btn alt" data-act="export">⬇ Yedeği dosyaya al</button>
    <label class="btn alt" style="margin-top:6px">⬆ Dosyadan geri yükle<input type="file" id="f-import" accept=".json,application/json" hidden></label>
  </div>
  <button class="btn warm" data-act="save-settings">Kaydet</button>
  <div class="card"><b>Diğer diller</b>
    <div class="hint">Her dilin kendi simgesi ve ayrı hafızası var. iPad'de açınca Paylaş → Ana Ekrana Ekle ile ayrı simge olarak eklenir.</div>
    ${others}
  </div>
  <details class="card"><summary><b>🔧 Ses günlüğü</b> <span class="hint">(ses sorunu olursa ekran görüntüsünü gönder)</span></summary>
    <pre id="diag" class="diag">${esc(speech.diagnostics().join("\n") || "Henüz kayıt yok.")}</pre>
    <button class="btn alt" data-act="diag-refresh">↻ Yenile</button>
  </details>
  <div class="card"><b>Güncelleme</b>
    <div class="muted">${esc(pack.appName)} ${APP_VERSION}${loadedBuild ? " · yapı " + esc(loadedBuild) : ""}</div>
    <button class="btn alt" data-act="update-check">🔄 Güncellemeyi denetle ve yenile</button>
  </div></div>`;
  $("#f-provider").value = s.provider;
  // Hız ve bekleme süresi değiştiği anda kaydedilir ("Kaydet"e basmak gerekmez).
  $("#f-rate").oninput = e => setRate(Number(e.target.value));
  $("#f-wait").oninput = e => setWait(Number(e.target.value) * 1000);
  $("#f-vname").onchange = e => store.setSetting("voice_name", e.target.value);
  $("#f-voice").onchange = e => store.setSetting("voice_on", e.target.checked);
  $("#f-vsend").onchange = e => { store.setSetting("voice_send", e.target.value); vm.manual = e.target.value === "manual"; store.saveNow(); };
  $("#f-import").onchange = importBackup;
}

// ---------- ☁️ Drive yedeği ----------
const fmtTime = iso => iso ? new Date(iso).toLocaleString("tr-TR", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }) : "henüz yok";

function cloudBlock() {
  if (!cloud.configured()) return `<div class="hint">☁️ Google Drive yedeği bu sitede henüz kurulmadı.</div>`;
  if (!cloud.enabled()) return `<div>☁️ <b>Google Drive'a otomatik yedek: kapalı</b></div>
    <div class="hint">Açınca hafızan arka planda Drive'a yedeklenir; uygulama silinse bile bir kodla geri gelir.</div>
    <button class="btn" data-act="cloud-on">☁️ Drive yedeğini aç</button>
    <button class="btn alt" data-act="cloud-link">🔗 Kodum var, bağla</button>
    <div id="cloud-extra"></div>`;
  const st = cloud.status();
  return `<div>☁️ <b>Google Drive'a otomatik yedek: açık</b></div>
    <div class="hint">Son yedek: ${esc(fmtTime(st.last_at))}${st.last_error ? ` · ⚠️ ${esc(st.last_error)}` : st.last_at ? " ✓" : ""}</div>
    <div class="hint" style="margin-top:6px">Yedek kodun (uygulamayı silersen ya da yeni cihazda bununla geri yüklersin; diğer dil simgelerinde de aynı kodu kullan):</div>
    <span class="code-box">${esc(cloud.code())}</span><button class="btn alt" data-act="copy-code">📋 Kopyala</button>
    <div>
      <button class="btn" data-act="cloud-now">⬆ Şimdi yedekle</button>
      <button class="btn alt" data-act="cloud-restore">⬇ Drive'dan geri yükle</button>
      <button class="btn alt" data-act="cloud-link">🔗 Başka kod bağla</button>
      <button class="btn alt" data-act="cloud-off">Kapat</button>
    </div>
    <div id="cloud-extra"></div>
    <div class="hint">Yedekler Kotonoha yöneticisinin Google Drive'ında, "Kotonoha Yedekleri" klasöründe saklanır; son 10 günün kopyası tutulur.</div>`;
}

function ensureBackupCode() {
  // Drive kuruluysa ve hafızada bir şey varsa yedeği kendiliğinden aç (kodu kullanıcıya bir kez göster).
  if (cloud.configured() && !cloud.code() && !store.isEmpty()) {
    store.setSetting("backup_code", cloud.newCode());
    store.set("code_note_pending", true);
    store.saveNow();
  }
}

function copyCode() {
  const c = cloud.code();
  navigator.clipboard?.writeText(c).then(() => toast("Kod kopyalandı: " + c), () => toast(c, 8000));
}

async function cloudNow() {
  toast("Drive'a yedekleniyor…", 8000);
  try { await cloud.backupNow({ force: true }); toast("✅ Drive'a yedeklendi."); }
  catch (e) { toast("⚠️ " + e.message, 7000); }
  if (state.mode === "settings") showSettings();
}

function cloudLinkForm() {
  $("#cloud-extra").innerHTML = `<div class="form"><label>Yedek kodun</label>
    <input type="text" id="c-code" placeholder="KTN-XXXX-XXXX-XXXX" autocapitalize="characters" autocorrect="off" spellcheck="false">
    <button class="btn" data-act="cloud-link-go">Bağla</button></div>`;
}

async function cloudLinkGo() {
  const c = cloud.normalizeCode($("#c-code").value);
  if (!c) { toast("Kod KTN-XXXX-XXXX-XXXX biçiminde olmalı.", 5000); return; }
  try {
    const files = await cloud.list(c);
    if (files.length && confirm(`Bu kodda ${pack.nameTr} yedeği var (${fmtTime(files[0].updated)}). Bu cihazdaki hafıza onunla değiştirilsin mi?\n(Hayır dersen kod yine bağlanır; bundan sonraki yedekler oraya gider.)`)) {
      await cloud.restoreFrom(c);
      applySettings();
      toast("✅ Drive'daki yedek yüklendi.");
    } else {
      store.setSetting("backup_code", c); store.saveNow();
      cloud.backupNow({ force: true }).catch(() => {});
      toast("Kod bağlandı.");
    }
  } catch (e) {
    if (e.notFound) { store.setSetting("backup_code", c); store.saveNow(); cloud.backupNow({ force: true }).catch(() => {}); toast("Kod bağlandı (bu kodda henüz yedek yoktu)."); }
    else { toast("⚠️ " + e.message, 7000); return; }
  }
  showSettings();
}

async function cloudRestoreList() {
  const box = $("#cloud-extra");
  box.innerHTML = '<div class="hint">Drive\'daki yedekler alınıyor…</div>';
  try {
    const files = await cloud.list();
    if (!files.length) { box.innerHTML = '<div class="hint">Drive\'da bu dilde yedek yok.</div>'; return; }
    box.innerHTML = `<div class="hint">Hangi yedeğe dönülsün? (Bu cihazdaki hafıza onunla değiştirilir.)</div><div class="vlist">` +
      files.map(f => `<button class="btn alt" data-act="cloud-load" data-file="${esc(f.name)}">${f.name.includes("-son") ? "En son yedek" : esc(f.name.slice(3, 13))} · ${esc(fmtTime(f.updated))} · ${Math.round(f.size / 1024)} KB</button>`).join("") + "</div>";
  } catch (e) { box.innerHTML = `<div class="hint">⚠️ ${esc(e.message)}</div>`; }
}

async function cloudLoad(file) {
  if (!confirm(`Bu cihazdaki ${pack.nameTr} hafızası seçtiğin Drive yedeğiyle değiştirilsin mi?`)) return;
  try { await cloud.restoreFrom(cloud.code(), file); applySettings(); toast("✅ Yedek yüklendi."); showSettings(); }
  catch (e) { toast("⚠️ " + e.message, 7000); }
}

function cloudOff() {
  if (!confirm(`Drive yedeği bu uygulamada kapatılsın mı? (Drive'daki eski yedekler silinmez; kodunla yeniden bağlayabilirsin: ${cloud.code()})`)) return;
  store.setSetting("backup_code", ""); store.saveNow(); showSettings();
}

function readSettingsForm() {
  const v = id => $(id).value.trim();
  return {
    provider: $("#f-provider").value,
    claude_key: cleanKey(v("#f-ckey")), claude_model: v("#f-cmodel") || "claude-sonnet-5-5",
    openai_key: cleanKey(v("#f-okey")), openai_model: v("#f-omodel") || "gpt-4o",
    character_name: v("#f-name") || pack.defaultCharacter, persona: v("#f-persona"),
    voice_on: $("#f-voice").checked, voice_name: $("#f-vname").value, rate: Number($("#f-rate").value),
    silence_ms: Math.round(Number($("#f-wait").value) * 1000),
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
    const reply = await chat({ ...S(), ...f }, "Kısa cevap ver.", [{ role: "user", content: "Sadece \"OK\" yaz." }], 20);
    out.innerHTML = `✅ Bağlantı çalışıyor. Cevap: ${esc(reply)} — şimdi <b>Kaydet</b>'e basın.`;
  } catch (e) {
    out.textContent = `❌ ${e.message}  ·  Anahtar: ${describeKey(key)}`;
  }
}

function testVoice() {
  const f = readSettingsForm();
  speech.speak(pack.testPhrase(f.character_name), {
    voiceName: f.voice_name, rate: f.rate, silent: !f.voice_on, onMouth: m => avatar.setMouth(m),
  });
}

async function exportBackup() {
  const name = `kotonoha-${pack.code}-yedek-${new Date().toISOString().slice(0, 10)}.json`;
  const blob = new Blob([store.exportJSON()], { type: "application/json" });
  // iPad: paylaşım menüsü → "Dosyalar'a Kaydet" (iCloud Drive). Bilgisayar: İndirilenler.
  const file = typeof File !== "undefined" ? new File([blob], name, { type: "application/json" }) : null;
  if (file && navigator.canShare?.({ files: [file] }) && /iPad|iPhone|Macintosh/.test(navigator.userAgent) && "ontouchend" in document) {
    try { await navigator.share({ files: [file], title: name }); cloud.markFileBackup(); refreshAfterBackup(); return; }
    catch (e) { if (e.name === "AbortError") return; /* paylaşım olmazsa indirmeye düş */ }
  }
  cloud.markFileBackup();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  refreshAfterBackup();
}
function refreshAfterBackup() { if (state.mode === "home") showHome(); }

function importBackup(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  if (!store.isEmpty() && !confirm(`Bu cihazdaki ${pack.nameTr} hafızası, yedekteki ile değiştirilsin mi?`)) return;
  const fromProfile = e.target.id === "r-file";
  file.text().then(t => {
    store.importJSON(t);
    ensureBackupCode();
    applySettings();
    toast("✅ Yedek geri yüklendi.");
    if (fromProfile) showHome(); else showSettings();
  }).catch(err => toast("Yedek okunamadı: " + err.message, 6000));
}

function applySettings() {
  const s = S();
  ui.name.textContent = s.character_name;
  ui.tr.checked = !!s.show_tr;
  document.body.classList.toggle("show-tr", !!s.show_tr);
  if (ui.furi) ui.furi.value = s.furigana;
}

// ================= olaylar =================
ui.content.addEventListener("change", e => { if (e.target.id === "r-file") importBackup(e); });
ui.content.addEventListener("click", e => {
  const t = e.target.closest("[data-act],[data-nav]");
  if (!t) return;
  if (t.dataset.nav) { go(t.dataset.nav); return; }
  const act = t.dataset.act;
  if (act === "say") { const i = Number(t.dataset.i); state.playTok = null; if (state.speak[i]) speakText(state.speak[i], i, undefined, undefined, state.speakPitch?.[i] || 1); }
  else if (act === "unit") openUnit(t.dataset.unit);
  else if (act === "units-list") showUnits();
  else if (act === "step") { if (state.content) openStep(t.dataset.step); }
  else if (act === "unit-next") unitNext();
  else if (act === "unit-regen") { if (confirm("Bu ünitenin içeriği yeniden üretilsin mi? (İlerlemen silinmez.)")) openUnit(state.unitId, true); }
  else if (act === "play-all") playAll();
  else if (act === "stop-audio") { state.playTok = null; speech.stop(); }
  else if (act === "quiz-answer") quizAnswer(Number(t.dataset.o));
  else if (act === "quiz-next") { state.quiz.i++; state.quiz.chosen = null; renderQuiz(); }
  else if (act === "review") showReview();
  else if (act === "rv-show") { state.review.shown = true; renderReview(); if (state.speak[0]) speakText(state.speak[0], 0); }
  else if (act === "rv-ok") reviewGrade(true);
  else if (act === "rv-fail") reviewGrade(false);
  else if (act === "tr") {
    const open = t.parentNode.querySelector(".tr")?.classList.toggle("open");
    t.textContent = open ? "gizle" : "Türkçesi";
  }
  else if (act === "save-settings") saveSettings();
  else if (act === "test-voice") testVoice();
  else if (act === "test-key") testKey();
  else if (act === "update-check") checkUpdate(true);
  else if (act === "text-start") startTextFromForm();
  else if (act === "text-again") startText(store.get("study_text", ""), store.get("study_kind", "exam"));
  else if (act === "export") exportBackup();
  else if (act === "profile") showProfile(false);
  else if (act === "profile-save") saveProfile();
  else if (act === "diag-refresh") $("#diag").textContent = speech.diagnostics().join("\n") || "Henüz kayıt yok.";
  else if (act === "avatar-start") { $("#start-hint")?.remove(); ask(""); }
  else if (act === "key-guide") openKeyGuide();
  else if (act === "code-noted") { store.set("code_note_pending", false); showHome(); }
  else if (act === "copy-code") copyCode();
  else if (act === "backup-later") { cloud.snoozeFileBackup(); showHome(); }
  else if (act === "restore-code") restoreWithCode();
  else if (act === "cloud-on") { store.setSetting("backup_code", cloud.newCode()); store.set("code_note_pending", true); store.saveNow(); cloudNow(); }
  else if (act === "cloud-link") cloudLinkForm();
  else if (act === "cloud-link-go") cloudLinkGo();
  else if (act === "cloud-now") cloudNow();
  else if (act === "cloud-restore") cloudRestoreList();
  else if (act === "cloud-load") cloudLoad(t.dataset.file);
  else if (act === "cloud-off") cloudOff();
});

function go(nav) {
  if (nav === "home") showHome();
  else if (nav === "free") startFree();
  else if (nav === "units") showUnits();
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
  if (vm.state === "paused") vm.unpause();
  else if (vm.state === "waiting" && !state.busy) { speech.stop(); vm.resume(100); }
  else if (vm.state === "sleeping") { speech.stop(); vm.wake(); }
});
ui.mic.addEventListener("click", toggleMic);
ui.sttlang.addEventListener("click", toggleSttLang);
ui.input.addEventListener("keydown", e => {
  // Japonca klavyede dönüşüm sırasında Enter göndermesin
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); send(); }
});
ui.tr.addEventListener("change", () => {
  store.setSetting("show_tr", ui.tr.checked);
  document.body.classList.toggle("show-tr", ui.tr.checked);
});
ui.furi?.addEventListener("change", () => {
  store.setSetting("furigana", ui.furi.value);
  if (state.mode === "free" || (state.mode === "text" && state.sessionId)) renderChat();
});
// iPad'de ses ilk dokunuşla açılır
// iPad'de ses ancak bir dokunuşla açılır: her dokunuşta (en çok 20 sn'de bir) ses oturumu uyanık tutulur.
document.addEventListener("pointerdown", () => speech.unlock(), { capture: true });
document.addEventListener("keydown", () => speech.unlock(), { capture: true });
document.addEventListener("visibilitychange", () => { if (document.hidden) store.saveNow(); });

// ================= başlangıç =================
applySettings();
updateSttLang();
ensureBackupCode();             // 0.4 → 0.5: mevcut kullanıcıda Drive yedeği kendiliğinden açılır
if (S().profile_done) showHome(); else showProfile(true);
cloud.startAuto();
// iPad ses listesini açılıştan biraz sonra verir: gelince ana sayfadaki ses uyarısını yeniden değerlendir.
speech.voicesReady(4000).then(() => { if (state.mode === "home") showHome(); });
store.requestPersist();
if (pack.furigana) {
  furi.init().then(t => {
    if (state.mode === "home") showHome();
    else if (state.mode === "free" || state.mode === "unit" && state.header || (state.mode === "text" && state.sessionId)) renderChat();
    else if (state.mode === "units") showUnits();
    if (!t) toast("Furigana sözlüğü yüklenemedi; metinler furiganasız gösterilecek.", 6000);
  });
}
catchUpSummaries();
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register(new URL("sw.js", ROOT)).then(r => r.update()).catch(() => {});
}

// ================= güncelleme =================
// Her yayında GitHub version.json'a yeni bir "yapı" kimliği yazar. Uygulama açıldığında
// hangi yapıyla açıldığını hatırlar; öne gelince ve yarım saatte bir yeniden sorar.
// Farklıysa üstte "Güncelle" şeridi çıkar. (Ana ekrana eklenen uygulamada yenile düğmesi yok.)
let loadedBuild = null;
async function fetchBuild() {
  try {
    const r = await fetch(new URL("version.json?t=" + Date.now(), ROOT), { cache: "no-store" });
    if (!r.ok) return null;
    return (await r.json()).build || null;
  } catch (e) { return null; }
}
async function checkUpdate(manual = false) {
  const b = await fetchBuild();
  if (!loadedBuild) loadedBuild = b;
  const fresh = b && loadedBuild && b !== loadedBuild;
  if (fresh) $("#update-bar").hidden = false;
  if (manual) {
    if (fresh || !b) applyUpdate();
    else toast("Güncel. Yine de yenileniyor…", 1500), setTimeout(applyUpdate, 800);
  }
}
async function applyUpdate() {
  store.saveNow();
  toast("Güncelleniyor…", 2000);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  try { const r = await navigator.serviceWorker?.getRegistration(); await Promise.race([r?.update(), wait(1000)]); } catch (e) { /* */ }
  try { for (const k of await caches.keys()) if (k.startsWith("kotonoha-app-")) await caches.delete(k); } catch (e) { /* */ }
  location.reload();
}
$("#btn-update").addEventListener("click", applyUpdate);
fetchBuild().then(b => { loadedBuild = b; });
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkUpdate(); });
setInterval(checkUpdate, 30 * 60e3);
