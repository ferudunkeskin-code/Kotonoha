// Almanca dil paketi.
import { mouthSequence, splitSentences } from "./latin.js";

const CEFR = [["A1", "başlangıç"], ["A2", "temel"], ["B1", "orta"], ["B2", "orta-üstü"], ["C1", "ileri"], ["C2", "çok ileri"]];

export default {
  code: "de",
  locale: "de-DE",
  nameTr: "Almanca",
  native: "Deutsch",
  appName: "Kotonoha · Deutsch",
  defaultCharacter: "Lena",
  furigana: false,
  levelSystem: "CEFR (Avrupa Dil Çerçevesi)",
  levels: CEFR,
  q: ["„", "“"],
  paren: [" (", ")"],

  voicePrefs: [/anna/i, /petra/i, /helena/i, /markus/i],
  voiceAutoLabel: "Otomatik (Anna → Petra)",
  mouthSequence,
  secPerUnit: 0.2,
  speakName: name => name,

  sleepWords: ["gute nacht", "gutenacht", "schlaf gut"],
  wakeWords: name => [name],
  wakeHint: name => `„Hallo ${name}“`,
  sleepHint: "„Gute Nacht“",
  sayGoodnight: "Gute Nacht! Bis später!",
  sayWelcome: "Ja, ich bin wieder da!",

  greet: learner => `Hallo${learner ? ", " + learner : ""}!`,
  testPhrase: name => `Hallo! Ich bin ${name}. Schön, dich kennenzulernen.`,
  titles: { free: "Freies Gespräch", text: "Mit Texten üben" },
  textPlaceholder: "Füge deinen Text hier ein",
  aboutPlaceholder: "Ör. Almanya'da yüksek lisans yapmak istiyorum; B1 sınavına hazırlanıyorum.",
  splitSentences,

  startToken: "(Bitte fang an.)",
  prompt: {
    categories: "artikel | hâl (Kasus) | fiil çekimi | kelime sırası | edat | kelime seçimi | yazım | doğallık | diğer",
    reading: "isimse artikel ve çoğul (ör. der Bahnhof, ¨-e); değilse boş bırak",
    wordHint: "İsimleri \"word\" alanında artikeliyle yaz (ör. \"der Bahnhof\").",
    personaExtra: "- Öğrenciye \"du\" diye hitap et (sınav provası hariç). Almanca isimlerin artikelini öğretmeye özen göster.",
    contentQ: "Wer? Was? Warum?",
    opinionQ: "Was denken Sie darüber?",
    formal: "\"Sie\" hitabını kullan",
    examStart: "„Gut, fangen wir an.“",
    readPraise: "„Sehr gut gelesen!“ ya da „Lies den Satz mit … bitte noch einmal.“",
    readDetail: "doğru telaffuzu (gerekirse Türkçe harflerle yaklaşık okunuşu)",
    sttQuirks: "büyük-küçük harfi ya da noktalamayı farklı yazabilir",
    sttErrors: "büyük-küçük harf, eksik noktalama, eş sesli kelime karışıklığı",
  },
};
