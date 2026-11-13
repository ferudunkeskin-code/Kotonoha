// Latin alfabeli diller (Almanca, İngilizce) için ortak yardımcılar.
// Ağız hareketi: Japoncadaki gibi kesin hece bilgisi yok; ünlü gruplarını hece sayıp
// her heceye en yakın ağız şeklini veriyoruz (yaklaşık ama doğal görünür).

const VOWEL_MOUTH = { a: "a", "ä": "e", e: "e", i: "i", y: "i", o: "o", "ö": "e", u: "u", "ü": "u" };
const LIPS = new Set(["m", "b", "p"]);   // dudakların kapandığı sessizler
const PAUSE_RE = /[.,;:!?…()"“”„«»\n–—-]/;

// [{m: ağız, w: ağırlık}] — w: hece=1, dudak kapanması=0.35, duraklama=2
export function mouthSequence(text) {
  const s = String(text || "").toLowerCase();
  const seq = [];
  let inVowel = false;
  const chars = [...s];
  chars.forEach((c, i) => {
    if (c in VOWEL_MOUTH) {
      if (!inVowel) seq.push({ m: VOWEL_MOUTH[c], w: 1 });
      inVowel = true;
      return;
    }
    inVowel = false;
    if (LIPS.has(c)) { seq.push({ m: "closed", w: 0.35 }); return; }
    if (PAUSE_RE.test(c)) {
      if (seq.length && seq[seq.length - 1].m !== "closed") seq.push({ m: "closed", w: 2 });
      return;
    }
    // kelime sonundaki n: ağız yarı kapalı
    if (c === "n" && !/[a-zäöüß]/.test(chars[i + 1] || "")) seq.push({ m: "n", w: 0.3 });
  });
  while (seq.length && seq[seq.length - 1].m === "closed") seq.pop();
  return seq;
}

export function splitSentences(text) {
  return String(text || "").split(/(?<=[.!?…])\s+|\n+/).map(x => x.trim()).filter(Boolean);
}
