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

// iPad, sesi ilk kez bir dokunuşla başlatmayı şart koşar.
export function unlock() {
  if (unlocked || !synth) return;
  unlocked = true;
  loadVoices();
  // Sessiz, kısa bir hece söyletiyoruz.
  try { const u = new SpeechSynthesisUtterance("a"); u.lang = pack.locale; u.volume = 0; u.rate = 2; synth.speak(u); }
  catch (e) { /* */ }
}

export function stop() {
  if (current) { cancelAnimationFrame(current.raf); const cb = current.onEnd; current = null; cb?.(true); }
  if (synth?.speaking || synth?.pending) { synth.cancel(); justCancelled = true; }
}

/**
 * Metni seslendirir.  onMouth(şekil) her karede çağrılır, onEnd() bitince.
 * Ses kapalıysa ya da o dilde ses yoksa yalnızca ağız hareket eder.
 */
export function speak(text, { voiceName = "", rate = 0.9, silent = false, onMouth = () => {}, onEnd = () => {} } = {}) {
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
    const mine = () => current === job && job.utter === u;
    u.onstart = () => { if (mine()) begin(); };
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
    u.onerror = () => { if (mine()) finish(); };
    job.utter = u;            // Safari'de çöpe gitmesin
    try { synth.resume(); } catch (e) { /* */ }
    synth.speak(u);
    setTimeout(() => {
      if (!mine() || job.start) return;
      if (synth.speaking && !synth.pending) { begin(); return; }   // ses çalıyor, yalnızca onstart gelmedi
      if (attempt === 0) {
        job.utter = null;      // iptalin tetiklediği onend/onerror bu işi bitirmesin
        try { synth.cancel(); } catch (e) { /* */ }
        setTimeout(() => startUtterance(1), 180);
      } else begin();
    }, attempt === 0 ? 900 : 700);
  };

  const go = () => {
    if (current !== job) return;
    // Ses listesi henüz gelmediyse en fazla 1.5 sn bekle (ilk açılışta iPad'de olur).
    if (!voicesKnown()) voicesReady(1500).then(() => startUtterance(0));
    else startUtterance(0);
  };
  // Safari: cancel()'dan hemen sonra speak() çağrılırsa ses bazen yutuluyor; kısa bir ara ver.
  if (justCancelled) { justCancelled = false; setTimeout(go, 120); } else go();
}

// ---------------- konuşma tanıma (mikrofon) ----------------
const Rec = typeof window !== "undefined" ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;
export const sttAvailable = () => !!Rec;

/** Dinlemeye başlar; durdurmak için dönen fonksiyonu çağır. */
export function listen({ lang = pack.locale, onText = () => {}, onEnd = () => {}, onError = () => {} } = {}) {
  if (!Rec) { onError("Bu tarayıcı konuşma tanımayı desteklemiyor."); return () => {}; }
  stop();
  const r = new Rec();
  r.lang = lang;            // hedef dil ya da tr-TR (🇹🇷 düğmesi)
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
