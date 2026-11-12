// Ses: iPad'in kendi Japonca sesleri (Kyoko, O-ren) ve konuşma tanıma.
// VOICEVOX'taki gibi hece zamanları bilinmediği için ağız, okunuştaki hecelere göre
// hareket eder; konuşma hızı her cümleden sonra ölçülüp kendini ayarlar.
import { readingOf, kataToHira } from "./furigana.js";

// ---------------- hece → ağız şekli ----------------
const VOWEL = {};
for (const [v, chars] of Object.entries({
  a: "あかさたなはまやらわがざだばぱぁ", i: "いきしちにひみりぎじぢびぴぃ",
  u: "うくすつぬふむゆるぐずづぶぷぅゔ", e: "えけせてねへめれげぜでべぺぇ",
  o: "おこそとのほもよろをごぞどぼぽぉ",
})) for (const c of chars) VOWEL[c] = v;
const SMALL_Y = { "ゃ": "a", "ゅ": "u", "ょ": "o" };
const PAUSE = "、。！？!?…・「」『』（）() 　\n,.";
const KANJI_RE = /[㐀-鿿々]/;

// [{m: ağız, w: ağırlık}] — w: hece=1, duraklama=2
export function moraSequence(text) {
  const read = kataToHira(readingOf(text));
  const seq = [];
  let i = 0;
  for (const c of read) {
    if (PAUSE.includes(c)) { if (seq.length && seq[seq.length - 1].m !== "closed") seq.push({ m: "closed", w: 2 }); continue; }
    if (c in SMALL_Y) { if (seq.length) seq[seq.length - 1].m = SMALL_Y[c]; continue; }
    if (c === "っ") { seq.push({ m: "closed", w: 1 }); continue; }
    if (c === "ん") { seq.push({ m: "n", w: 1 }); continue; }
    if (c === "ー") { seq.push({ m: seq.length ? seq[seq.length - 1].m : "a", w: 1 }); continue; }
    if (c in VOWEL) { seq.push({ m: VOWEL[c], w: 1 }); continue; }
    if (KANJI_RE.test(c)) {           // sözlük yoksa: kanji ≈ 2 hece
      seq.push({ m: "aoeiu"[i++ % 5], w: 1 }, { m: "aoeiu"[i++ % 5], w: 1 }); continue;
    }
    // Latin harfler vb.: yaklaşık
    if (/[a-z]/i.test(c)) { if (/[aeiou]/i.test(c)) seq.push({ m: c.toLowerCase(), w: 1 }); continue; }
  }
  while (seq.length && seq[seq.length - 1].m === "closed") seq.pop();
  return seq;
}

// Ağırlıkları zamana çevir: [{start, end, m}]
export function timeline(seq, secPerMora) {
  let t = 0;
  return seq.map(s => {
    const d = s.w * secPerMora;
    const r = { start: t, end: t + d, m: s.m };
    t += d;
    return r;
  });
}

export function mouthAt(tl, t) {
  for (const s of tl) if (t >= s.start && t < s.end) return s.m;
  return "closed";
}

// ---------------- seslendirme ----------------
const synth = typeof window !== "undefined" ? window.speechSynthesis : null;
let voices = [];
let unlocked = false;
let justCancelled = false;
let current = null;            // {utter, raf, onEnd}
let secPerMora = 0.135;        // iPad Kyoko ~ hız 1.0 için başlangıç tahmini; ölçtükçe düzelir

function loadVoices() {
  if (!synth) return;
  voices = synth.getVoices().filter(v => (v.lang || "").toLowerCase().replace("_", "-").startsWith("ja"));
}
if (synth) {
  loadVoices();
  synth.addEventListener?.("voiceschanged", loadVoices);
}

export const ttsAvailable = () => !!synth;
export function japaneseVoices() { loadVoices(); return voices.map(v => v.name); }

function pickVoice(name) {
  loadVoices();
  return voices.find(v => v.name === name)
    || voices.find(v => /kyoko/i.test(v.name))
    || voices.find(v => /o-?ren/i.test(v.name))
    || voices[0] || null;
}

// iPad, sesi ilk kez bir dokunuşla başlatmayı şart koşar.
export function unlock() {
  if (unlocked || !synth) return;
  unlocked = true;
  // iPad: ilk konuşma bir dokunuşun içinde başlamalı; sessiz, kısa bir Japonca hece söyletiyoruz.
  try { const u = new SpeechSynthesisUtterance("あ"); u.lang = "ja-JP"; u.volume = 0; u.rate = 2; synth.speak(u); }
  catch (e) { /* */ }
}

export function stop() {
  if (current) { cancelAnimationFrame(current.raf); const cb = current.onEnd; current = null; cb?.(true); }
  if (synth?.speaking || synth?.pending) { synth.cancel(); justCancelled = true; }
}

/**
 * Metni seslendirir.  onMouth(şekil) her karede çağrılır, onEnd() bitince.
 * Ses kapalıysa ya da Japonca ses yoksa yalnızca ağız hareket eder.
 */
export function speak(text, { voiceName = "", rate = 0.9, silent = false, onMouth = () => {}, onEnd = () => {} } = {}) {
  stop();
  const seq = moraSequence(text);
  const moraCount = seq.reduce((a, s) => a + s.w, 0) || 1;
  const voice = silent ? null : pickVoice(voiceName);
  const spm = () => secPerMora / rate;
  const job = { raf: 0, onEnd: () => { onMouth("closed"); onEnd(); }, start: 0 };
  current = job;

  const animate = () => {
    if (current !== job) return;
    const t = (performance.now() - job.start) / 1000;
    const tl = job.tl;
    onMouth(mouthAt(tl, t));
    if (!voice && t > (tl.length ? tl[tl.length - 1].end : 0)) { finish(); return; }
    job.raf = requestAnimationFrame(animate);
  };
  const begin = () => { job.start = performance.now(); job.tl = timeline(seq, spm()); animate(); };
  const finish = () => {
    if (current !== job) return;
    cancelAnimationFrame(job.raf);
    current = null;
    job.onEnd();
  };

  if (silent || !synth) { begin(); return; }

  // iPad, ana ekrana eklenmiş uygulamada ses listesini bazen boş verir. O zaman ses
  // nesnesi seçmeden yalnızca dili "ja-JP" yapıyoruz; iPad kendi Japonca sesini kullanır.
  const u = new SpeechSynthesisUtterance(text);
  if (voice) u.voice = voice;
  u.lang = voice?.lang || "ja-JP";
  u.rate = rate;
  u.onstart = () => { if (current === job) begin(); };
  u.onend = () => {
    if (current !== job) return;
    // gerçek süreye göre hece süresini ayarla (bir sonraki cümle daha uyumlu olsun)
    const dur = (performance.now() - job.start) / 1000;
    if (job.start && moraCount > 3) {
      const measured = (dur * rate) / moraCount;
      if (measured > 0.05 && measured < 0.4) secPerMora = 0.7 * secPerMora + 0.3 * measured;
    }
    finish();
  };
  u.onerror = () => finish();
  job.utter = u;            // Safari'de çöpe gitmesin
  // Safari: cancel()'dan hemen sonra speak() çağrılırsa ses bazen yutuluyor; kısa bir ara ver.
  const go = () => { if (current !== job) return; try { synth.resume(); } catch (e) { /* */ } synth.speak(u); };
  if (justCancelled) { justCancelled = false; setTimeout(go, 120); } else go();
  // bazı durumlarda onstart gelmez: yarım saniye sonra animasyonu yine de başlat
  setTimeout(() => { if (current === job && !job.start) begin(); }, 600);
}

export function speakMany(texts, opts) {
  const list = [...texts];
  const next = cancelled => {
    if (cancelled || !list.length) { opts.onAllEnd?.(); return; }
    speak(list.shift(), { ...opts, onEnd: () => setTimeout(() => next(false), 250) });
  };
  next(false);
}

// ---------------- konuşma tanıma (mikrofon) ----------------
const Rec = typeof window !== "undefined" ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;
export const sttAvailable = () => !!Rec;

/** Dinlemeye başlar; durdurmak için dönen fonksiyonu çağır. */
export function listen({ onText = () => {}, onEnd = () => {}, onError = () => {} } = {}) {
  if (!Rec) { onError("Bu tarayıcı konuşma tanımayı desteklemiyor."); return () => {}; }
  stop();
  const r = new Rec();
  r.lang = "ja-JP";
  r.interimResults = true;
  r.continuous = true;
  r.maxAlternatives = 1;
  let finalText = "";
  r.onresult = e => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      if (res.isFinal) finalText += res[0].transcript;
      else interim += res[0].transcript;
    }
    onText(finalText + interim, false);
  };
  r.onerror = e => {
    const msg = { "not-allowed": "Mikrofon izni verilmedi.", "service-not-allowed": "Konuşma tanıma izni yok (Ayarlar → Safari / Siri ve Dikte).",
                  "no-speech": "Ses duyulmadı.", "network": "Konuşma tanıma için internet gerekiyor." }[e.error] || e.error;
    onError(msg);
  };
  r.onend = () => { onText(finalText, true); onEnd(); };
  try { r.start(); } catch (e) { onError(String(e)); }
  return () => { try { r.stop(); } catch (e) { /* */ } };
}
