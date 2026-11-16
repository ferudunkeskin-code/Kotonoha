// Müfredat: dilin ünite listesi (units/<dil>.js) ve yardımcılar.
import { pack } from "./lang/index.js";
import ja from "./units/ja.js";
import de from "./units/de.js";
import en from "./units/en.js";

const DATA = { ja, de, en }[pack.code] || ja;

export const steps = DATA.steps;
export const levels = DATA.levels;
export const stepIds = () => steps.map(s => s.id);
export const step = id => steps.find(s => s.id === id);

const UNITS = {};
export const order = [];
for (const lv of levels) for (const u of lv.units) {
  UNITS[u.id] = { ...u, level_id: lv.id, level_title: lv.title_tr, band: lv.band };
  order.push(u.id);
}
export const unit = id => UNITS[id] || null;
export const all = () => order.map(id => UNITS[id]);

// Henüz tamamlanmamış ilk ünite
export const nextUnit = completed => order.find(id => !(id in completed)) || null;
