// Hangi dilde çalıştığımızı sayfanın kendisi söyler: <html data-lang="ja|de|en">.
// Japonca: site kökü (/Kotonoha/), Almanca: /Kotonoha/de/, İngilizce: /Kotonoha/en/.
// Her dilin ayrı simgesi, ayrı hafızası var; kodun tamamı ortak.
import ja from "./ja.js";
import de from "./de.js";
import en from "./en.js";

export const PACKS = { ja, de, en };

function detect() {
  if (globalThis.KOTONOHA_LANG) return globalThis.KOTONOHA_LANG;      // testler için
  if (typeof document !== "undefined") return document.documentElement?.dataset?.lang || "ja";
  return "ja";
}

export const pack = PACKS[detect()] || ja;
