"""Ayarlar: API anahtarları Windows kayıt defterinde (QSettings) durur,
böylece proje klasörünü zip'leyip paylaşınca anahtarlar içine girmez."""
from PyQt6.QtCore import QSettings
from PyQt6.QtWidgets import (QDialog, QFormLayout, QLineEdit, QComboBox, QCheckBox,
                             QPlainTextEdit, QPushButton, QDialogButtonBox, QHBoxLayout,
                             QWidget, QLabel, QMessageBox, QVBoxLayout, QGroupBox)

from ..llm.claude_provider import DEFAULT_CLAUDE_MODEL
from ..llm.openai_provider import DEFAULT_OPENAI_MODEL
from ..voice.voicevox import VoicevoxClient

DEFAULTS = {
    "provider": "claude",
    "claude_key": "", "claude_model": DEFAULT_CLAUDE_MODEL,
    "openai_key": "", "openai_model": DEFAULT_OPENAI_MODEL,
    "voice_enabled": True, "voicevox_host": "http://127.0.0.1:50021",
    "voice_main": None, "voice_main_name": "", "voice_partner": None, "voice_partner_name": "",
    "furigana_mode": "unknown", "show_tr": False,
    "character_name": "Kotonoha",
    "persona": "Sakin, meraklı ve biraz esprili. Çizime, edebiyata ve oyunlara ilgi duyar. "
               "Hata yapmaktan korkmamayı öğütler.",
    "learner_name": "",
    "stt_model": "small", "stt_device": "cpu",
}


class Settings:
    def __init__(self):
        self.qs = QSettings("Kotonoha", "Kotonoha")

    def get(self, key):
        d = DEFAULTS.get(key)
        if isinstance(d, bool):
            return self.qs.value(key, d, type=bool)
        v = self.qs.value(key, d)
        return d if v is None else v

    def set(self, key, value):
        self.qs.setValue(key, value)

    def api_key(self):
        return self.get("claude_key") if self.get("provider") == "claude" else self.get("openai_key")

    def model(self):
        return self.get("claude_model") if self.get("provider") == "claude" else self.get("openai_model")


class SettingsDialog(QDialog):
    def __init__(self, settings: Settings, parent=None):
        super().__init__(parent)
        self.s = settings
        self.setWindowTitle("Kotonoha · Ayarlar")
        self.setMinimumWidth(560)
        root = QVBoxLayout(self)

        # --- yapay zekâ ---
        g1 = QGroupBox("Yapay zekâ")
        f1 = QFormLayout(g1)
        self.provider = QComboBox()
        self.provider.addItem("Claude (Anthropic)", "claude")
        self.provider.addItem("OpenAI (ChatGPT)", "openai")
        self.provider.setCurrentIndex(0 if self.s.get("provider") == "claude" else 1)
        self.claude_key = QLineEdit(self.s.get("claude_key"))
        self.claude_key.setEchoMode(QLineEdit.EchoMode.Password)
        self.claude_model = QLineEdit(self.s.get("claude_model"))
        self.openai_key = QLineEdit(self.s.get("openai_key"))
        self.openai_key.setEchoMode(QLineEdit.EchoMode.Password)
        self.openai_model = QLineEdit(self.s.get("openai_model"))
        f1.addRow("Kullanılacak:", self.provider)
        f1.addRow("Claude API anahtarı:", self.claude_key)
        f1.addRow("Claude modeli:", self.claude_model)
        f1.addRow("OpenAI API anahtarı:", self.openai_key)
        f1.addRow("OpenAI modeli:", self.openai_model)
        root.addWidget(g1)

        # --- karakter ---
        g2 = QGroupBox("Karakter ve öğrenci")
        f2 = QFormLayout(g2)
        self.char_name = QLineEdit(self.s.get("character_name"))
        self.persona = QPlainTextEdit(self.s.get("persona"))
        self.persona.setFixedHeight(80)
        self.learner = QLineEdit(self.s.get("learner_name"))
        f2.addRow("Avatarın adı:", self.char_name)
        f2.addRow("Karakteri:", self.persona)
        f2.addRow("Öğrencinin adı:", self.learner)
        root.addWidget(g2)

        # --- ses ---
        g3 = QGroupBox("Ses (VOICEVOX)")
        f3 = QFormLayout(g3)
        self.voice_on = QCheckBox("Avatar sesli konuşsun")
        self.voice_on.setChecked(self.s.get("voice_enabled"))
        self.vv_host = QLineEdit(self.s.get("voicevox_host"))
        self.voice_main = QComboBox()
        self.voice_partner = QComboBox()
        for combo, key in ((self.voice_main, "voice_main"), (self.voice_partner, "voice_partner")):
            if self.s.get(key) is not None:
                combo.addItem(self.s.get(key + "_name") or str(self.s.get(key)),
                              (int(self.s.get(key)), self.s.get(key + "_name")))
        load_btn = QPushButton("Sesleri VOICEVOX'tan yükle")
        load_btn.clicked.connect(self.load_voices)
        self.vv_status = QLabel("")
        row = QWidget()
        hl = QHBoxLayout(row)
        hl.setContentsMargins(0, 0, 0, 0)
        hl.addWidget(load_btn)
        hl.addWidget(self.vv_status, 1)
        f3.addRow(self.voice_on)
        f3.addRow("Adres:", self.vv_host)
        f3.addRow(row)
        f3.addRow("Avatarın sesi:", self.voice_main)
        f3.addRow("Sahnedeki 2. kişi:", self.voice_partner)
        f3.addRow(QLabel("<small>VOICEVOX seslerini kullanırken ekranda "
                         "“VOICEVOX:Karakter adı” kredisi gösterilir (kullanım şartı).</small>"))
        root.addWidget(g3)

        # --- mikrofon ---
        g4 = QGroupBox("Mikrofon (Whisper, bilgisayarda çalışır)")
        f4 = QFormLayout(g4)
        self.stt_model = QComboBox()
        for size, label in (("base", "base · hızlı, zayıf (~150 MB)"),
                            ("small", "small · dengeli (~470 MB) — önerilen"),
                            ("medium", "medium · daha iyi, yavaş (~1,5 GB)"),
                            ("large-v3", "large-v3 · en iyi, ekran kartı ister (~3 GB)")):
            self.stt_model.addItem(label, size)
        self.stt_model.setCurrentIndex(max(0, self.stt_model.findData(self.s.get("stt_model"))))
        self.stt_device = QComboBox()
        self.stt_device.addItem("İşlemci (CPU) — her bilgisayarda çalışır", "cpu")
        self.stt_device.addItem("Ekran kartı (NVIDIA CUDA) — hızlı, ek kurulum ister", "cuda")
        self.stt_device.setCurrentIndex(max(0, self.stt_device.findData(self.s.get("stt_device"))))
        f4.addRow("Model:", self.stt_model)
        f4.addRow("Çalışacağı yer:", self.stt_device)
        f4.addRow(QLabel("<small>Model ilk kullanımda bir kez indirilir. Ekran kartı "
                         "çalışmazsa program kendiliğinden işlemciye geçer.</small>"))
        root.addWidget(g4)

        bb = QDialogButtonBox(QDialogButtonBox.StandardButton.Save |
                              QDialogButtonBox.StandardButton.Cancel)
        bb.accepted.connect(self.save)
        bb.rejected.connect(self.reject)
        root.addWidget(bb)

    def load_voices(self):
        client = VoicevoxClient(self.vv_host.text().strip())
        if not client.available():
            self.vv_status.setText("❌ VOICEVOX açık değil")
            return
        try:
            voices = client.speakers()
        except Exception as e:
            self.vv_status.setText(f"❌ {e}")
            return
        for combo in (self.voice_main, self.voice_partner):
            current = combo.currentData()
            combo.clear()
            for sid, label, char in voices:
                combo.addItem(label, (sid, char))
            if current:
                idx = combo.findData(current)
                if idx >= 0:
                    combo.setCurrentIndex(idx)
        self.vv_status.setText(f"✅ {len(voices)} ses bulundu")

    def save(self):
        if not self.claude_key.text().strip() and not self.openai_key.text().strip():
            QMessageBox.warning(self, "Eksik", "En az bir API anahtarı girmelisiniz.")
            return
        s = self.s
        s.set("provider", self.provider.currentData())
        s.set("claude_key", self.claude_key.text().strip())
        s.set("claude_model", self.claude_model.text().strip() or DEFAULT_CLAUDE_MODEL)
        s.set("openai_key", self.openai_key.text().strip())
        s.set("openai_model", self.openai_model.text().strip() or DEFAULT_OPENAI_MODEL)
        s.set("character_name", self.char_name.text().strip() or "Kotonoha")
        s.set("persona", self.persona.toPlainText().strip())
        s.set("learner_name", self.learner.text().strip())
        s.set("voice_enabled", self.voice_on.isChecked())
        s.set("stt_model", self.stt_model.currentData())
        s.set("stt_device", self.stt_device.currentData())
        s.set("voicevox_host", self.vv_host.text().strip())
        for combo, key in ((self.voice_main, "voice_main"), (self.voice_partner, "voice_partner")):
            data = combo.currentData()
            if data:
                s.set(key, int(data[0]))
                s.set(key + "_name", data[1])
        self.accept()
