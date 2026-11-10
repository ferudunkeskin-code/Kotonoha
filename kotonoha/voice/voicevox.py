"""VOICEVOX istemcisi.

VOICEVOX uygulaması açıkken bilgisayarda http://127.0.0.1:50021 adresinde
küçük bir sunucu çalıştırır. Ses üretmeden önce verdiği 'audio_query'
her hecenin (mora) sesli harfini ve süresini içerir; avatarın ağız
şekilleri (あ・い・う・え・お) buna göre tam zamanında değişir.
"""
import requests

VOWELS = {"a", "i", "u", "e", "o"}


class VoicevoxClient:
    def __init__(self, host="http://127.0.0.1:50021", timeout=30):
        self.host = host.rstrip("/")
        self.timeout = timeout

    def available(self) -> bool:
        try:
            return requests.get(f"{self.host}/version", timeout=1.5).ok
        except requests.RequestException:
            return False

    def speakers(self) -> list:
        """[(stil_id, 'Karakter (stil)', 'Karakter')] listesi."""
        r = requests.get(f"{self.host}/speakers", timeout=5)
        r.raise_for_status()
        out = []
        for sp in r.json():
            for st in sp.get("styles", []):
                out.append((st["id"], f"{sp['name']} ({st['name']})", sp["name"]))
        return out

    def warm_up(self, speaker_ids):
        """Sesleri VOICEVOX'ta önceden belleğe yükler; ilk konuşma beklemesin."""
        for sid in speaker_ids:
            try:
                requests.post(f"{self.host}/initialize_speaker",
                              params={"speaker": int(sid), "skip_reinit": "true"},
                              timeout=60)
            except requests.RequestException:
                return

    def synthesize(self, text: str, speaker: int, speed: float = 1.0):
        """(wav_baytları, zaman_çizelgesi) döner.

        zaman_çizelgesi: [(başlangıç_sn, bitiş_sn, ağız)] ; ağız: a/i/u/e/o/n/closed
        """
        q = requests.post(f"{self.host}/audio_query",
                          params={"text": text, "speaker": speaker}, timeout=self.timeout)
        q.raise_for_status()
        query = q.json()
        query["speedScale"] = speed
        s = requests.post(f"{self.host}/synthesis", params={"speaker": speaker},
                          json=query, timeout=self.timeout)
        s.raise_for_status()
        return s.content, mouth_timeline(query)


def _mouth(vowel: str) -> str:
    v = (vowel or "").lower()
    if v in VOWELS:
        return v
    if v == "n":
        return "n"
    return "closed"  # 'cl' (küçük っ), 'pau' (duraklama)


def mouth_timeline(query: dict) -> list:
    """audio_query JSON'undan ağız şekli zaman çizelgesi çıkarır."""
    speed = query.get("speedScale") or 1.0
    t = query.get("prePhonemeLength", 0.1)
    out = []

    def add(dur, mouth):
        nonlocal t
        dur = (dur or 0.0)
        if dur > 0:
            out.append((t / speed, (t + dur) / speed, mouth))
            t += dur

    for ap in query.get("accent_phrases", []):
        for m in ap.get("moras", []):
            add(m.get("consonant_length"), "closed" if m.get("consonant") in ("m", "b", "p") else _mouth(m.get("vowel")))
            add(m.get("vowel_length"), _mouth(m.get("vowel")))
        pm = ap.get("pause_mora")
        if pm:
            add(pm.get("vowel_length"), "closed")
    return out


def mouth_at(timeline: list, seconds: float) -> str:
    for start, end, mouth in timeline:
        if start <= seconds < end:
            return mouth
    return "closed"
