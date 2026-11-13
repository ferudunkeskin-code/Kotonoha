// İngilizce dil paketi.
import { mouthSequence, splitSentences } from "./latin.js";

const CEFR = [["A1", "başlangıç"], ["A2", "temel"], ["B1", "orta"], ["B2", "orta-üstü"], ["C1", "ileri"], ["C2", "çok ileri"]];

export default {
  code: "en",
  locale: "en-US",
  nameTr: "İngilizce",
  native: "English",
  appName: "Kotonoha · English",
  defaultCharacter: "Emma",
  furigana: false,
  levelSystem: "CEFR (Avrupa Dil Çerçevesi)",
  levels: CEFR,
  q: ["“", "”"],
  paren: [" (", ")"],

  voicePrefs: [/samantha/i, /daniel/i, /karen/i, /moira/i],
  voiceAutoLabel: "Otomatik (Samantha → Daniel)",
  mouthSequence,
  secPerUnit: 0.19,
  speakName: name => name,

  sleepWords: ["good night", "goodnight"],
  wakeWords: name => [name],
  wakeHint: name => `“Hey ${name}”`,
  sleepHint: "“Good night”",
  sayGoodnight: "Good night! See you later!",
  sayWelcome: "Yes! I'm back.",

  greet: learner => `Hello${learner ? ", " + learner : ""}!`,
  testPhrase: name => `Hi! I'm ${name}. Nice to meet you.`,
  titles: { free: "Free talk", text: "Text practice" },
  textPlaceholder: "Paste your text here",
  aboutPlaceholder: "Ör. İş toplantılarında daha rahat konuşmak istiyorum.",
  splitSentences,

  startToken: "(Please begin.)",
  prompt: {
    categories: "zaman (tense) | artikel | edat | fiil çekimi | kelime sırası | kelime seçimi | yazım | doğallık | diğer",
    reading: "kısa telaffuz ipucu (Türkçe harflerle yaklaşık okunuş); gerekmezse boş bırak",
    wordHint: "",
    personaExtra: "",
    contentQ: "Who? What? Why?",
    opinionQ: "What do you think about…?",
    formal: "kibar ve açık bir dil kullan",
    examStart: "“Alright, let's begin.”",
    readPraise: "“Great reading!” ya da “Let's read the part with … once more.”",
    readDetail: "doğru telaffuzu (gerekirse Türkçe harflerle yaklaşık okunuşu)",
    sttQuirks: "büyük-küçük harfi ya da noktalamayı farklı yazabilir",
    sttErrors: "büyük-küçük harf, eksik noktalama, eş sesli kelime karışıklığı (their/there gibi)",
  },
};
