// 🎧 Konuşma modu: düğmeye basmadan karşılıklı sesli sohbet.
//
// Durumlar:
//   off       kapalı
//   listening dinliyor; kısa bir sessizlik olunca söyleneni gönderir
//   waiting   cevap bekleniyor / avatar konuşuyor (mikrofon kapalı: avatarın sesini duymasın)
//   sleeping  uykuda; yalnızca uyanma sözünü bekler, başka hiçbir şeyi göndermez
//   paused    kullanıcı duraklattı (⏸); mikrofon kapalı, ▶ ile kaldığı yerden sürer
//
// Düşünme zamanı:
//   - Söz bitince geri sayım başlar (silenceMs). Bu sırada "✋ Bekle"ye basılırsa geri sayım durur;
//     konuşma sürer, istediği zaman "➤ Gönder"e basar (holding).
//   - "Ben basınca gönder" ayarında (manual) hiç otomatik gönderilmez.
//   - Söz bir duraksama sözcüğüyle bitiyorsa (えーと, ähm, um…) bekleme iki katına çıkar.
//
// Uyku ve uyanma sözleri dil paketinden gelir (ja: おやすみ / ねえ、コトノハ;
// de: Gute Nacht / Hallo <ad>; en: Good night / Hey <ad>). Mikrofon hedef dili dinler.
import { pack } from "./lang/index.js";
import { joinTranscripts, noteMicUsed } from "./speech.js";

const Rec = typeof window !== "undefined" ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;

export const DEFAULT_SILENCE_MS = 1400;   // bu kadar sessizlik olunca söylenen gönderilir (Ayarlar'dan değişir)
const IDLE_TO_SLEEP_MS = 3 * 60e3; // 3 dakika kimse konuşmazsa uyur
const SLEEP_TO_OFF_MS = 5 * 60e3;  // 5 dakika uykuda kalırsa tamamen kapanır
const PAUSE_TO_OFF_MS = 10 * 60e3; // 10 dakika duraklatılmış kalırsa kapanır

export const voiceModeAvailable = () => !!Rec;

const norm = s => String(s || "").toLowerCase().replace(/[\s、。！？!?,.・「」ー〜~„“”"'’]/g, "");
const hasAny = (s, words) => words.filter(Boolean).some(w => norm(w) && norm(s).includes(norm(w)));
// Türkçe dinlerken de uyutulabilsin
export const hasSleepWord = (s, words = [...pack.sleepWords, "iyi geceler"]) => hasAny(s, words);
export const hasWakeWord = (s, words = pack.wakeWords("")) => hasAny(s, words);
// Söz bir duraksama sözcüğüyle mi bitiyor? (öğrenci düşünüyor, cümlesi bitmedi)
export function endsWithFiller(s, fillers = pack.fillers || []) {
  const t = String(s || "").toLowerCase().replace(/[\s、。！？!?,.…ー〜~]+$/g, "");
  // Japoncada sözcük arası boşluk yok; diğerlerinde sözcük sınırına bak ("water" ≠ "er")
  return fillers.some(f => pack.code === "ja" ? t.endsWith(f) : (" " + t).endsWith(" " + f.toLowerCase()));
}
const sepFor = lang => (lang || "").startsWith("ja") ? "" : " ";

// (eski ad; testler ve geriye uyumluluk için)
export const joinResults = results => joinTranscripts(results);

export class VoiceMode {
  /**
   * cb.onUtterance(text)  söylenen gönderilecek
   * cb.onState(state, detail)  arayüzü güncelle
   * cb.onSleep() / cb.onWake()  avatar uyur / uyanır
   * cb.onError(msg)
   * cb.wakeWords()  uyanma sözleri (karakterin adı değişebildiği için her seferinde sorulur)
   */
  constructor(cb) {
    this.cb = cb;
    this.state = "off";
    this.silenceMs = DEFAULT_SILENCE_MS;
    this.rec = null;
    this.text = "";
    this.silenceTimer = null;
    this.idleTimer = null;
    this.offTimer = null;
    this.wakeLock = null;
    this.failures = 0;
    this.manual = false;      // true: yalnızca "➤ Gönder" ile gönderilir
    this.holding = false;     // kullanıcı "✋ Bekle"ye bastı: bu söz için otomatik gönderme yok
    this.lang = pack.locale;  // dinlenen dil: hedef dil ya da tr-TR (🇹🇷 düğmesi)
    document.addEventListener("visibilitychange", () => {
      if (this.state === "off") return;
      if (document.hidden) this._stopRec();
      else { this._lockScreen(); if (this.state === "listening" || this.state === "sleeping") this._startRec(this.text); }
    });
  }

  get on() { return this.state !== "off"; }

  // Bir dokunuşun içinden çağrılmalı (iPad mikrofonu ilk kez ancak böyle açar).
  start() {
    if (!Rec) { this.cb.onError?.("Bu tarayıcı konuşma tanımayı desteklemiyor."); return; }
    this.failures = 0;
    this._lockScreen();
    this._listen();
  }

  stop() {
    this._clearTimers();
    this._stopRec();
    this._unlockScreen();
    this._set("off");
  }

  // Gönderildi; cevap gelip avatar konuşana kadar mikrofon kapalı.
  pause() {
    if (!this.on) return;
    this._clearTimers();
    this._stopRec();
    this._set("waiting");
  }

  // Avatar sustu (ya da bir hata oldu): yeniden dinle.
  resume(delay = 450) {
    if (this.state !== "waiting") return;
    setTimeout(() => { if (this.state === "waiting") this._listen(); }, delay);
  }

  // ⏸ Kullanıcı duraklattı: mikrofon kapanır, avatar bekler. ▶ (unpause) ile kaldığı yerden.
  pauseByUser() {
    if (!this.on || this.state === "sleeping") return;
    this._clearTimers();
    this._stopRec();
    this._countdown(0);
    this._set("paused");
    this.offTimer = setTimeout(() => { this.stop(); this.cb.onError?.("Uzun süre duraklatıldığı için konuşma modu kapandı."); }, PAUSE_TO_OFF_MS);
  }
  unpause() {
    if (this.state !== "paused") return;
    this._clearTimers();
    const keep = this.text;
    this._listen();
    this.text = keep;           // duraklatmadan önce söylenenler kaybolmasın
    if (keep) { this.holding = true; this.cb.onState?.("listening", keep); this._startRec(keep); }
  }

  // ✋ Bekle: geri sayımı durdur; konuşmaya devam et, bitince "➤ Gönder".
  hold() {
    if (this.state !== "listening") return;
    clearTimeout(this.silenceTimer);
    this.holding = true;
    this._countdown(0);
    this.cb.onState?.("listening", this.text);
  }
  // ➤ Gönder: şimdi gönder.
  send() {
    if (this.state === "listening" && this.text.trim()) this._commit();
  }
  // Söyleneni sil, baştan konuş.
  clearText() {
    if (this.state !== "listening") return;
    clearTimeout(this.silenceTimer);
    this._countdown(0);
    this.text = "";
    this.holding = false;
    this.cb.onState?.("listening", "");
    this._startRec("");
  }
  // Mikrofon dilini değiştir (hedef dil ↔ Türkçe). Dinliyorsa söyleneni koruyup yeni dille sürdürür.
  setLang(lang) {
    if (lang === this.lang) return;
    this.lang = lang;
    if (this.state === "listening" || this.state === "sleeping") {
      clearTimeout(this.silenceTimer);
      this._countdown(0);
      if (this.text) this.holding = true;
      this._startRec(this.state === "listening" ? this.text : "");
      this.cb.onState?.(this.state, this.text);
    }
  }

  get waitingForSend() { return this.state === "listening" && !!this.text && (this.manual || this.holding); }

  sleep() {
    if (!this.on) return;
    this._clearTimers();
    this._stopRec();
    this._set("sleeping");
    this.cb.onSleep?.();
    // Uyanma sözünü dinlemeye, avatar iyi geceler deyip bitirince başlanır: listenForWake()
    this.offTimer = setTimeout(() => { this.stop(); this.cb.onError?.("Uzun süre uykuda kaldığı için konuşma modu kapandı."); }, SLEEP_TO_OFF_MS);
  }

  // Elle uyandırma (avatara dokunmak)
  wake() {
    if (this.state !== "sleeping") return;
    this._clearTimers();
    this._stopRec();
    this._set("waiting");
    this.cb.onWake?.();
  }

  listenForWake(delay = 400) {
    setTimeout(() => { if (this.state === "sleeping" && !this.rec) this._startRec(); }, delay);
  }

  // ---------------- iç işleyiş ----------------
  _set(state, detail = "") { this.state = state; this.cb.onState?.(state, detail); }

  _listen() {
    this._clearTimers();
    this.text = "";
    this.holding = false;
    this._countdown(0);
    this._set("listening");
    this.idleTimer = setTimeout(() => { if (this.state === "listening" && !this.text) this.sleep(); }, IDLE_TO_SLEEP_MS);
    this._startRec();
  }

  _countdown(ms) { this.cb.onCountdown?.(ms); }

  // base: tarayıcı dinlemeyi kesip yeniden başlatınca önceki söylenenler korunur (bekleme/elle gönderme)
  _startRec(base = "") {
    this._stopRec();
    const r = new Rec();
    r.lang = this.lang || pack.locale;
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;
    this.rec = r;
    r.onresult = e => {
      if (this.rec !== r) return;
      this.failures = 0;
      const t = joinTranscripts(e.results, this.lang);
      if (this.state === "sleeping") {
        const words = this.cb.wakeWords ? this.cb.wakeWords() : pack.wakeWords("");
        if (hasWakeWord(t, words)) { this._stopRec(); this._clearTimers(); this._set("waiting"); this.cb.onWake?.(); }
        return;
      }
      if (this.state !== "listening") return;
      this.text = base && t ? base + sepFor(this.lang) + t : (base || t);
      this.cb.onState?.("listening", this.text);
      clearTimeout(this.silenceTimer);
      if (this.manual || this.holding) return;          // kullanıcı "➤ Gönder"e basacak
      const wait = this.silenceMs * (endsWithFiller(this.text) ? 2 : 1);
      this._countdown(wait);
      this.silenceTimer = setTimeout(() => this._commit(), wait);
    };
    r.onerror = e => {
      if (this.rec !== r) return;
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        this.stop();
        this.cb.onError?.(e.error === "not-allowed" ? "Mikrofon izni verilmedi."
          : "Konuşma tanıma kapalı (iPad: Ayarlar → Genel → Klavye → Dikte'yi açın; Android: Google uygulamasının mikrofon iznini açın).");
      }
      // "no-speech", "aborted" vb.: onend'de yeniden başlatılır
    };
    r.onend = () => {
      if (this.rec !== r) return;
      this.rec = null;
      // Tarayıcı dinlemeyi kendi kendine kestiyse (iPad bunu sık yapar) kaldığı yerden sürdür.
      // Bekleme/elle gönderme açıksa söyleneni koruyup dinlemeyi sürdür.
      if (this.state === "listening" && this.text && !(this.manual || this.holding)) { this._commit(); return; }
      if (this.state === "listening" || this.state === "sleeping") {
        if (!this.text) this.failures++;     // bekleme sırasında sessiz kalmak hata sayılmaz
        if (this.failures > 8) { this.stop(); this.cb.onError?.("Mikrofon art arda kapandı; konuşma modu durduruldu."); return; }
        setTimeout(() => {
          if ((this.state === "listening" || this.state === "sleeping") && !this.rec && !document.hidden)
            this._startRec(this.state === "listening" ? this.text : "");
        }, 250 * Math.min(this.failures, this.text ? 1 : 4));
      }
    };
    try { r.start(); } catch (e) { /* onend yeniden dener */ }
  }

  _stopRec() {
    const r = this.rec;
    this.rec = null;
    if (r) noteMicUsed();
    if (r) { try { r.abort(); } catch (e) { /* */ } }
  }

  _commit() {
    clearTimeout(this.silenceTimer);
    this._countdown(0);
    const t = this.text.trim();
    if (this.state !== "listening" || !t) return;
    this.text = "";
    this.holding = false;
    if (hasSleepWord(t)) { this.sleep(); return; }
    this.pause();
    this.cb.onUtterance?.(t);
  }

  _clearTimers() {
    clearTimeout(this.silenceTimer);
    clearTimeout(this.idleTimer);
    clearTimeout(this.offTimer);
  }

  async _lockScreen() {
    // Konuşma modu açıkken ekran kararmasın (kararırsa mikrofon kapanır).
    try {
      if (navigator.wakeLock && !this.wakeLock) {
        this.wakeLock = await navigator.wakeLock.request("screen");
        this.wakeLock.addEventListener?.("release", () => { this.wakeLock = null; });
      }
    } catch (e) { /* desteklenmiyorsa sorun değil */ }
  }

  _unlockScreen() {
    try { this.wakeLock?.release(); } catch (e) { /* */ }
    this.wakeLock = null;
  }
}
