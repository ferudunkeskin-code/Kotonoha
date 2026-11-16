// ☁️ Google Drive yedeği (Apps Script üzerinden) + dosya yedeği hatırlatması.
//
// Neden uygulamanın dışında? iPad'de ana ekrandaki simge silinirse o simgenin deposu da içindeki
// her şeyle silinir; uygulamanın kendi içine aldığı yedek de onunla gider. Drive'daki kopya kalır.
//
// Ne zaman yedek alınır (yalnızca bir şey değiştiyse ve hafıza boş değilse):
//   - bir sohbetin özeti çıkınca,
//   - uygulama açıkken 5 dakikada bir bakılır; son yedekten 30 dk geçmişse,
//   - açılıştan 30 sn sonra, son yedek 1 günden eskiyse (açılışı yavaşlatmaz).
// Boş bir hafıza asla yüklenmez: yeni kurulan uygulama eski yedeğin üstüne yazamaz.
import { BACKUP_URL } from "./config.js";
import * as store from "./store.js";
import { pack } from "./lang/index.js";

const STATUS_KEY = `kotonoha-cloud-${pack.code}`;
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";      // karışan harfler yok (I, L, O, U)
const REMIND_DAYS = 7;

export const configured = () => !!BACKUP_URL;
export const code = () => store.settings().backup_code || "";
export const enabled = () => configured() && !!code();

export function status() {
  try { return JSON.parse(globalThis.localStorage.getItem(STATUS_KEY)) || {}; } catch (e) { return {}; }
}
function setStatus(patch) {
  const st = { ...status(), ...patch };
  try { globalThis.localStorage.setItem(STATUS_KEY, JSON.stringify(st)); } catch (e) { /* */ }
  listeners.forEach(f => f(st));
  return st;
}
const listeners = [];
export const onStatus = f => listeners.push(f);

// ---------- yedek kodu ----------
export function newCode() {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  const c = [...b].map(x => ALPHABET[x % 32]).join("");
  return `KTN-${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}`;
}
// Elle yazılan kodu düzeltir: küçük harf, boşluk, O→0, I/L→1
export function normalizeCode(s) {
  const raw = String(s || "").toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/^KTN/, "")
    .replace(/O/g, "0").replace(/[IL]/g, "1");
  if (raw.length !== 12 || [...raw].some(c => !ALPHABET.includes(c))) return null;
  return `KTN-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

// ---------- sunucu ----------
async function call(body) {
  if (!BACKUP_URL) throw new Error("Drive yedeği bu sitede ayarlanmamış.");
  let r;
  try {
    // text/plain: tarayıcı ön-istek (CORS preflight) göndermesin; Apps Script bunu sever.
    r = await fetch(BACKUP_URL, { method: "POST", headers: { "content-type": "text/plain;charset=utf-8" },
                                  body: JSON.stringify(body), redirect: "follow" });
  } catch (e) { throw new Error("Drive'a ulaşılamadı (internet bağlantısı?)."); }
  let j;
  try { j = await r.json(); } catch (e) { throw new Error(`Drive yedek sunucusu beklenmeyen cevap verdi (${r.status}).`); }
  if (!j.ok) { const err = new Error(j.error || "Drive yedeği başarısız."); err.notFound = !!j.notFound; throw err; }
  return j;
}

let inflight = null;
export async function backupNow({ force = false } = {}) {
  if (!enabled() || store.isEmpty()) return "skip";
  const rev = store.rev();
  if (!force && status().last_rev === rev) return "same";
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      await call({ action: "save", code: code(), lang: pack.code, name: store.settings().learner_name,
                   data: store.exportCompactJSON() });
      setStatus({ last_at: new Date().toISOString(), last_rev: store.rev(), last_error: null });
      return "ok";
    } catch (e) {
      setStatus({ last_error: e.message, last_try: new Date().toISOString() });
      throw e;
    } finally { inflight = null; }
  })();
  return inflight;
}

export const list = c => call({ action: "list", code: c || code(), lang: pack.code }).then(j => j.files || []);
export const load = (c, file) => call({ action: "load", code: c || code(), lang: pack.code, file }).then(j => j.data);

// Koddaki yedeği bu cihaza yükler ve kodu bu cihaza bağlar.
export async function restoreFrom(c, file) {
  const data = await load(c, file);
  store.importJSON(data);
  store.setSetting("backup_code", c);
  store.saveNow();
  setStatus({ last_at: new Date().toISOString(), last_rev: store.rev(), last_error: null });
}

// ---------- otomatik ----------
const ago = iso => iso ? Date.now() - new Date(iso).getTime() : Infinity;
const dirty = () => status().last_rev !== store.rev();

export function startAuto() {
  const quiet = () => backupNow().catch(() => {});
  setTimeout(() => { if (enabled() && dirty() && ago(status().last_at) > 24 * 3600e3) quiet(); }, 30e3);
  setInterval(() => {
    if (enabled() && !document.hidden && dirty() && ago(status().last_at) > 30 * 60e3) quiet();
  }, 5 * 60e3);
}

// ---------- dosya yedeği hatırlatması (Drive kapalıyken) ----------
// 7 gün geçtiyse VE bu arada yeni bir sohbet olduysa hatırlatır; kullanılmayan uygulama dırdır etmez.
export function fileBackupDue() {
  if (enabled() || store.isEmpty()) return false;
  const st = status();
  const since = st.file_at || st.first_seen || setStatus({ first_seen: new Date().toISOString() }).first_seen;
  return ago(since) > REMIND_DAYS * 86400e3 && store.sessionsSince(since) > 0;
}
export const markFileBackup = () => setStatus({ file_at: new Date().toISOString() });
export const snoozeFileBackup = () => setStatus({ file_at: new Date(Date.now() - (REMIND_DAYS - 2) * 86400e3).toISOString() });
