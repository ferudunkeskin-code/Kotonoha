"""Mikrofonla konuşma: kayıt (sounddevice) + yerel yazıya çevirme (faster-whisper).

Ses bilgisayardan dışarı çıkmaz. Whisper modeli ilk kullanımda bir kez
internetten indirilir (small ≈ 470 MB), sonra bilgisayarda kalır.
Gerekli paketler:  pip install faster-whisper sounddevice
"""
import threading

SAMPLE_RATE = 16000          # Whisper 16 kHz mono ister
MAX_SECONDS = 60             # tek kayıt için üst sınır

_missing = None
_models = {}
_model_lock = threading.Lock()


def available() -> bool:
    """Gerekli paketler kurulu mu? Değilse missing() eksik olanı söyler."""
    global _missing
    if _missing is None:
        absent = []
        for mod in ("numpy", "sounddevice", "faster_whisper"):
            try:
                __import__(mod)
            except Exception:
                absent.append(mod.replace("_", "-"))
        _missing = absent
    return not _missing


def missing() -> list:
    available()
    return list(_missing)


class Recorder:
    """Mikrofonu açar, gelen sesi biriktirir; stop() ile numpy dizisi döner."""

    def __init__(self):
        import numpy as np
        import sounddevice as sd
        self._np = np
        self._chunks = []
        self._stream = sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype="float32",
                                      callback=self._callback)

    def _callback(self, indata, frames, time_info, status):
        self._chunks.append(indata[:, 0].copy())

    def start(self):
        self._stream.start()

    def stop(self):
        try:
            self._stream.stop()
            self._stream.close()
        except Exception:
            pass
        if not self._chunks:
            return self._np.zeros(0, dtype="float32")
        return self._np.concatenate(self._chunks)

    @staticmethod
    def seconds(audio) -> float:
        return len(audio) / SAMPLE_RATE


def _load_model(size: str, device: str):
    from faster_whisper import WhisperModel
    key = (size, device)
    with _model_lock:
        if key not in _models:
            try:
                _models[key] = WhisperModel(size, device=device,
                                            compute_type="float16" if device == "cuda" else "int8")
            except Exception:
                if device == "cpu":
                    raise
                # Ekran kartı (CUDA) kurulu değilse işlemciye düş
                key = (size, "cpu")
                if key not in _models:
                    _models[key] = WhisperModel(size, device="cpu", compute_type="int8")
        return _models[key]


def transcribe(audio, size: str = "small", device: str = "cpu", language: str = "ja") -> str:
    """Kaydı yazıya çevirir (varsayılan: Japonca)."""
    if len(audio) < SAMPLE_RATE * 0.3:
        return ""
    model = _load_model(size, device)
    segments, _info = model.transcribe(audio, language=language, beam_size=5,
                                       vad_filter=True)
    return "".join(s.text for s in segments).strip()
