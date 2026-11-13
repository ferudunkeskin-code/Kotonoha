// Japonca dil paketi (Kotonoha'nın ilk ve asıl dili).
import { readingOf, kataToHira } from "../furigana.js";

const speakName = name => (!name || name === "Kotonoha") ? "コトノハ" : name;

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
    if (/[a-z]/i.test(c)) { if (/[aeiou]/i.test(c)) seq.push({ m: c.toLowerCase(), w: 1 }); continue; }
  }
  while (seq.length && seq[seq.length - 1].m === "closed") seq.pop();
  return seq;
}

export default {
  code: "ja",
  locale: "ja-JP",
  nameTr: "Japonca",
  native: "日本語",
  appName: "Kotonoha",
  defaultCharacter: "Kotonoha",
  furigana: true,
  levelSystem: "JLPT",
  levels: [["N5", "başlangıç"], ["N4", "temel"], ["N3", "orta"], ["N2", "orta-üstü"], ["N1", "ileri"]],
  q: ["「", "」"],
  paren: ["（", "）"],

  // ses
  voicePrefs: [/kyoko/i, /o-?ren/i],
  voiceAutoLabel: "Otomatik (Kyoko → O-ren)",
  mouthSequence: moraSequence,
  secPerUnit: 0.135,               // iPad Kyoko ~ hız 1.0'da bir hece; ölçtükçe kendini düzeltir
  speakName,

  // konuşma modu
  sleepWords: ["おやすみ", "お休み", "オヤスミ"],
  wakeWords: name => ["ことのは", "コトノハ", "言の葉", "言葉", "kotonoha", name, speakName(name)],
  wakeHint: name => `「ねえ、${speakName(name)}」`,
  sleepHint: "「おやすみ」",
  sayGoodnight: "おやすみなさい。またね！",
  sayWelcome: "はい！おかえりなさい。",

  // ekran metinleri
  greet: learner => `こんにちは${learner ? "、" + learner + "さん" : ""}！`,
  testPhrase: name => `こんにちは。わたしは${speakName(name)}です。よろしくお願いします。`,
  titles: { free: "自由会話", text: "テキスト練習" },
  textPlaceholder: "ここにテキストを貼り付けてください",
  aboutPlaceholder: "Ör. Japon Dili ve Edebiyatı öğrencisiyim; yazın Japonya'ya gideceğim.",
  splitSentences: text => String(text || "").split(/(?<=[。！？!?])|\n+/).map(s => s.trim()).filter(Boolean),

  // yapay zekâ talimatlarındaki dile özgü parçalar
  startToken: "（始めてください）",
  prompt: {
    categories: "partikül | fiil çekimi | keigo | kelime seçimi | yazım | söz dizimi | doğallık | diğer",
    reading: "hiragana okunuşu",
    wordHint: "",
    personaExtra: "- Öğrencinin adını Japonca metinde katakana ile yaz (ör. ドゥイグ).",
    contentQ: "誰が・何を・どうして…",
    opinionQ: "あなたはどう思いますか…",
    formal: "です・ます kullan",
    examStart: "「では、始めましょう。」",
    readPraise: "「とても上手です！」 ya da 「〇〇のところをもう一度読んでみましょう」",
    readDetail: "doğru okunuşu (hiragana)",
    sttQuirks: "kanjiyi farklı yazabilir, noktalamayı atlayabilir",
    sttErrors: "yanlış kanji, eksik noktalama, eş sesli kelime karışıklığı",
  },
};
