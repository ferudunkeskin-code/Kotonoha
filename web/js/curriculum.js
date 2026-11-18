// Müfredat: dilin ünite programları (units/<dil>.js) ve yardımcılar.
// Bir dilde birden fazla program olabilir (ör. İngilizce: "Bilim insanı" ve "STEM projeleri").
// Öğrenci programını profilde seçer (ayar: track); ünite kimlikleri programlar arasında benzersizdir,
// bu yüzden program değiştirmek ilerlemeyi silmez.
import { pack } from "./lang/index.js";
import * as store from "./store.js";
import ja from "./units/ja.js";
import de from "./units/de.js";
import en from "./units/en.js";

const DATA = { ja, de, en }[pack.code] || ja;

export const steps = DATA.steps;
export const tracks = DATA.tracks.map(t => ({ id: t.id, title_tr: t.title_tr, desc_tr: t.desc_tr }));
export const stepIds = () => steps.map(s => s.id);
export const step = id => steps.find(s => s.id === id);

const UNITS = {};
const ORDER = {};
for (const t of DATA.tracks) {
  ORDER[t.id] = [];
  for (const lv of t.levels) for (const u of lv.units) {
    UNITS[u.id] = { ...u, level_id: lv.id, level_title: lv.title_tr, band: lv.band, track: t.id };
    ORDER[t.id].push(u.id);
  }
}

// Seçili program (geçersizse ilk program)
export function trackId() {
  const t = store.settings().track;
  return DATA.tracks.some(x => x.id === t) ? t : DATA.tracks[0].id;
}
export const track = () => DATA.tracks.find(t => t.id === trackId());
export function setTrack(id) {
  if (DATA.tracks.some(t => t.id === id)) { store.setSetting("track", id); store.saveNow(); }
}

export const levels = () => track().levels;
export const order = () => ORDER[trackId()];
export const unit = id => UNITS[id] || null;                 // her programdan bulunur
export const all = () => order().map(id => UNITS[id]);

// Seçili programda henüz tamamlanmamış ilk ünite
export const nextUnit = completed => order().find(id => !(id in completed)) || null;
// Seçili programda tamamlananlar
export const completedInTrack = completed => order().filter(id => id in completed).length;
