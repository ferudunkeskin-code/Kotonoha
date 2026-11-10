"""Kotonoha ana penceresi: avatar, menü, ders akışı ve sohbet."""
import html

from PyQt6.QtCore import Qt, QTimer
from PyQt6.QtGui import QKeyEvent, QFont, QTextCursor
from PyQt6.QtWidgets import (QMainWindow, QWidget, QHBoxLayout, QVBoxLayout, QPushButton,
                             QPlainTextEdit, QLabel, QTreeWidget, QTreeWidgetItem, QCheckBox,
                             QComboBox, QFrame, QStatusBar, QMessageBox, QApplication)

from ..paths import DB_PATH, AVATAR_DIR
from ..memory.db import Database
from ..curriculum.loader import Curriculum
from ..llm import make_provider, LLMError
from ..tutor.engine import Tutor
from ..voice.voicevox import VoicevoxClient
from ..voice import stt
from ..japanese import furigana
from .render import Renderer, act, esc, para
from .webview import ContentView
from .avatar import AvatarWidget
from .speaker import Speaker
from .settings import Settings, SettingsDialog
from .workers import JobRunner

CHAT_STEPS = {"scene", "vocab", "grammar", "roleplay", "writing"}


class InputBox(QPlainTextEdit):
    """Enter: gönder · Shift+Enter: yeni satır (Japonca IME dönüşümünü bozmaz)."""

    def __init__(self, on_send):
        super().__init__()
        self.on_send = on_send

    def keyPressEvent(self, e: QKeyEvent):
        if e.key() in (Qt.Key.Key_Return, Qt.Key.Key_Enter) and \
                not (e.modifiers() & Qt.KeyboardModifier.ShiftModifier):
            self.on_send()
            return
        super().keyPressEvent(e)


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("Kotonoha 言の葉 · Japonca konuşma partneri")
        self.resize(1320, 820)
        self.settings = Settings()
        self.db = Database(DB_PATH)
        self.cur = Curriculum()
        self.jobs = JobRunner()
        self.tutor = None

        # durum
        self.mode = "home"
        self.unit_id = None
        self.step = None
        self.content = None
        self.session_id = None
        self.session_kind = None
        self.speak_items = []       # [(metin, ses_id)] — 🔊 bağlantıları buraya işaret eder
        self.quiz = None
        self.srs = None
        self.busy = False
        self._gen = 0             # ekran değişince eski cevaplar yok sayılır
        self.recorder = None
        self._rec_timer = None

        self._build_ui()
        self.apply_settings()
        QTimer.singleShot(200, self.show_home)
        QTimer.singleShot(800, self._auto_voice)

    # ================= arayüz =================
    def _build_ui(self):
        central = QWidget()
        self.setCentralWidget(central)
        root = QHBoxLayout(central)
        root.setContentsMargins(8, 8, 8, 8)

        # --- sol sütun ---
        left = QFrame()
        left.setFixedWidth(300)
        lv = QVBoxLayout(left)
        lv.setContentsMargins(0, 0, 0, 0)
        self.avatar = AvatarWidget(AVATAR_DIR)
        self.avatar.setFixedHeight(340)
        lv.addWidget(self.avatar)
        self.lbl_name = QLabel()
        self.lbl_name.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.lbl_name.setFont(QFont("Yu Gothic UI", 13, QFont.Weight.Bold))
        self.lbl_credit = QLabel()
        self.lbl_credit.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.lbl_credit.setStyleSheet("color:#888; font-size:11px")
        lv.addWidget(self.lbl_name)
        lv.addWidget(self.lbl_credit)

        def nav(text, fn):
            b = QPushButton(text)
            b.setMinimumHeight(32)
            b.clicked.connect(fn)
            lv.addWidget(b)
            return b

        nav("🏠  Ana sayfa", self.show_home)
        nav("💬  Serbest sohbet", self.start_free_talk)
        self.btn_srs = nav("🔁  Kelime tekrarı", self.start_srs)
        nav("📈  İlerleme", self.show_progress)
        lv.addWidget(QLabel("<b>Üniteler</b>"))
        self.tree = QTreeWidget()
        self.tree.setHeaderHidden(True)
        self.tree.itemClicked.connect(self._on_tree_click)
        lv.addWidget(self.tree, 1)
        nav("⚙  Ayarlar", self.open_settings)
        root.addWidget(left)

        # --- sağ taraf ---
        right = QVBoxLayout()
        top = QHBoxLayout()
        self.lbl_title = QLabel()
        self.lbl_title.setFont(QFont("Yu Gothic UI", 12, QFont.Weight.Bold))
        top.addWidget(self.lbl_title, 1)
        self.step_bar = QWidget()
        sb = QHBoxLayout(self.step_bar)
        sb.setContentsMargins(0, 0, 0, 0)
        self.step_buttons = {}
        for s in self.cur.steps:
            b = QPushButton(f"{s['ja']} {s['tr']}")
            b.setCheckable(True)
            b.clicked.connect(lambda _, sid=s["id"]: self.open_step(sid))
            sb.addWidget(b)
            self.step_buttons[s["id"]] = b
        top.addWidget(self.step_bar)
        self.chk_tr = QCheckBox("Türkçe çeviri")
        self.chk_tr.toggled.connect(self._on_tr_toggled)
        top.addWidget(self.chk_tr)
        self.cmb_furi = QComboBox()
        self.cmb_furi.addItem("Furigana: bilmediklerimde", "unknown")
        self.cmb_furi.addItem("Furigana: hepsinde", "all")
        self.cmb_furi.addItem("Furigana: kapalı", "none")
        self.cmb_furi.currentIndexChanged.connect(self._on_furi_changed)
        top.addWidget(self.cmb_furi)
        right.addLayout(top)

        self.view = ContentView()
        self.view.action.connect(self.on_action)
        right.addWidget(self.view, 1)

        bottom = QHBoxLayout()
        self.input = InputBox(self.send)
        self.input.setFixedHeight(70)
        self.input.setFont(QFont("Yu Gothic UI", 13))
        self.input.setPlaceholderText("Japonca (ya da Türkçe) yaz… Enter: gönder · Shift+Enter: yeni satır")
        self.btn_send = QPushButton("Gönder")
        self.btn_send.setFixedSize(90, 70)
        self.btn_send.clicked.connect(self.send)
        self.btn_mic = QPushButton("🎤")
        self.btn_mic.setFixedSize(50, 70)
        self.btn_mic.setEnabled(False)
        self.btn_mic.setToolTip("Bas, Japonca konuş, bitince tekrar bas")
        self.btn_mic.clicked.connect(self.toggle_mic)
        bottom.addWidget(self.input, 1)
        bottom.addWidget(self.btn_mic)
        bottom.addWidget(self.btn_send)
        right.addLayout(bottom)
        root.addLayout(right, 1)

        self.status = QStatusBar()
        self.setStatusBar(self.status)
        self.speaker = Speaker(self.avatar, self.jobs, self)
        self.speaker.error.connect(lambda m: self.status.showMessage(m, 6000))

    def apply_settings(self):
        s = self.settings
        self.lbl_name.setText(s.get("character_name"))
        idx = self.cmb_furi.findData(s.get("furigana_mode"))
        self.cmb_furi.blockSignals(True)
        self.cmb_furi.setCurrentIndex(max(0, idx))
        self.cmb_furi.blockSignals(False)
        self.chk_tr.blockSignals(True)
        self.chk_tr.setChecked(s.get("show_tr"))
        self.chk_tr.blockSignals(False)
        self.view.set_translation(s.get("show_tr"))
        vv = VoicevoxClient(s.get("voicevox_host")) if s.get("voice_enabled") else None
        self.speaker.configure(vv, s.get("voice_enabled"))
        self.speaker.warm_up([s.get("voice_main"), s.get("voice_partner")])
        credits = {n for n in (s.get("voice_main_name"), s.get("voice_partner_name")) if n}
        self.lbl_credit.setText(("Ses: " + " / ".join(f"VOICEVOX:{c}" for c in sorted(credits)))
                                if s.get("voice_enabled") and credits else "")
        self.avatar.load(AVATAR_DIR)
        self.tutor = None
        self.refresh_tree()

    def get_tutor(self):
        if self.tutor is None:
            key = self.settings.api_key()
            if not key:
                raise LLMError("API_KEY_MISSING")
            provider = make_provider(self.settings.get("provider"), key, self.settings.model())
            self.tutor = Tutor(provider, self.db, self.cur,
                               character_name=self.settings.get("character_name"),
                               persona=self.settings.get("persona"),
                               learner_name=self.settings.get("learner_name") or "öğrenci")
        return self.tutor

    def renderer(self):
        mode = self.cmb_furi.currentData() or "unknown"
        return Renderer(mode, self.db.known_words() if mode == "unknown" else set())

    def refresh_tree(self):
        done = self.db.completed_units()
        self.tree.clear()
        for lv in self.cur.levels:
            top = QTreeWidgetItem([f"{lv['title_tr']} ({lv['jlpt']})"])
            for u in lv["units"]:
                mark = "✓ " if u["id"] in done else "   "
                it = QTreeWidgetItem([f"{mark}{u['title_ja']} · {u['title_tr']}"])
                it.setData(0, Qt.ItemDataRole.UserRole, u["id"])
                top.addChild(it)
            self.tree.addTopLevelItem(top)
        nxt = self.cur.next_unit(done)
        if nxt:
            for i in range(self.tree.topLevelItemCount()):
                t = self.tree.topLevelItem(i)
                for j in range(t.childCount()):
                    if t.child(j).data(0, Qt.ItemDataRole.UserRole) == nxt:
                        t.setExpanded(True)
        due = self.db.vocab_stats()["due"]
        self.btn_srs.setText(f"🔁  Kelime tekrarı ({due})" if due else "🔁  Kelime tekrarı")

    # ================= yardımcılar =================
    def _guard(self, fn):
        """Bu ekran açıkken başlayan işin sonucu, ekran değişmişse yok sayılır."""
        gen = self._gen
        return lambda *a: fn(*a) if gen == self._gen else None

    def _new_gen(self):
        self._gen += 1
        if self.busy:
            self.set_busy(False)
        self._stop_recording(discard=True)

    def set_mode(self, mode, title):
        self._new_gen()
        self.end_session()
        self.speaker.stop()
        self.mode = mode
        self.lbl_title.setText(title)
        self.step_bar.setVisible(mode == "unit")
        self.speak_items = []
        self.speaker.prefetch([])   # önceki ekranın ön hazırlığını durdur
        self.set_input(mode == "free")

    def set_input(self, enabled, placeholder=None):
        self.input.setEnabled(enabled)
        self.btn_send.setEnabled(enabled)
        if self.recorder is None:
            self.btn_mic.setEnabled(enabled)
        if placeholder:
            self.input.setPlaceholderText(placeholder)

    def set_busy(self, on):
        self.busy = on
        self.avatar.set_thinking(on)
        self.btn_send.setEnabled(not on and self.input.isEnabled())
        if on:
            self.view.append(Renderer.thinking(self.settings.get("character_name")))
        else:
            self.view.remove("thinking")

    def add_speak(self, text, voice="main"):
        sid = self.settings.get("voice_main" if voice == "main" else "voice_partner")
        if sid is None:
            sid = self.settings.get("voice_main")
        self.speak_items.append((text, sid))
        return len(self.speak_items) - 1

    def show_error(self, msg):
        self.set_busy(False)
        if "API_KEY_MISSING" in msg:
            self.view.append(Renderer.error("API anahtarı girilmemiş. ⚙ Ayarlar'dan ekleyin."))
            self.open_settings()
        else:
            self.view.append(Renderer.error(msg))

    def end_session(self):
        """Konuşma oturumu bittiğinde arka planda özet çıkarır (hafıza güncellenir)."""
        sid, self.session_id = self.session_id, None
        if sid and self.db.user_message_count(sid) >= 3:
            try:
                tutor = self.get_tutor()
            except LLMError:
                return
            self.jobs.run(tutor.summarize, sid, on_fail=lambda e: None)

    def new_session(self, kind):
        self.end_session()
        self.session_id = self.db.new_session(kind, self.unit_id)
        self.session_kind = kind

    # ================= ana sayfa =================
    def show_home(self):
        self.set_mode("home", "Ana sayfa")
        name = self.settings.get("character_name")
        learner = self.settings.get("learner_name")
        stats = self.db.vocab_stats()
        nxt = self.cur.next_unit(self.db.completed_units())
        warn = ""
        if not self.settings.api_key():
            warn += Renderer.error("Başlamak için ⚙ Ayarlar'dan bir API anahtarı girin.")
        if not furigana.available():
            warn += Renderer.error("Furigana modülü (fugashi + unidic-lite) bulunamadı; "
                                   "metinler furiganasız gösterilecek. Kurulum: pip install fugashi unidic-lite")
        if self.settings.get("voice_enabled") and self.settings.get("voice_main") is None:
            warn += ('<div class="card">🔈 Avatar şimdilik <b>sessiz</b> konuşuyor. Ses için '
                     'VOICEVOX programını açın, sonra ⚙ Ayarlar → <b>Sesleri VOICEVOX\'tan yükle</b> '
                     've bir ses seçin. (VOICEVOX açıkken Kotonoha\'yı başlatırsanız ses '
                     'kendiliğinden seçilir.)</div>')
        greet = f"こんにちは{('、' + esc(learner) + 'さん') if learner else ''}！"
        level = self.db.get("level_estimate")
        cards = [f'<h1>{greet}</h1><div class="muted">Ben {esc(name)}. Bugün ne çalışalım?</div>', warn]
        if self.db.session_count() == 0:
            cards.append('<div class="card">👋 İlk kez mi buradasın? Önce <b>serbest sohbet</b> '
                         'yapalım; birkaç mesajda seviyeni anlayıp üniteleri ona göre hazırlarım.'
                         f'<br><a class="btn warm" href="{act("free")}">Sohbete başla</a></div>')
        if nxt:
            u = self.cur.unit(nxt)
            cards.append(f'<div class="card"><div class="muted">Sıradaki ünite</div>'
                         f'<h2>{esc(u["title_ja"])} · {esc(u["title_tr"])}</h2>'
                         f'<div>{esc(u["scenario_tr"])}</div>'
                         f'<a class="btn" href="{act("unit/" + nxt)}">Üniteye git</a></div>')
        cards.append(f'<div class="card">🔁 Tekrar bekleyen kelime: <b>{stats["due"]}</b> · '
                     f'Toplam: {stats["total"]} · İyi bilinen: {stats["known"]}'
                     + (f'<br><a class="btn alt" href="{act("srs")}">Tekrar et</a>' if stats["due"] else "")
                     + "</div>")
        if level:
            cards.append(f'<div class="muted">Tahmini seviye: {esc(level)}</div>')
        self.view.set_main("".join(cards))

    # ================= serbest sohbet =================
    def start_free_talk(self):
        self.set_mode("free", "💬 Serbest sohbet")
        self.set_input(True, "Japonca yaz… (Türkçe soru da sorabilirsin)")
        self.new_session("free")
        self.view.set_main(f'<h1>自由会話 · Serbest sohbet</h1><div class="muted">'
                           f'İstediğin konuda yaz. Hatalarını en fazla birer birer düzeltirim; '
                           f'yeni kelimeler tekrar listene eklenir.</div>')
        self.ask_ai("")  # avatar sohbeti açsın

    # ================= mesaj gönderme =================
    def send(self):
        text = self.input.toPlainText().strip()
        if not text or self.busy or not self.input.isEnabled():
            return
        self.input.clear()
        self.view.append(Renderer.user_msg(text))
        if self.mode == "unit" and self.step == "writing":
            self.check_writing(text)
        else:
            self.ask_ai(text)

    def ask_ai(self, text):
        try:
            tutor = self.get_tutor()
        except LLMError as e:
            self.show_error(str(e))
            return
        if self.session_id is None:
            self.new_session(self.mode if self.mode != "unit" else self.step)
        kind = "free"
        if self.mode == "unit":
            kind = "roleplay" if self.step == "roleplay" else "lesson"
        self.set_busy(True)
        self.jobs.run(tutor.converse, self.session_id, text, mode=kind, unit_id=self.unit_id,
                      step=self.step, unit_content=self.content,
                      on_done=self._guard(self.on_reply), on_fail=self._guard(self.show_error))

    def on_reply(self, data):
        self.set_busy(False)
        voice = "partner" if (self.mode == "unit" and self.step == "roleplay") else "main"
        idx = self.add_speak(data["reply_ja"], voice)
        self.view.append(self.renderer().ai_msg(data, idx))
        self.speaker.say(*self.speak_items[idx])
        if self.mode == "unit" and self.step == "roleplay" and data.get("goal_reached"):
            self.db.mark_step(self.unit_id, "roleplay", 1.0)
            self.view.append('<div class="card">🎉 Görevi başardın!</div>' + Renderer.next_button())
            self.set_input(False)

    # ================= üniteler =================
    def _on_tree_click(self, item, col):
        uid = item.data(0, Qt.ItemDataRole.UserRole)
        if uid:
            self.open_unit(uid)
        else:
            item.setExpanded(not item.isExpanded())

    def open_unit(self, unit_id, regenerate=False):
        u = self.cur.unit(unit_id)
        self.set_mode("unit", f"📘 {u['title_ja']} · {u['title_tr']}")
        self.unit_id = unit_id
        self.content = None
        self.set_input(False)
        cached = None if regenerate else self.db.get_unit_content(unit_id)
        if cached:
            self._unit_ready(cached)
            return
        try:
            tutor = self.get_tutor()
        except LLMError as e:
            self.show_error(str(e))
            return
        self.view.set_main(f'<h1>{esc(u["title_ja"])}</h1><div class="card">Ünite hazırlanıyor… '
                           f'İlk açılışta 30-60 saniye sürebilir; sonra kaydedilir ve hemen açılır.</div>')
        self.set_busy(True)
        self.jobs.run(tutor.unit_content, unit_id, regenerate,
                      on_done=self._guard(self._unit_ready), on_fail=self._guard(self.show_error))

    def _unit_ready(self, content):
        self.set_busy(False)
        self.content = content
        done = self.db.unit_steps_done(self.unit_id)
        first = next((s for s in self.cur.step_ids() if s not in done), "scene")
        self.open_step(first)

    def open_step(self, step):
        if self.mode != "unit" or not self.content:
            for b in self.step_buttons.values():
                b.setChecked(False)
            return
        self._new_gen()
        self.end_session()
        self.speaker.stop()
        self.step = step
        for sid, b in self.step_buttons.items():
            b.setChecked(sid == step)
        self.speak_items = []
        r = self.renderer()
        u = self.cur.unit(self.unit_id)
        steps = [(s["id"], s["tr"]) for s in self.cur.steps]
        header = r.unit_header(u, steps, self.db.unit_steps_done(self.unit_id), step)
        c = self.content
        regen = (f'<div class="muted" style="margin-top:24px">İçerik beğenilmediyse: '
                 f'<a href="{act("regen")}">üniteyi yeniden üret</a></div>')

        if step == "scene":
            names = [ch["id"] for ch in c["scene"].get("characters", [])]
            start = len(self.speak_items)
            for ln in c["scene"]["lines"]:
                voice = "partner" if names and ln.get("speaker") != names[0] else "main"
                self.add_speak(ln.get("ja", ""), voice)
            body = r.scene(c, start) + Renderer.next_button()
            self.set_input(True, "Sahneyle ilgili sorunu yaz…")
        elif step == "vocab":
            start = len(self.speak_items)
            for w in c["vocab"]:
                self.add_speak(w.get("word", ""))
            body = r.vocab(c, start) + Renderer.next_button("Tekrar listeme ekle ve devam et →")
            self.set_input(True, "Kelimelerle ilgili sorunu yaz…")
        elif step == "grammar":
            start = len(self.speak_items)
            for e in c["grammar"].get("examples", []):
                self.add_speak(e.get("ja", ""))
            body = r.grammar(c, start) + Renderer.next_button()
            self.set_input(True, "Soru sor ya da kendi örnek cümleni dene…")
        elif step == "roleplay":
            body = r.roleplay_intro(c)
            self.set_input(True, "Rolündeki cevabını Japonca yaz…")
        elif step == "writing":
            body = r.writing_intro(c)
            self.set_input(True, "Metnini Japonca yaz ve gönder…")
        else:  # quiz
            self.quiz = {"i": 0, "correct": 0, "chosen": None}
            body = r.quiz_question(c["quiz"][0], 0, len(c["quiz"]))
            self.set_input(False, "Değerlendirmede seçeneklere tıkla.")
        self.view.set_main(header + body + regen)
        self.speaker.prefetch(self.speak_items)   # tıklayınca anında çalsın

        if step == "roleplay":
            self.new_session("roleplay")
            data = self.get_tutor().start_roleplay(self.session_id, self.unit_id, c) \
                if self.settings.api_key() else None
            if data:
                idx = self.add_speak(data["reply_ja"], "partner")
                self.view.append(r.ai_msg(data, idx))
                self.speaker.say(*self.speak_items[idx])

    def next_step(self):
        ids = self.cur.step_ids()
        if self.step in ("scene", "grammar"):
            self.db.mark_step(self.unit_id, self.step, 1.0)
        elif self.step == "vocab":
            self.get_tutor().add_unit_vocab(self.unit_id, self.content)
            self.db.mark_step(self.unit_id, "vocab", 1.0)
            self.refresh_tree()
        elif self.step == "roleplay" and self.step not in self.db.unit_steps_done(self.unit_id):
            self.db.mark_step(self.unit_id, "roleplay", 0.5)
        i = ids.index(self.step)
        if i + 1 < len(ids):
            self.open_step(ids[i + 1])
        else:
            self.show_home()

    # ---------- yazma ----------
    def check_writing(self, text):
        try:
            tutor = self.get_tutor()
        except LLMError as e:
            self.show_error(str(e))
            return
        self.set_busy(True)
        self.jobs.run(tutor.check_writing, self.unit_id, self.content, text,
                      on_done=self._guard(self._writing_done), on_fail=self._guard(self.show_error))

    def _writing_done(self, fb):
        self.set_busy(False)
        self.view.append(self.renderer().writing_feedback(fb) + Renderer.next_button())

    # ---------- değerlendirme ----------
    def quiz_answer(self, qi, oi):
        q = self.content["quiz"][qi]
        if self.quiz["chosen"] is not None or qi != self.quiz["i"]:
            return
        self.quiz["chosen"] = oi
        if oi == int(q["answer"]):
            self.quiz["correct"] += 1
        self._render_quiz()

    def quiz_next(self):
        self.quiz["i"] += 1
        self.quiz["chosen"] = None
        total = len(self.content["quiz"])
        if self.quiz["i"] >= total:
            score = self.quiz["correct"] / total
            self.db.mark_step(self.unit_id, "quiz", score)
            self.refresh_tree()
            passed = score >= 0.7
            msg = ("🎉 Üniteyi tamamladın!" if passed else
                   "Biraz daha çalışalım; %70 ve üstüyle ünite tamamlanır.")
            self.view.set_main(f'<h1>確認 · Sonuç</h1><div class="card"><div class="big">'
                               f'{self.quiz["correct"]} / {total}</div><p>{msg}</p>'
                               f'<a class="btn" href="{act("step/quiz")}">Tekrar dene</a>'
                               f'<a class="btn warm" href="{act("home")}">Ana sayfa</a></div>')
            return
        self._render_quiz()

    def _render_quiz(self):
        r = self.renderer()
        u = self.cur.unit(self.unit_id)
        steps = [(s["id"], s["tr"]) for s in self.cur.steps]
        header = r.unit_header(u, steps, self.db.unit_steps_done(self.unit_id), "quiz")
        qi = self.quiz["i"]
        self.view.set_main(header + r.quiz_question(self.content["quiz"][qi], qi,
                                                    len(self.content["quiz"]), self.quiz["chosen"]))

    # ================= kelime tekrarı =================
    def start_srs(self):
        self.set_mode("srs", "🔁 Kelime tekrarı")
        self.srs = {"queue": self.db.due_words(30), "shown": False, "ok": 0, "n": 0}
        self._render_srs()

    def _render_srs(self):
        q = self.srs["queue"]
        if not q:
            self.refresh_tree()
            self.view.set_main(f'<h1>おつかれさま！</h1><div class="card">Şimdilik tekrar edilecek kelime '
                               f'kalmadı. Bu turda {self.srs["ok"]}/{self.srs["n"]} bildin.</div>'
                               f'<a class="btn" href="{act("home")}">Ana sayfa</a>')
            return
        w = q[0]
        self.speak_items = [(w["word"], self.settings.get("voice_main"))]
        back = ""
        if self.srs["shown"]:
            ex = (f'<div class="ja" style="font-size:17px">{self.renderer().ja(w["example_ja"])}</div>'
                  f'<div class="muted">{esc(w["example_tr"])}</div>') if w.get("example_ja") else ""
            back = (f'<div style="text-align:center;font-size:20px">{esc(w["reading"])}'
                    f'<a class="icon" href="{act("speak/0")}">🔊</a></div>'
                    f'<div style="text-align:center">{esc(w["meaning_tr"])}</div>{ex}'
                    f'<div style="text-align:center;margin-top:12px">'
                    f'<a class="btn warm" href="{act("srs/fail")}">Bilemedim</a>'
                    f'<a class="btn" href="{act("srs/ok")}">Bildim</a></div>')
        else:
            back = (f'<div style="text-align:center"><a class="btn" href="{act("srs/show")}">'
                    f'Cevabı göster</a></div>')
        self.view.set_main(f'<div class="muted">Kalan: {len(q)} · Okunuşunu ve anlamını '
                           f'aklından söyle, sonra cevabı aç.</div><div class="card">'
                           f'<div class="big">{esc(w["word"])}</div>{back}</div>')

    def srs_grade(self, ok):
        w = self.srs["queue"].pop(0)
        self.db.review_word(w["id"], ok)
        self.srs["n"] += 1
        self.srs["ok"] += int(ok)
        if not ok:
            self.srs["queue"].append(w)  # aynı turda bir daha sor
        self.srs["shown"] = False
        self._render_srs()

    # ================= ilerleme =================
    def show_progress(self):
        self.set_mode("progress", "📈 İlerleme")
        done = self.db.completed_units()
        total = len(self.cur.order)
        pct = int(100 * len(done) / total) if total else 0
        stats = self.db.vocab_stats()
        units = "".join(f'<span class="pill">✓ {esc(self.cur.unit(uid)["title_ja"])} '
                        f'%{int(sc * 100)}</span>' for uid, sc in done.items()) or \
            '<span class="muted">Henüz tamamlanan ünite yok.</span>'
        mist = "".join(f'<tr><td>{esc(m["category"])}</td><td>{m["count"]}</td>'
                       f'<td>「{esc(m["original"])}」→「{esc(m["corrected"])}」</td></tr>'
                       for m in self.db.mistake_stats(8))
        sums = "".join(f"<li>{esc(s)}</li>" for s in self.db.recent_summaries(6))
        facts = "".join(f'<span class="pill">{esc(f)}</span>' for f in self.db.facts(20))
        self.view.set_main(
            f'<h1>İlerleme</h1>'
            f'<div class="card"><b>Tahmini seviye:</b> {esc(self.db.get("level_estimate") or "henüz belli değil")}'
            f'<div style="margin:10px 0 4px">Üniteler: {len(done)} / {total}</div>'
            f'<div class="bar"><i style="width:{pct}%"></i></div><div style="margin-top:8px">{units}</div></div>'
            f'<div class="card"><b>Kelimeler</b><br>Toplam {stats["total"]} · İyi bilinen {stats["known"]} · '
            f'Tekrar bekleyen {stats["due"]}</div>'
            f'<div class="card"><b>Sık yapılan hatalar</b>'
            f'{"<table><tr><th>Tür</th><th>Sayı</th><th>Son örnek</th></tr>" + mist + "</table>" if mist else "<div class=muted>Henüz kayıt yok.</div>"}</div>'
            f'<div class="card"><b>{esc(self.settings.get("character_name"))} seni nasıl tanıyor</b>'
            f'<div>{facts or "<span class=muted>Henüz bir şey öğrenmedi.</span>"}</div></div>'
            f'<div class="card"><b>Son oturumlar</b><ul>{sums or "<li class=muted>Henüz yok</li>"}</ul></div>')

    # ================= bağlantı eylemleri =================
    def on_action(self, a):
        parts = a.split("/")
        try:
            if parts[0] == "speak":
                i = int(parts[1])
                if 0 <= i < len(self.speak_items):
                    self.speaker.say(*self.speak_items[i])
            elif a == "playall":
                if self.step == "scene":
                    n = len(self.content["scene"]["lines"])
                    self.speaker.say_many(self.speak_items[:n])
            elif a == "stop":
                self.speaker.stop()
            elif a == "next":
                self.next_step()
            elif parts[0] == "step":
                self.open_step(parts[1])
            elif parts[0] == "unit":
                self.open_unit(parts[1])
            elif a == "regen":
                if QMessageBox.question(self, "Yeniden üret",
                                        "Bu ünitenin içeriği yeniden üretilsin mi?") == \
                        QMessageBox.StandardButton.Yes:
                    self.open_unit(self.unit_id, regenerate=True)
            elif a == "roleplay/end":
                self.next_step()
            elif parts[0] == "quiz":
                if parts[1] == "next":
                    self.quiz_next()
                else:
                    self.quiz_answer(int(parts[1]), int(parts[2]))
            elif a == "srs":
                self.start_srs()
            elif a == "srs/show":
                self.srs["shown"] = True
                self._render_srs()
            elif a == "srs/ok":
                self.srs_grade(True)
            elif a == "srs/fail":
                self.srs_grade(False)
            elif a == "free":
                self.start_free_talk()
            elif a == "home":
                self.show_home()
        except LLMError as e:
            self.show_error(str(e))
        except Exception as e:
            self.status.showMessage(f"Hata: {e}", 8000)

    # ================= diğer =================
    def _on_tr_toggled(self, on):
        self.settings.set("show_tr", on)
        self.view.set_translation(on)

    def _on_furi_changed(self, _):
        self.settings.set("furigana_mode", self.cmb_furi.currentData())
        self.status.showMessage("Furigana ayarı yeni gösterilen metinlerde geçerli olur.", 4000)
        if self.mode == "unit" and self.step and self.step != "quiz":
            self.open_step(self.step)

    def open_settings(self):
        dlg = SettingsDialog(self.settings, self)
        if dlg.exec():
            self.apply_settings()
            self.status.showMessage("Ayarlar kaydedildi.", 4000)

    # ================= ses: VOICEVOX'u kendiliğinden bağla =================
    def _auto_voice(self):
        """Ses seçilmemişse ve VOICEVOX açıksa, önerilen sesleri kendiliğinden seçer."""
        s = self.settings
        if not s.get("voice_enabled") or s.get("voice_main") is not None:
            return
        client = VoicevoxClient(s.get("voicevox_host"))

        def probe():
            return client.speakers() if client.available() else None
        self.jobs.run(probe, on_done=self._auto_voice_done, on_fail=lambda e: None)

    def _auto_voice_done(self, voices):
        if not voices or self.settings.get("voice_main") is not None:
            return

        def pick(prefs, avoid=None):
            for name in prefs:
                for sid, label, char in voices:
                    if char == name and sid != avoid:
                        return sid, char
            for sid, label, char in voices:
                if sid != avoid:
                    return sid, char
            return voices[0][0], voices[0][2]
        main = pick(["冥鳴ひまり", "四国めたん"])
        partner = pick(["青山龍星", "玄野武宏"], avoid=main[0])
        s = self.settings
        s.set("voice_main", int(main[0]))
        s.set("voice_main_name", main[1])
        s.set("voice_partner", int(partner[0]))
        s.set("voice_partner_name", partner[1])
        self.apply_settings()
        self.status.showMessage(f"VOICEVOX bulundu; sesler seçildi: {main[1]} / {partner[1]}", 8000)
        if self.mode == "home":
            self.show_home()

    # ================= mikrofon =================
    def toggle_mic(self):
        if self.recorder is not None:
            self._stop_recording()
            return
        if not stt.available():
            QMessageBox.information(
                self, "Mikrofon",
                "Mikrofon için iki paket gerekiyor. Programı kapatıp Anaconda Prompt'ta:\n\n"
                "conda activate kotonoha\npip install faster-whisper sounddevice\n\n"
                f"(Eksik: {', '.join(stt.missing())})")
            return
        if self.busy or not self.input.isEnabled():
            return
        self.speaker.stop()
        try:
            self.recorder = stt.Recorder()
            self.recorder.start()
        except Exception as e:
            self.recorder = None
            self.status.showMessage(f"Mikrofon açılamadı: {e}", 8000)
            return
        self.btn_mic.setText("⏹")
        self.btn_mic.setStyleSheet("background:#b5523b;color:white;font-size:18px")
        self.status.showMessage("🎤 Dinliyorum… Bitince ⏹ düğmesine bas.")
        self._rec_timer = QTimer(self, singleShot=True)
        self._rec_timer.timeout.connect(self._stop_recording)
        self._rec_timer.start(stt.MAX_SECONDS * 1000)

    def _stop_recording(self, discard=False):
        if self.recorder is None:
            return
        if self._rec_timer:
            self._rec_timer.stop()
        audio = self.recorder.stop()
        self.recorder = None
        self.btn_mic.setText("🎤")
        self.btn_mic.setStyleSheet("")
        if discard:
            self.status.clearMessage()
            return
        if stt.Recorder.seconds(audio) < 0.4:
            self.btn_mic.setEnabled(self.input.isEnabled())
            self.status.showMessage("Ses alınamadı ya da çok kısa.", 5000)
            return
        self.btn_mic.setEnabled(False)
        self.status.showMessage("✍️ Yazıya çevriliyor… (ilk kullanımda konuşma modeli "
                                "indirilir; birkaç dakika sürebilir)")
        self.jobs.run(stt.transcribe, audio, self.settings.get("stt_model"),
                      self.settings.get("stt_device"),
                      on_done=self._guard(self._mic_text), on_fail=self._guard(self._mic_fail))

    def _mic_text(self, text):
        self.btn_mic.setEnabled(self.input.isEnabled())
        if not text:
            self.status.showMessage("Konuşma anlaşılamadı, tekrar dener misin?", 6000)
            return
        cur = self.input.toPlainText().strip()
        self.input.setPlainText((cur + " " if cur else "") + text)
        self.input.moveCursor(QTextCursor.MoveOperation.End)
        self.input.setFocus()
        self.status.showMessage("Yazıyı kontrol et, düzelt istersen; sonra Enter.", 8000)

    def _mic_fail(self, err):
        self.btn_mic.setEnabled(self.input.isEnabled())
        self.status.showMessage(f"Yazıya çevirme hatası: {err}", 10000)

    def closeEvent(self, e):
        self._stop_recording(discard=True)
        self.speaker.stop()
        sid = self.session_id
        self.session_id = None
        if sid and self.db.user_message_count(sid) >= 3 and self.settings.api_key():
            self.status.showMessage("Oturum hafızaya kaydediliyor…")
            QApplication.processEvents()
            try:
                self.get_tutor().summarize(sid)
            except Exception:
                pass
        self.jobs.wait_all()
        super().closeEvent(e)
