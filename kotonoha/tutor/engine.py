"""Ders motoru: yapay zekâ, hafıza ve müfredatı birbirine bağlar.

Arayüzden bağımsızdır; PyQt olmadan da test edilebilir.
"""
import json

from ..llm import extract_json, LLMError
from . import prompts


class Tutor:
    def __init__(self, provider, db, curriculum, character_name="Kotonoha",
                 persona="Sakin, meraklı, biraz esprili; çizime ve edebiyata ilgi duyar.",
                 learner_name="öğrenci"):
        self.provider = provider
        self.db = db
        self.cur = curriculum
        self.character_name = character_name
        self.persona = persona
        self.learner_name = learner_name

    # ---------------- hafıza bağlamı ----------------
    def learner_context(self) -> str:
        lines = []
        level = self.db.get("level_estimate")
        lines.append(f"- Tahmini seviye: {level or 'henüz bilinmiyor'}")
        for f in self.db.facts(12):
            lines.append(f"- {f}")
        ms = self.db.mistake_stats(5)
        if ms:
            lines.append("- Sık yaptığı hatalar:")
            for m in ms:
                lines.append(f"  * {m['category']} ({m['count']} kez), örn. "
                             f"「{m['original']}」→「{m['corrected']}」")
        sums = self.db.recent_summaries(3)
        if sums:
            lines.append("- Son oturumlar:")
            lines += [f"  * {s}" for s in sums]
        done = self.db.completed_units()
        if done:
            lines.append(f"- Tamamlanan üniteler: {', '.join(sorted(done))}")
        return "\n".join(lines)

    def _persona(self) -> str:
        return prompts.PERSONA.format(name=self.character_name, learner=self.learner_name,
                                      persona=self.persona,
                                      learner_context=self.learner_context())

    # ---------------- konuşma ----------------
    def converse(self, session_id, user_text, mode="free", unit_id=None, step=None,
                 unit_content=None) -> dict:
        """Öğrencinin mesajını işler, avatarın cevabını döndürür ve hafızaya yazar."""
        system = self._persona() + "\n" + self._mode_prompt(mode, unit_id, step, unit_content) \
            + prompts.REPLY_FORMAT
        if user_text:
            self.db.add_message(session_id, "user", user_text)
        history = self.db.history(session_id, limit=24)
        raw = self.provider.chat(system, history, max_tokens=1200, temperature=0.7)
        data = parse_reply(raw)
        self.db.add_message(session_id, "assistant", data["reply_ja"],
                            raw=json.dumps(data, ensure_ascii=False))
        c = data.get("correction")
        if c and c.get("original") and c.get("corrected"):
            self.db.add_mistake(c.get("category"), c["original"], c["corrected"],
                                c.get("explanation_tr", ""))
        for w in data.get("new_words") or []:
            if isinstance(w, dict):
                self.db.add_word(w.get("word"), w.get("reading", ""), w.get("meaning_tr", ""),
                                 source="sohbet")
        return data

    def start_roleplay(self, session_id, unit_id, content) -> dict:
        """Avatarın açılış repliğini oturuma ekler (yapay zekâya gitmeden)."""
        rp = content["roleplay"]
        data = {"reply_ja": rp.get("opening_ja", "こんにちは。"), "reply_tr": "",
                "correction": None, "new_words": [], "goal_reached": False}
        self.db.add_message(session_id, "assistant", data["reply_ja"],
                            raw=json.dumps(data, ensure_ascii=False))
        return data

    def _mode_prompt(self, mode, unit_id, step, content) -> str:
        if mode == "free" or not unit_id:
            return prompts.FREE_TALK
        u = self.cur.unit(unit_id)
        content = content or {}
        if mode == "roleplay":
            rp = content.get("roleplay", {})
            return prompts.ROLEPLAY.format(
                unit_title=f"{u['title_ja']} / {u['title_tr']}", scenario=u["scenario_tr"],
                partner_role=rp.get("partner_role_tr", ""), partner_name=rp.get("partner_name", ""),
                learner_role=rp.get("learner_role_tr", ""), goal=rp.get("goal_tr", ""),
                grammar="、".join(u["grammar"]))
        gp = content.get("grammar", {}).get("point") or "、".join(u["grammar"])
        return prompts.LESSON_QA.format(unit_title=f"{u['title_ja']} / {u['title_tr']}",
                                        step=step or "", grammar_point=gp)

    # ---------------- ünite içeriği ----------------
    def unit_content(self, unit_id, regenerate=False) -> dict:
        if not regenerate:
            cached = self.db.get_unit_content(unit_id)
            if cached:
                return cached
        u = self.cur.unit(unit_id)
        ms = ", ".join(f"{m['category']}" for m in self.db.mistake_stats(3)) or "henüz yok"
        prompt = prompts.UNIT_GEN.format(
            title_ja=u["title_ja"], title_tr=u["title_tr"], jlpt=u["jlpt"],
            scenario=u["scenario_tr"], can_do=u["can_do_tr"], grammar="、".join(u["grammar"]),
            level=self.db.get("level_estimate") or "bilinmiyor (orta-başlangıç varsay)",
            mistakes=ms)
        data = None
        for _ in range(2):  # bozuk JSON gelirse bir kez daha dene
            raw = self.provider.chat("Sen deneyimli bir Japonca öğretmenisin ve ders materyali hazırlıyorsun.",
                                     [{"role": "user", "content": prompt}],
                                     max_tokens=8000, temperature=0.6)
            data = extract_json(raw)
            if validate_unit(data):
                break
            data = None
        if not data:
            raise LLMError("Ünite içeriği üretilemedi (geçersiz cevap). Tekrar deneyin.")
        self.db.save_unit_content(unit_id, data)
        return data

    def add_unit_vocab(self, unit_id, content):
        for w in content.get("vocab", []):
            self.db.add_word(w.get("word"), w.get("reading", ""), w.get("meaning_tr", ""),
                             w.get("example_ja", ""), w.get("example_tr", ""), source=unit_id)

    # ---------------- yazma ----------------
    def check_writing(self, unit_id, content, text) -> dict:
        u = self.cur.unit(unit_id)
        prompt = prompts.WRITING_CHECK.format(task=content["writing"]["task_tr"],
                                              grammar="、".join(u["grammar"]), text=text)
        raw = self.provider.chat("Sen titiz ama cesaret verici bir Japonca öğretmenisin.",
                                 [{"role": "user", "content": prompt}],
                                 max_tokens=2000, temperature=0.3)
        data = extract_json(raw) or {"corrected_ja": "", "comments": [],
                                     "praise_tr": raw, "score": 0.5}
        for c in data.get("comments") or []:
            if isinstance(c, dict) and c.get("original"):
                self.db.add_mistake(c.get("category"), c["original"], c.get("corrected", ""),
                                    c.get("explanation_tr", ""))
        try:
            score = float(data.get("score", 0.5))
        except (TypeError, ValueError):
            score = 0.5
        self.db.mark_step(unit_id, "writing", score)
        return data

    # ---------------- oturum özeti ----------------
    def summarize(self, session_id) -> bool:
        """Oturumu özetler; öğrenci hakkında bilgileri ve seviye tahminini günceller."""
        if self.db.user_message_count(session_id) < 3:
            return False
        prompt = prompts.SUMMARY.format(transcript=self.db.transcript(session_id)[-12000:])
        raw = self.provider.chat("Sen bir dil öğretmeninin not defterisin.",
                                 [{"role": "user", "content": prompt}],
                                 max_tokens=800, temperature=0.2)
        data = extract_json(raw)
        if not data:
            return False
        self.db.save_summary(session_id, data.get("summary_tr", ""))
        for f in data.get("facts") or []:
            self.db.add_fact(f)
        if data.get("level_estimate"):
            self.db.set("level_estimate", data["level_estimate"])
        return True


def parse_reply(raw: str) -> dict:
    """Konuşma cevabını güvenle sözlüğe çevirir; JSON bozuksa düz metni kullanır."""
    data = extract_json(raw)
    if not isinstance(data, dict) or not data.get("reply_ja"):
        data = {"reply_ja": (raw or "").strip() or "……", "reply_tr": ""}
    data.setdefault("reply_tr", "")
    data.setdefault("correction", None)
    data.setdefault("new_words", [])
    data.setdefault("goal_reached", False)
    if not isinstance(data["correction"], dict):
        data["correction"] = None
    if not isinstance(data["new_words"], list):
        data["new_words"] = []
    return data


def validate_unit(d) -> bool:
    try:
        return (isinstance(d, dict) and d["scene"]["lines"] and d["vocab"]
                and d["grammar"]["explanation_tr"] and d["roleplay"]["goal_tr"]
                and d["writing"]["task_tr"] and all(
                    isinstance(q["options"], list) and 0 <= int(q["answer"]) < len(q["options"])
                    for q in d["quiz"]) and len(d["quiz"]) > 0)
    except (KeyError, TypeError, ValueError):
        return False
