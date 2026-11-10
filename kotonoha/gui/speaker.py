"""Seslendirme ve dudak senkronu.

VOICEVOX açıksa: ses üretilir, çalınır ve ağız her hecenin sesli harfine göre değişir.
VOICEVOX kapalıysa: ses olmadan, metin uzunluğuna göre basit bir ağız animasyonu yapılır.

Hız için:
- Üretilen sesler bellekte saklanır (aynı cümle ikinci kez anında çalar).
- Ekrandaki cümleler arka planda önceden üretilebilir (prefetch).
- Program açılırken seçili sesler VOICEVOX'ta ısıtılır (warm_up).
- Çalma için hafif QSoundEffect kullanılır (FFmpeg açılışı beklenmez).
"""
import threading
import time
from collections import OrderedDict

from PyQt6.QtCore import QObject, QTimer, QElapsedTimer, QUrl, pyqtSignal
from PyQt6.QtMultimedia import QSoundEffect

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

CACHE_SIZE = 300


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
        self.effect = QSoundEffect(self)
        self.effect.setVolume(1.0)
        self.effect.playingChanged.connect(self._on_playing)
        self.effect.statusChanged.connect(self._on_status)
        self.clock = QElapsedTimer()
        self.timeline = []
        self.timer = QTimer(self, interval=30)
        self.timer.timeout.connect(self._tick)
        self.queue = []
        self._file_toggle = 0
        self._token = 0
        self._fake = False
        self._started = False
        self._cache = OrderedDict()          # (metin, ses_id) -> (wav, zaman_çizelgesi)
        self._cache_lock = threading.Lock()
        self._prefetch_token = 0

    def configure(self, voicevox_client, enabled):
        self.voicevox = voicevox_client
        self.enabled = enabled

    # ---------- önbellek ----------
    def _cache_get(self, key):
        with self._cache_lock:
            if key in self._cache:
                self._cache.move_to_end(key)
                return self._cache[key]
        return None

    def _cache_put(self, key, value):
        with self._cache_lock:
            self._cache[key] = value
            self._cache.move_to_end(key)
            while len(self._cache) > CACHE_SIZE:
                self._cache.popitem(last=False)

    def _synth(self, text, speaker_id):
        """Arka planda çalışır: önbellekte yoksa VOICEVOX'tan üretir."""
        key = (text, int(speaker_id))
        hit = self._cache_get(key)
        if hit:
            return hit
        t0 = time.perf_counter()
        res = self.voicevox.synthesize(text, int(speaker_id))
        print(f"[ses] {time.perf_counter() - t0:.1f} sn'de üretildi: {text[:20]}")
        self._cache_put(key, res)
        return res

    def _can_speak(self, speaker_id):
        return self.enabled and self.voicevox is not None and speaker_id is not None

    # ---------- dışarıya açık ----------
    def warm_up(self, speaker_ids):
        """Seçili sesleri VOICEVOX'ta önceden yükler (ilk konuşma gecikmesin)."""
        if not self.enabled or self.voicevox is None:
            return
        ids = [int(s) for s in speaker_ids if s is not None]
        if ids:
            self.jobs.run(self.voicevox.warm_up, ids, on_fail=lambda e: None)

    def prefetch(self, items):
        """Ekrandaki cümleleri sırayla arka planda üretir (tıklayınca anında çalsın)."""
        self._prefetch_token += 1
        token = self._prefetch_token
        todo = [(t, s) for t, s in items if t and self._can_speak(s)]
        if not todo:
            return

        def work():
            for text, sid in todo:
                if token != self._prefetch_token:
                    return  # ekran değişti
                try:
                    self._synth(text, sid)
                except Exception:
                    return
        self.jobs.run(work, on_fail=lambda e: None)

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
        self._started = False
        if self.effect.isPlaying():
            self.effect.stop()
        self.avatar.set_mouth("closed")

    # ---------- iç işleyiş ----------
    def _next(self):
        if not self.queue:
            self.avatar.set_mouth("closed")
            self.finished.emit()
            return
        text, speaker_id = self.queue.pop(0)
        token = self._token
        if self._can_speak(speaker_id):
            hit = self._cache_get((text, int(speaker_id)))
            if hit:
                self._play(hit, token)
                return
            self.jobs.run(self._synth, text, int(speaker_id),
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
            path.write_bytes(wav)
        except OSError as e:
            self.error.emit(f"Ses dosyası yazılamadı: {e}")
            self._play_fake("")
            return
        self.timeline = timeline
        self._fake = False
        self._started = False
        self.effect.setSource(QUrl.fromLocalFile(str(path)))
        self.effect.play()        # dosya yüklenince kendiliğinden başlar

    def _play_fake(self, text):
        self.timeline = fake_timeline(text)
        self._fake = True
        self.clock.start()
        self.timer.start()

    def _on_playing(self):
        if self._fake:
            return
        if self.effect.isPlaying():
            self._started = True
            self.clock.start()
            self.timer.start()
        elif self._started:
            self._started = False
            self.timer.stop()
            self.avatar.set_mouth("closed")
            QTimer.singleShot(200, self._next)

    def _on_status(self):
        if self.effect.status() == QSoundEffect.Status.Error and not self._fake:
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
