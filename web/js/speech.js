// Ses: cihazın kendi sesleri (iPad: Kyoko, Anna, Samantha…) ve konuşma tanıma.
// Hece zamanları bilinmediği için ağız, dil paketinin verdiği hece dizisine göre hareket eder;
// konuşma hızı her cümleden sonra ölçülüp kendini ayarlar.
import { pack } from "./lang/index.js";

// Ağırlıkları zamana çevir: [{start, end, m}]
export function timeline(seq, secPerUnit) {
  let t = 0;
  return seq.map(s => {
    const d = s.w * secPerUnit;
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
let current = null;                  // {utter, raf, onEnd}
let secPerUnit = pack.secPerUnit;    // başlangıç tahmini; ölçtükçe düzelir

const langOf = v => (v.lang || "").toLowerCase().replace("_", "-");

let allCount = 0;                    // cihazdaki tüm seslerin sayısı (dil fark etmeksizin)
function loadVoices() {
  if (!synth) return;
  const all = synth.getVoices();
  allCount = all.length;
  voices = all.filter(v => langOf(v).startsWith(pack.code));
}
if (synth) {
  loadVoices();
  synth.addEventListener?.("voiceschanged", loadVoices);
}

export const ttsAvailable = () => !!synth;
export function targetVoices() { loadVoices(); return voices.map(v => v.name); }
// Ses listesi yüklendi mi? iPad listeyi açılıştan biraz sonra verir; ana ekran uygulamasında hiç
// vermeyebilir (o zaman dil adıyla konuşur). Liste boşken "ses yok" demek yanlış olur.
export function voicesKnown() { loadVoices(); return allCount > 0; }
export function voicesReady(timeout = 2500) {
  return new Promise(res => {
    if (!synth || voicesKnown()) { res(voicesKnown()); return; }
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (voicesKnown() || Date.now() - t0 > timeout) { clearInterval(iv); res(voicesKnown()); }
    }, 150);
  });
}

function pickVoice(name) {
  loadVoices();
  return voices.find(v => v.name === name)
    || pack.voicePrefs.map(re => voices.find(v => re.test(v.name))).find(Boolean)
    || voices.find(v => langOf(v) === pack.locale.toLowerCase())
    || voices[0] || null;
}

// ---------------- tanılama günlüğü (Ayarlar → 🔧 Ses günlüğü) ----------------
const dlog = [];
const T0 = Date.now();
export function log(msg) {
  dlog.push(`${((Date.now() - T0) / 1000).toFixed(1)}s ${msg}`);
  if (dlog.length > 60) dlog.shift();
}
export const diagnostics = () => dlog.slice();

// ---------------- iPad ses kilidi ----------------
// iPad bir sayfanın ses çıkarmasına ancak kullanıcının dokunuşu sırasında izin verir; cevap ise
// birkaç saniye sonra gelir. Bu yüzden HER dokunuşta (en çok 20 sn'de bir) ses oturumunu "çalma"
// kipinde uyanık tutuyoruz: (1) Web Audio ile duyulmayan kısacık bir ses, (2) boş bir konuşma.
// Uygulama arka plana gidip gelince kilit yeniden açılır.
let primedAt = 0, actx = null;
export function unlock() {
  if (!synth || Date.now() - primedAt < 20e3) return;
  primedAt = Date.now();
  loadVoices();
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      actx ||= new AC();
      actx.resume?.();
      const b = actx.createBuffer(1, 1, 22050), src = actx.createBufferSource();
      src.buffer = b; src.connect(actx.destination); src.start(0);
    }
  } catch (e) { /* */ }
  try {
    if (!synth.speaking && !synth.pending) {
      const u = new SpeechSynthesisUtterance(" "); u.lang = pack.locale; u.volume = 0; synth.speak(u);
    }
  } catch (e) { /* */ }
  log(`kilit açıldı (sesler: ${allCount})`);
}
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => { if (!document.hidden) primedAt = 0; });
}

// ---------------- mikrofon → hoparlör geçişi ----------------
// Mikrofon yeni kapandıysa iPad ses oturumunu bir an "kayıt" kipinde tutar ve konuşma duyulmayabilir.
let micAt = 0;
export function noteMicUsed() { micAt = Date.now(); }

export function stop() {
  if (current) { cancelAnimationFrame(current.raf); const cb = current.onEnd; current = null; cb?.(true); }
  if (synth?.speaking || synth?.pending) { synth.cancel(); justCancelled = true; }
}

/**
 * Metni seslendirir.  onMouth(şekil) her karede çağrılır, onEnd() bitince.
 * Ses kapalıysa ya da o dilde ses yoksa yalnızca ağız hareket eder.
 */
export function speak(text, { voiceName = "", rate = 0.9, pitch = 1, silent = false, onMouth = () => {}, onEnd = () => {} } = {}) {
  stop();
  const seq = pack.mouthSequence(text);
  const units = seq.reduce((a, s) => a + s.w, 0) || 1;
  const spu = () => secPerUnit / rate;
  const job = { raf: 0, onEnd: () => { onMouth("closed"); onEnd(); }, start: 0, voice: null, utter: null };
  current = job;

  const animate = () => {
    if (current !== job) return;
    const t = (performance.now() - job.start) / 1000;
    const tl = job.tl;
    onMouth(mouthAt(tl, t));
    if (!job.voice && t > (tl.length ? tl[tl.length - 1].end : 0)) { finish(); return; }
    job.raf = requestAnimationFrame(animate);
  };
  const begin = () => {
    if (job.start) return;
    job.start = performance.now(); job.tl = timeline(seq, spu()); animate();
  };
  const finish = () => {
    if (current !== job) return;
    cancelAnimationFrame(job.raf);
    current = null;
    job.onEnd();
  };

  if (silent || !synth) { begin(); return; }

  // attempt 0: normal deneme. iPad bazen (özellikle açılıştan sonraki ilk cümlede) sesi yutar:
  // konuşma başlamazsa iptal edip BİR kez daha denenir; o da olmazsa yalnızca ağız hareket eder.
  const startUtterance = attempt => {
    if (current !== job) return;
    const voice = pickVoice(voiceName);
    job.voice = voice;
    // Ses listesi boşsa (ana ekran uygulamasında olabiliyor) yalnızca dili veriyoruz; iPad o dildeki sesini kullanır.
    const u = new SpeechSynthesisUtterance(text);
    if (voice) u.voice = voice;
    u.lang = voice?.lang || pack.locale;
    u.rate = rate;
    u.pitch = pitch;          // sahnede ikinci kişi biraz farklı perdeden konuşur
    const mine = () => current === job && job.utter === u;
    const t1 = Date.now();
    log(`konuş #${attempt + 1}: ses=${voice?.name || "(dil: " + u.lang + ")"} liste=${allCount} "${text.slice(0, 18)}"`);
    u.onstart = () => { log(`başladı (+${Date.now() - t1} ms)`); if (mine()) begin(); };
    u.onend = () => {
      if (!mine()) return;
      // gerçek süreye göre hece süresini ayarla (bir sonraki cümle daha uyumlu olsun)
      const dur = (performance.now() - job.start) / 1000;
      if (job.start && units > 3) {
        const measured = (dur * rate) / units;
        if (measured > 0.05 && measured < 0.5) secPerUnit = 0.7 * secPerUnit + 0.3 * measured;
      }
      finish();
    };
    u.onerror = e => { log(`hata: ${e?.error || "?"}`); if (mine()) finish(); };
    job.utter = u;            // Safari'de çöpe gitmesin
    try { synth.resume(); } catch (e) { /* */ }
    synth.speak(u);
    setTimeout(() => {
      if (!mine() || job.start) return;
      if (synth.speaking && !synth.pending) { log("onstart gelmedi ama 'konuşuyor' görünüyor"); begin(); return; }
      log(`başlamadı → ${attempt === 0 ? "yeniden deneniyor" : "yalnızca ağız"}`);
      if (attempt === 0) {
        job.utter = null;      // iptalin tetiklediği onend/onerror bu işi bitirmesin
        try { synth.cancel(); } catch (e) { /* */ }
        setTimeout(() => startUtterance(1), 180);
      } else begin();
    }, attempt === 0 ? 900 : 700);
  };

  const go = () => {
    if (current !== job) return;
    // Mikrofon az önce kapandıysa iPad'in hoparlöre geçmesi için kısa bir ara (en çok 0.8 sn).
    const micWait = Math.max(0, micAt + 800 - Date.now());
    const run = () => {
      // Ses listesi henüz gelmediyse en fazla 1.5 sn bekle (ilk açılışta iPad'de olur).
      if (!voicesKnown()) voicesReady(1500).then(() => startUtterance(0));
      else startUtterance(0);
    };
    if (micWait) { log(`mikrofon yeni kapandı: ${micWait} ms bekleniyor`); setTimeout(run, micWait); } else run();
  };
  // Safari: cancel()'dan hemen sonra speak() çağrılırsa ses bazen yutuluyor; kısa bir ara ver.
  if (justCancelled) { justCancelled = false; setTimeout(go, 120); } else go();
}

// ---------------- konuşma tanıma (mikrofon) ----------------
const Rec = typeof window !== "undefined" ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;
export const sttAvailable = () => !!Rec;

// Tanıma sonuçlarını tek metne çevirir. iPad konuşmayı parçalara böler ve parçaları boşluksuz,
// her biri büyük harfle başlayan hâlde verir ("tanışmaKonuşmasını"); bazen de o ana kadarki metnin
// tamamını tekrar verir. Japoncada sözcük arası boşluk olmadığı için ayraç yok.
export function joinTranscripts(results, lang = pack.locale) {
  const sep = String(lang).startsWith("ja") ? "" : " ";
  let text = "";
  for (const r of results) {
    let t = (r[0]?.transcript || "").trim();
    if (!t) continue;
    if (text && t.startsWith(text)) { text = t; continue; }      // kümülatif tekrar
    if (text && text.endsWith(t)) continue;
    // Türkçe: cümle ortasında başlayan parçanın büyük harfini küçült
    if (text && String(lang).startsWith("tr") && !/[.!?…]$/.test(text)) t = t.charAt(0).toLocaleLowerCase("tr-TR") + t.slice(1);
    text = text ? text + sep + t : t;
  }
  return sep ? text.replace(/\s+/g, " ").trim() : text.trim();
}

/** Dinlemeye başlar. Durdurmak için dönen fonksiyonu çağır: stop() son sonucu da verir,
 *  stop(true) ise sessizce bırakır (gönderildikten sonra eski metin kutuya geri gelmesin). */
export function listen({ lang = pack.locale, onText = () => {}, onEnd = () => {}, onError = () => {} } = {}) {
  if (!Rec) { onError("Bu tarayıcı konuşma tanımayı desteklemiyor."); return () => {}; }
  stop();
  const r = new Rec();
  r.lang = lang;            // hedef dil ya da tr-TR (🇹🇷 düğmesi)
  r.interimResults = true;
  r.continuous = true;
  r.maxAlternatives = 1;
  let text = "", dead = false;
  r.onresult = e => {
    if (dead) return;
    text = joinTranscripts(e.results, lang);
    onText(text, false);
  };
  r.onerror = e => {
    if (dead) return;
    const msg = { "not-allowed": "Mikrofon izni verilmedi.", "service-not-allowed": "Konuşma tanıma izni yok (Ayarlar → Safari / Siri ve Dikte).",
                  "no-speech": "Ses duyulmadı.", "network": "Konuşma tanıma için internet gerekiyor." }[e.error] || e.error;
    onError(msg);
  };
  r.onend = () => { noteMicUsed(); if (dead) return; onText(text, true); onEnd(); };
  try { r.start(); } catch (e) { onError(String(e)); }
  return (discard = false) => {
    noteMicUsed();
    if (discard) { dead = true; try { r.abort(); } catch (e) { /* */ } }
    else { try { r.stop(); } catch (e) { /* */ } }
  };
}
