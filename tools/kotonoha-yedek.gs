/**
 * Kotonoha — Google Drive yedek sunucusu (Google Apps Script web uygulaması)
 *
 * Kurulum (bir kez): script.google.com → Yeni proje → bu kodu yapıştır → Dağıt → Yeni dağıtım →
 *   Tür: Web uygulaması · Yürüten: Ben · Erişimi olan: Herkes → Dağıt → izin ver.
 *   Çıkan /exec adresini web/js/config.js içindeki BACKUP_URL'ye yapıştır.
 * Kodu sonradan değiştirirsen: Dağıt → Dağıtımları yönet → ✏️ → Sürüm: Yeni sürüm (adres değişmez).
 *
 * Yedekler, betiği dağıtan hesabın Drive'ında "Kotonoha Yedekleri" klasörüne yazılır:
 *   Kotonoha Yedekleri / <öğrenci adı> (<kısa iz>) / ja-son.json, ja-2026-11-14.json …
 * Her öğrencinin yedeği, uygulamanın ürettiği gizli "yedek kodu" ile bulunur (KTN-XXXX-XXXX-XXXX).
 * Kodu bilmeyen başkasının yedeğine ulaşamaz. API anahtarları yedeğe hiç girmez.
 */
const ROOT_NAME = "Kotonoha Yedekleri";
const KEEP_DAILY = 10;                  // dil başına saklanan günlük kopya sayısı
const MAX_BYTES = 4 * 1024 * 1024;      // tek yedek için üst sınır
const CODE_RE = /^KTN-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/;
const LANG_RE = /^(ja|de|en)$/;

function doGet() { return out({ ok: true, app: "Kotonoha yedek", version: 1 }); }

function doPost(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); }
  catch (x) { return out({ ok: false, error: "İstek okunamadı." }); }
  try { return out(handle(req)); }
  catch (x) { return out({ ok: false, error: "Sunucu hatası: " + x }); }
}

function out(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function handle(r) {
  if (r.action === "ping") return { ok: true };
  const code = String(r.code || "").toUpperCase();
  const lang = String(r.lang || "");
  if (!CODE_RE.test(code)) return { ok: false, error: "Geçersiz yedek kodu." };
  if (!LANG_RE.test(lang)) return { ok: false, error: "Geçersiz dil." };

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    if (r.action === "save") {
      const data = String(r.data || "");
      if (data.length > MAX_BYTES) return { ok: false, error: "Yedek çok büyük." };
      const obj = JSON.parse(data);
      if (obj.app !== "Kotonoha" || obj.lang !== lang) return { ok: false, error: "Bu bir Kotonoha yedeği değil." };
      const folder = userFolder(code, true, r.name);
      putFile(folder, lang + "-son.json", data);
      const day = Utilities.formatDate(new Date(), "Europe/Istanbul", "yyyy-MM-dd");
      putFile(folder, lang + "-" + day + ".json", data);
      prune(folder, lang);
      return { ok: true, saved: new Date().toISOString() };
    }

    const folder = userFolder(code, false);
    if (!folder) return { ok: false, notFound: true, error: "Bu koda ait yedek bulunamadı." };

    if (r.action === "list") {
      const files = [];
      const it = folder.getFiles();
      while (it.hasNext()) {
        const f = it.next();
        const n = f.getName();
        if (n.indexOf(lang + "-") === 0 && /\.json$/.test(n)) {
          files.push({ name: n, updated: f.getLastUpdated().toISOString(), size: f.getSize() });
        }
      }
      files.sort((a, b) => (a.name.indexOf("-son") > 0 ? -1 : b.name.indexOf("-son") > 0 ? 1 : b.name.localeCompare(a.name)));
      return { ok: true, files: files };
    }

    if (r.action === "load") {
      const name = r.file ? String(r.file) : lang + "-son.json";
      if (!new RegExp("^" + lang + "-(son|\\d{4}-\\d{2}-\\d{2})\\.json$").test(name)) return { ok: false, error: "Geçersiz dosya adı." };
      const it = folder.getFilesByName(name);
      if (!it.hasNext()) return { ok: false, notFound: true, error: "Bu dilde yedek bulunamadı." };
      const f = it.next();
      return { ok: true, data: f.getBlob().getDataAsString("UTF-8"), updated: f.getLastUpdated().toISOString() };
    }
    return { ok: false, error: "Bilinmeyen işlem." };
  } finally {
    lock.releaseLock();
  }
}

function hashOf(code) {
  const d = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, code, Utilities.Charset.UTF_8);
  return d.map(b => ((b + 256) % 256).toString(16).padStart(2, "0")).join("").slice(0, 24);
}

function rootFolder() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty("root");
  if (id) { try { const f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (x) { /* yeniden bul */ } }
  const it = DriveApp.getFoldersByName(ROOT_NAME);
  const f = it.hasNext() ? it.next() : DriveApp.createFolder(ROOT_NAME);
  props.setProperty("root", f.getId());
  return f;
}

function userFolder(code, create, name) {
  const props = PropertiesService.getScriptProperties();
  const h = hashOf(code);
  const id = props.getProperty("u_" + h);
  if (id) { try { const f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (x) { /* yeniden oluştur */ } }
  if (!create) return null;
  const label = String(name || "Öğrenci").replace(/[\\/:*?"<>|]/g, "").slice(0, 30) || "Öğrenci";
  const f = rootFolder().createFolder(label + " (" + h.slice(0, 6) + ")");
  props.setProperty("u_" + h, f.getId());
  return f;
}

function putFile(folder, name, data) {
  const it = folder.getFilesByName(name);
  if (it.hasNext()) it.next().setContent(data);
  else folder.createFile(name, data, "application/json");
}

function prune(folder, lang) {
  const re = new RegExp("^" + lang + "-\\d{4}-\\d{2}-\\d{2}\\.json$");
  const daily = [];
  const it = folder.getFiles();
  while (it.hasNext()) { const f = it.next(); if (re.test(f.getName())) daily.push(f); }
  daily.sort((a, b) => b.getName().localeCompare(a.getName()));
  daily.slice(KEEP_DAILY).forEach(f => f.setTrashed(true));
}
