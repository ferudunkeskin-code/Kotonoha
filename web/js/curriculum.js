// Müfredat: dilin ünite programları.
//  - Yerleşik programlar: units/<dil>.js (ör. İngilizce: "Bilim insanı", "STEM projeleri")
//  - Kullanıcının kendi programları: "Program oluştur" ile yapay zekâya tarif edilip üretilir, hafızada
//    (store.customTracks) saklanır, yedeğe girer; "Devamını oluştur" ile yeni bölümler eklenerek büyür.
// Öğrenci programını seçer (ayar: track). Ünite kimlikleri programlar arasında benzersizdir; program
// değiştirmek ilerlemeyi silmez.
import { pack } from "./lang/index.js";
import * as store from "./store.js";
import ja from "./units/ja.js";
import de from "./units/de.js";
import en from "./units/en.js";

const DATA = { ja, de, en }[pack.code] || ja;

export const steps = DATA.steps;
export const stepIds = () => steps.map(s => s.id);
export const step = id => steps.find(s => s.id === id);

const allTracks = () => [...DATA.tracks.map(t => ({ ...t, custom: false })), ...store.customTracks().map(t => ({ ...t, custom: true }))];
export const tracks = () => allTracks().map(t => ({ id: t.id, title_tr: t.title_tr, desc_tr: t.desc_tr, custom: t.custom }));
export const builtinCount = DATA.tracks.length;

// Seçili program (geçersizse ilk yerleşik program)
export function trackId() {
  const t = store.settings().track;
  return allTracks().some(x => x.id === t) ? t : DATA.tracks[0].id;
}
export const track = () => allTracks().find(t => t.id === trackId());
export const trackById = id => allTracks().find(t => t.id === id) || null;
export function setTrack(id) {
  if (allTracks().some(t => t.id === id)) { store.setSetting("track", id); store.saveNow(); }
}

const decorate = (t, lv, u) => ({ ...u, level_id: lv.id, level_title: lv.title_tr, band: lv.band, track: t.id, custom: !!t.custom });

export const levels = () => track().levels;
export const order = () => track().levels.flatMap(lv => lv.units.map(u => u.id));
export function unit(id) {                                   // her programdan bulunur
  for (const t of allTracks()) for (const lv of t.levels) for (const u of lv.units) if (u.id === id) return decorate(t, lv, u);
  return null;
}
export const all = () => track().levels.flatMap(lv => lv.units.map(u => decorate(track(), lv, u)));

// Seçili programda henüz tamamlanmamış ilk ünite
export const nextUnit = completed => order().find(id => !(id in completed)) || null;
export const completedInTrack = completed => order().filter(id => id in completed).length;

// Kullanıcı programı için benzersiz kimlik (yerleşik L1-01 / S1-01 biçimiyle çakışmaz)
export function newTrackId() {
  const used = new Set(allTracks().map(t => t.id));
  let id;
  do id = "p" + Math.random().toString(36).slice(2, 6); while (used.has(id));
  return id;
}
