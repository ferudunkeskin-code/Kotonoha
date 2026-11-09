"""Seslendirme ve dudak senkronu.

VOICEVOX açıksa: ses üretilir, çalınır ve ağız her hecenin sesli harfine göre değişir.
VOICEVOX kapalıysa: ses olmadan, metin uzunluğuna göre basit bir ağız animasyonu yapılır.
"""
from PyQt6.QtCore import QObject, QTimer, QElapsedTimer, QUrl, pyqtSignal
from PyQt6.QtMultimedia import QMediaPlayer, QAudioOutput

from ..voice.voicevox import mouth_at
from ..paths import DATA_DIR

_KANA_VOWEL = {}
for vowel, chars in {
    "a": "あかさたなはまやらわがざだばぱぁゃアカサタナハマヤラワガザダバパァャ",
    "i": "いきしちにひみりぎじぢびぴぃイキシチニヒミリギジヂビピィ",
    "u": "うくすつぬふむゆるぐずづぶぷぅゅウクスツヌフムユルグズヅブプゥュ",
    "e": "えけせてねへめれげぜでべぺぇエケセテネヘメレゲゼデベペェ",
    "o": "おこそとのほもよろをごぞどぼぽぉょオコソトノホモヨロヲゴゾドボポォョ",
}.items():
    for ch in chars:
        _KANA_VOWEL[ch] = vowel


def fake_timeline(text, step=0.11):
    """Ses yokken: metindeki kanaya göre kabaca bir ağız zaman çizelgesi."""
    out, t = [], 0.0
    cycle = "aoeiu"
    for i, ch in enumerate(text[:120]):
        if ch in "、。！？!?…　 \n":
            out.append((t, t + 0.18, "closed"))
            t += 0.18
            continue
        mouth = _KANA_VOWEL.get(ch, cycle[i % 5])
        out.append((t, t + step, mouth))
        t += step
    return out


class Speaker(QObject):
    finished = pyqtSignal()
    error = pyqtSignal(str)

    def __init__(self, avatar, jobs, parent=None):
        super().__init__(parent)
        self.avatar = avatar
        self.jobs = jobs
        self.voicevox = None
        self.enabled = True
        self.player = QMediaPlayer(self)
        self.audio = QAudioOutput(self)
        self.player.setAudioOutput(self.audio)
        self.player.mediaStatusChanged.connect(self._on_status)
        self.player.playbackStateChanged.connect(self._on_state)
        self.clock = QElapsedTimer()
        self.timeline = []
        self.timer = QTimer(self, interval=30)
        self.timer.timeout.connect(self._tick)
        self.queue = []
        self._file_toggle = 0
        self._token = 0
        self._fake = False

    def configure(self, voicevox_client, enabled):
        self.voicevox = voicevox_client
        self.enabled = enabled

    # ---------- dışarıya açık ----------
    def say(self, text, speaker_id):
        self.stop()
        self.queue = [(text, speaker_id)]
        self._next()

    def say_many(self, items):
        self.stop()
        self.queue = list(items)
        self._next()

    def stop(self):
        self._token += 1          # bekleyen sentez sonuçlarını geçersiz kıl
        self.queue = []
        self.timer.stop()
        self._fake = False
        if self.player.playbackState() != QMediaPlayer.PlaybackState.StoppedState:
            self.player.stop()
        self.avatar.set_mouth("closed")

    # ---------- iç işleyiş ----------
    def _next(self):
        if not self.queue:
            self.avatar.set_mouth("closed")
            self.finished.emit()
            return
        text, speaker_id = self.queue.pop(0)
        token = self._token
        if self.enabled and self.voicevox is not None and speaker_id is not None:
            self.jobs.run(self.voicevox.synthesize, text, int(speaker_id),
                          on_done=lambda res, tk=token: self._play(res, tk),
                          on_fail=lambda err, tk=token, tx=text: self._fallback(err, tx, tk))
        else:
            self._play_fake(text)

    def _fallback(self, err, text, token):
        if token != self._token:
            return
        self.error.emit(f"VOICEVOX'a ulaşılamadı ({err}). Sessiz animasyon kullanılıyor.")
        self._play_fake(text)

    def _play(self, result, token):
        if token != self._token:
            return
        wav, timeline = result
        self._file_toggle ^= 1
        path = DATA_DIR / f"_speech_{self._file_toggle}.wav"
        try:
            self.player.setSource(QUrl())
            path.write_bytes(wav)
        except OSError as e:
            self.error.emit(f"Ses dosyası yazılamadı: {e}")
            self._play_fake("")
            return
        self.timeline = timeline
        self._fake = False
        self.player.setSource(QUrl.fromLocalFile(str(path)))
        self.player.play()

    def _play_fake(self, text):
        self.timeline = fake_timeline(text)
        self._fake = True
        self.clock.start()
        self.timer.start()

    def _on_state(self, state):
        if state == QMediaPlayer.PlaybackState.PlayingState and not self._fake:
            self.clock.start()
            self.timer.start()

    def _on_status(self, status):
        if status == QMediaPlayer.MediaStatus.EndOfMedia and not self._fake:
            self.timer.stop()
            self.avatar.set_mouth("closed")
            QTimer.singleShot(250, self._next)
        elif status == QMediaPlayer.MediaStatus.InvalidMedia:
            self.error.emit("Ses çalınamadı.")
            self.timer.stop()
            self.avatar.set_mouth("closed")

    def _tick(self):
        t = self.clock.elapsed() / 1000.0
        self.avatar.set_mouth(mouth_at(self.timeline, t))
        if self._fake and (not self.timeline or t > self.timeline[-1][1]):
            self.timer.stop()
            self._fake = False
            self.avatar.set_mouth("closed")
            QTimer.singleShot(250, self._next)
