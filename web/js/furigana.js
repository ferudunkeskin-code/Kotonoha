// Furigana: kuromoji (tarayıcıda çalışan Japonca sözlük) ile cihazın içinde üretilir.
// Sözlük ilk açılışta bir kez indirilir (~12 MB), sonra önbellekte kalır.

const DIC = "https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/";
const KANJI = "㐀-䶿一-鿿々ヶ豈-﫿";
const KANJI_RE = new RegExp(`[${KANJI}]`);
const RUN_RE = new RegExp(`([${KANJI}]+)|([^${KANJI}]+)`, "g");

let tokenizer = null;
let loading = null;

// kuromoji, sözlük adresini birleştirirken "https://" içindeki çift eğik çizgiyi bozuyor.
// Bu yüzden ona göreli bir adres ("kdict/") veriyoruz ve isteği burada CDN'e yönlendiriyoruz.
if (typeof XMLHttpRequest !== "undefined") {
  const _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    if (typeof url === "string" && url.includes("kdict/")) url = DIC + url.split("kdict/").pop();
    return _open.call(this, method, url, ...rest);
  };
}

export function init() {
  if (loading) return loading;
  loading = new Promise(resolve => {
    if (typeof window === "undefined" || !window.kuromoji) { resolve(null); return; }
    window.kuromoji.builder({ dicPath: "kdict/" }).build((err, t) => {
      if (err) console.warn("furigana sözlüğü yüklenemedi", err);
      tokenizer = err ? null : t;
      resolve(tokenizer);
    });
  });
  return loading;
}

export const ready = () => !!tokenizer;
export const hasKanji = s => KANJI_RE.test(s || "");

export const esc = s => String(s ?? "").replace(/[&<>"']/g,
  c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function kataToHira(s) {
  return [...(s || "")].map(c => (c >= "ァ" && c <= "ヶ") ? String.fromCharCode(c.charCodeAt(0) - 0x60) : c).join("");
}

// [{surface, reading(hiragana), lemma}]
export function tokenize(text) {
  if (!tokenizer) return [{ surface: text, reading: "", lemma: text }];
  return tokenizer.tokenize(text).map(t => ({
    surface: t.surface_form,
    reading: t.reading && t.reading !== "*" ? kataToHira(t.reading) : "",
    lemma: t.basic_form && t.basic_form !== "*" ? t.basic_form : t.surface_form,
  }));
}

const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// 取り扱い / とりあつかい -> [['取','と'],['り',null],['扱','あつか'],['い',null]]
export function align(surface, reading) {
  const runs = [...surface.matchAll(RUN_RE)].map(m => [m[0], m[1] !== undefined]);
  const pattern = "^" + runs.map(([p, k]) => k ? "(.+?)" : "(" + reEsc(kataToHira(p)) + ")").join("") + "$";
  const m = reading.match(new RegExp(pattern));
  if (!m) return [[surface, reading]];
  return runs.map(([p, k], i) => [p, k ? m[i + 1] : null]);
}

function lineToRuby(line, mode, known) {
  if (!hasKanji(line)) return esc(line);
  const out = [];
  for (const { surface, reading, lemma } of tokenize(line)) {
    if (!hasKanji(surface) || !reading || (mode === "unknown" && known.has(lemma))) {
      out.push(esc(surface)); continue;
    }
    for (const [part, rd] of align(surface, reading)) {
      out.push(rd && hasKanji(part) ? `<ruby>${esc(part)}<rt>${esc(rd)}</rt></ruby>` : esc(part));
    }
  }
  return out.join("");
}

export function toRuby(text, mode = "all", known = new Set()) {
  text = String(text ?? "");
  if (mode === "none" || !hasKanji(text) || !tokenizer) return esc(text).replace(/\n/g, "<br>");
  return text.split("\n").map(l => lineToRuby(l, mode, known)).join("<br>");
}

// Dudak senkronu için metnin okunuşu (hiragana); sözlük yoksa metnin kendisi.
export function readingOf(text) {
  if (!tokenizer) return text;
  return tokenize(text).map(t => t.reading || t.surface).join("");
}

// Testler için
export function _setTokenizer(t) { tokenizer = t; }
