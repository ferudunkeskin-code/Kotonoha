// 🎧 Konuşma modu: düğmeye basmadan karşılıklı sesli sohbet.
//
// Durumlar:
//   off       kapalı
//   listening dinliyor; kısa bir sessizlik olunca söyleneni gönderir
//   waiting   cevap bekleniyor / avatar konuşuyor (mikrofon kapalı: avatarın sesini duymasın)
//   sleeping  uykuda; yalnızca uyanma sözünü bekler, başka hiçbir şeyi göndermez
//
// Uyku sözü: おやすみ   ·   Uyanma sözü: ねえ、コトノハ (コトノハ demek yeterli)
// Mikrofon Japonca dinlediği için sözler de Japonca.

const Rec = typeof window !== "undefined" ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;

const SILENCE_MS = 1400;           // bu kadar sessizlik olunca söylenen gönderilir
const IDLE_TO_SLEEP_MS = 3 * 60e3; // 3 dakika kimse konuşmazsa uyur
const SLEEP_TO_OFF_MS = 5 * 60e3;  // 5 dakika uykuda kalırsa tamamen kapanır

const SLEEP_WORDS = ["おやすみ", "お休み", "オヤスミ"];
const WAKE_WORDS = ["ことのは", "コトノハ", "言の葉", "言葉", "kotonoha"];

export const voiceModeAvailable = () => !!Rec;

const norm = s => String(s || "").toLowerCase().replace(/[\s、。！？!?,.・「」ー〜~]/g, "");
export const hasSleepWord = s => SLEEP_WORDS.some(w => norm(s).includes(norm(w)));
export const hasWakeWord = s => WAKE_WORDS.some(w => norm(s).includes(norm(w)));

// iOS bazen her sonuçta o ana kadarki metnin tamamını tekrar verir; tekrarları ayıkla.
export function joinResults(results) {
  let text = "";
  for (const r of results) {
    const t = r[0]?.transcript || "";
    if (!t) continue;
    if (t.startsWith(text)) text = t;
    else if (!text.endsWith(t)) text += t;
  }
  return text.trim();
}

export class VoiceMode {
  /**
   * cb.onUtterance(text)  söylenen gönderilecek
   * cb.onState(state, detail)  arayüzü güncelle
   * cb.onSleep() / cb.onWake()  avatar uyur / uyanır
   * cb.onError(msg)
   */
  constructor(cb) {
    this.cb = cb;
    this.state = "off";
    this.rec = null;
    this.text = "";
    this.silenceTimer = null;
    this.idleTimer = null;
    this.offTimer = null;
    this.wakeLock = null;
    this.failures = 0;
    document.addEventListener("visibilitychange", () => {
      if (this.state === "off") return;
      if (document.hidden) this._stopRec();
      else { this._lockScreen(); if (this.state === "listening" || this.state === "sleeping") this._startRec(); }
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

  sleep() {
    if (!this.on) return;
    this._clearTimers();
    this._stopRec();
    this._set("sleeping");
    this.cb.onSleep?.();
    // Uyanma sözünü dinlemeye, avatar "おやすみなさい" deyip bitirince başlanır: listenForWake()
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
    this._set("listening");
    this.idleTimer = setTimeout(() => { if (this.state === "listening" && !this.text) this.sleep(); }, IDLE_TO_SLEEP_MS);
    this._startRec();
  }

  _startRec() {
    this._stopRec();
    const r = new Rec();
    r.lang = "ja-JP";
    r.continuous = true;
    r.interimResults = true;
    r.maxAlternatives = 1;
    this.rec = r;
    r.onresult = e => {
      if (this.rec !== r) return;
      this.failures = 0;
      const t = joinResults(e.results);
      if (this.state === "sleeping") {
        if (hasWakeWord(t)) { this._stopRec(); this._clearTimers(); this._set("waiting"); this.cb.onWake?.(); }
        return;
      }
      if (this.state !== "listening") return;
      this.text = t;
      this.cb.onState?.("listening", t);
      clearTimeout(this.silenceTimer);
      this.silenceTimer = setTimeout(() => this._commit(), SILENCE_MS);
    };
    r.onerror = e => {
      if (this.rec !== r) return;
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        this.stop();
        this.cb.onError?.(e.error === "not-allowed" ? "Mikrofon izni verilmedi."
          : "Konuşma tanıma kapalı (iPad: Ayarlar → Genel → Klavye → Dikte'yi açın).");
      }
      // "no-speech", "aborted" vb.: onend'de yeniden başlatılır
    };
    r.onend = () => {
      if (this.rec !== r) return;
      this.rec = null;
      // Tarayıcı dinlemeyi kendi kendine kestiyse (iPad bunu sık yapar) kaldığı yerden sürdür.
      if (this.state === "listening" && this.text) { this._commit(); return; }
      if (this.state === "listening" || this.state === "sleeping") {
        this.failures++;
        if (this.failures > 8) { this.stop(); this.cb.onError?.("Mikrofon art arda kapandı; konuşma modu durduruldu."); return; }
        setTimeout(() => {
          if ((this.state === "listening" || this.state === "sleeping") && !this.rec && !document.hidden) this._startRec();
        }, 250 * Math.min(this.failures, 4));
      }
    };
    try { r.start(); } catch (e) { /* onend yeniden dener */ }
  }

  _stopRec() {
    const r = this.rec;
    this.rec = null;
    if (r) { try { r.abort(); } catch (e) { /* */ } }
  }

  _commit() {
    clearTimeout(this.silenceTimer);
    const t = this.text.trim();
    if (this.state !== "listening" || !t) return;
    this.text = "";
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
