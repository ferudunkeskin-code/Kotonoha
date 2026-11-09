"""Kotonoha'nın hafızası: tek bir SQLite dosyası (data/kotonoha.db).

Tutulanlar:
- konuşma oturumları ve mesajlar
- öğrenci hakkında öğrenilen bilgiler (ilgi alanları, seviye tahmini...)
- sık yapılan hatalar (kategori + örnek)
- kelime kartları ve aralıklı tekrar (SRS) durumu
- ünite ilerlemesi ve üretilmiş ünite içerikleri (önbellek)
"""
import json
import sqlite3
import threading
from datetime import datetime, timedelta

SCHEMA = """
CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY, value TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mode TEXT, unit_id TEXT, started TEXT, summary TEXT, summarized INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER, role TEXT, text TEXT, raw TEXT, ts TEXT
);
CREATE TABLE IF NOT EXISTS facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text TEXT UNIQUE, ts TEXT
);
CREATE TABLE IF NOT EXISTS mistakes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT, original TEXT, corrected TEXT, explanation TEXT, ts TEXT
);
CREATE TABLE IF NOT EXISTS vocab (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    word TEXT UNIQUE, reading TEXT, meaning_tr TEXT, example_ja TEXT, example_tr TEXT,
    source TEXT, interval_days REAL DEFAULT 0, ease REAL DEFAULT 2.5,
    reps INTEGER DEFAULT 0, lapses INTEGER DEFAULT 0, due TEXT, created TEXT
);
CREATE TABLE IF NOT EXISTS unit_content (
    unit_id TEXT PRIMARY KEY, content TEXT, created TEXT
);
CREATE TABLE IF NOT EXISTS unit_progress (
    unit_id TEXT, step TEXT, score REAL, ts TEXT,
    PRIMARY KEY (unit_id, step)
);
"""


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


class Database:
    def __init__(self, path):
        self.conn = sqlite3.connect(str(path), check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.lock = threading.RLock()  # arka plan işleri aynı anda yazmasın
        self.conn.executescript(SCHEMA)
        self.conn.commit()

    def _q(self, sql, args=()):
        with self.lock:
            return self.conn.execute(sql, args).fetchall()

    def _x(self, sql, args=()):
        with self.lock:
            cur = self.conn.execute(sql, args)
            self.conn.commit()
            return cur.lastrowid

    # ---------- anahtar/değer (seviye tahmini, ilgi alanları vb.) ----------
    def get(self, key, default=None):
        r = self._q("SELECT value FROM kv WHERE key=?", (key,))
        return json.loads(r[0]["value"]) if r else default

    def set(self, key, value):
        self._x("INSERT OR REPLACE INTO kv(key,value) VALUES(?,?)",
                (key, json.dumps(value, ensure_ascii=False)))

    # ---------- oturumlar ve mesajlar ----------
    def new_session(self, mode, unit_id=None) -> int:
        return self._x("INSERT INTO sessions(mode,unit_id,started) VALUES(?,?,?)",
                       (mode, unit_id, _now()))

    def add_message(self, session_id, role, text, raw=None):
        self._x("INSERT INTO messages(session_id,role,text,raw,ts) VALUES(?,?,?,?,?)",
                (session_id, role, text, raw if raw is not None else text, _now()))

    def history(self, session_id, limit=20) -> list:
        rows = self._q("SELECT role, raw FROM messages WHERE session_id=? "
                       "ORDER BY id DESC LIMIT ?", (session_id, limit))
        return [{"role": r["role"], "content": r["raw"]} for r in reversed(rows)]

    def transcript(self, session_id) -> str:
        rows = self._q("SELECT role, text FROM messages WHERE session_id=? ORDER BY id",
                       (session_id,))
        return "\n".join(f"{'Öğrenci' if r['role'] == 'user' else 'Avatar'}: {r['text']}"
                         for r in rows)

    def user_message_count(self, session_id) -> int:
        return self._q("SELECT COUNT(*) c FROM messages WHERE session_id=? AND role='user'",
                       (session_id,))[0]["c"]

    def save_summary(self, session_id, summary):
        self._x("UPDATE sessions SET summary=?, summarized=1 WHERE id=?", (summary, session_id))

    def recent_summaries(self, n=3) -> list:
        rows = self._q("SELECT started, summary FROM sessions WHERE summarized=1 "
                       "AND summary IS NOT NULL ORDER BY id DESC LIMIT ?", (n,))
        return [f"{r['started'][:10]}: {r['summary']}" for r in rows]

    def session_count(self) -> int:
        return self._q("SELECT COUNT(*) c FROM sessions WHERE summarized=1")[0]["c"]

    # ---------- öğrenci hakkında bilgiler ----------
    def add_fact(self, text):
        text = (text or "").strip()
        if text:
            self._x("INSERT OR IGNORE INTO facts(text,ts) VALUES(?,?)", (text, _now()))

    def facts(self, n=15) -> list:
        return [r["text"] for r in self._q("SELECT text FROM facts ORDER BY id DESC LIMIT ?", (n,))]

    # ---------- hatalar ----------
    def add_mistake(self, category, original, corrected, explanation):
        self._x("INSERT INTO mistakes(category,original,corrected,explanation,ts) "
                "VALUES(?,?,?,?,?)", (category or "diğer", original, corrected, explanation, _now()))

    def mistake_stats(self, n=5) -> list:
        """En sık hata kategorileri ve her birinden son örnek."""
        rows = self._q("SELECT category, COUNT(*) c FROM mistakes GROUP BY category "
                       "ORDER BY c DESC LIMIT ?", (n,))
        out = []
        for r in rows:
            ex = self._q("SELECT original, corrected FROM mistakes WHERE category=? "
                         "ORDER BY id DESC LIMIT 1", (r["category"],))[0]
            out.append({"category": r["category"], "count": r["c"],
                         "original": ex["original"], "corrected": ex["corrected"]})
        return out

    # ---------- kelimeler ve aralıklı tekrar ----------
    def add_word(self, word, reading="", meaning_tr="", example_ja="", example_tr="",
                 source=""):
        word = (word or "").strip()
        if not word:
            return
        self._x("INSERT OR IGNORE INTO vocab(word,reading,meaning_tr,example_ja,example_tr,"
                "source,due,created) VALUES(?,?,?,?,?,?,?,?)",
                (word, reading, meaning_tr, example_ja, example_tr, source, _now(), _now()))

    def due_words(self, limit=20) -> list:
        return [dict(r) for r in self._q(
            "SELECT * FROM vocab WHERE due<=? ORDER BY due LIMIT ?", (_now(), limit))]

    def review_word(self, word_id, remembered: bool):
        r = self._q("SELECT * FROM vocab WHERE id=?", (word_id,))
        if not r:
            return
        w = r[0]
        interval, ease, reps, lapses = w["interval_days"], w["ease"], w["reps"], w["lapses"]
        if remembered:
            interval = 1 if reps == 0 else 3 if reps == 1 else round(interval * ease, 1)
            ease = min(3.0, ease + 0.05)
            reps += 1
            due = datetime.now() + timedelta(days=interval)
        else:
            interval, reps, lapses = 0, 0, lapses + 1
            ease = max(1.3, ease - 0.2)
            due = datetime.now() + timedelta(minutes=10)
        self._x("UPDATE vocab SET interval_days=?, ease=?, reps=?, lapses=?, due=? WHERE id=?",
                (interval, ease, reps, lapses, due.isoformat(timespec="seconds"), word_id))

    def known_words(self, min_interval=7) -> set:
        """Furigananın artık gösterilmeyeceği kadar iyi bilinen kelimeler."""
        return {r["word"] for r in self._q(
            "SELECT word FROM vocab WHERE interval_days>=?", (min_interval,))}

    def vocab_stats(self) -> dict:
        r = self._q("SELECT COUNT(*) total, SUM(interval_days>=7) known, "
                    "SUM(due<=?) due FROM vocab", (_now(),))[0]
        return {"total": r["total"] or 0, "known": r["known"] or 0, "due": r["due"] or 0}

    # ---------- üniteler ----------
    def get_unit_content(self, unit_id):
        r = self._q("SELECT content FROM unit_content WHERE unit_id=?", (unit_id,))
        return json.loads(r[0]["content"]) if r else None

    def save_unit_content(self, unit_id, content: dict):
        self._x("INSERT OR REPLACE INTO unit_content(unit_id,content,created) VALUES(?,?,?)",
                (unit_id, json.dumps(content, ensure_ascii=False), _now()))

    def delete_unit_content(self, unit_id):
        self._x("DELETE FROM unit_content WHERE unit_id=?", (unit_id,))

    def mark_step(self, unit_id, step, score=1.0):
        self._x("INSERT OR REPLACE INTO unit_progress(unit_id,step,score,ts) VALUES(?,?,?,?)",
                (unit_id, step, score, _now()))

    def unit_steps_done(self, unit_id) -> dict:
        return {r["step"]: r["score"] for r in self._q(
            "SELECT step, score FROM unit_progress WHERE unit_id=?", (unit_id,))}

    def completed_units(self) -> dict:
        """Değerlendirme adımını %70 ve üstüyle geçen üniteler -> puan."""
        return {r["unit_id"]: r["score"] for r in self._q(
            "SELECT unit_id, score FROM unit_progress WHERE step='quiz' AND score>=0.7")}
