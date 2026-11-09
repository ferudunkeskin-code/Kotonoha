"""Yerel furigana üretimi (fugashi + unidic-lite).

Yapay zekâya gitmeden, bilgisayarda anında ve ücretsiz çalışır.
Her kelimenin sözlük biçimini (lemma) de verdiği için
"bilinen kelimelerde furigana gösterme" özelliği buna dayanır.
"""
import html
import re

_KANJI = r"㐀-䶿一-鿿々ヶ豈-﫿"
KANJI_RE = re.compile(f"[{_KANJI}]")
_RUN_RE = re.compile(f"([{_KANJI}]+)|([^{_KANJI}]+)")

_tagger = None
_tagger_error = None


def _get_tagger():
    global _tagger, _tagger_error
    if _tagger is None and _tagger_error is None:
        try:
            from fugashi import Tagger
            _tagger = Tagger()
        except Exception as e:  # paket yoksa program yine çalışsın
            _tagger_error = str(e)
    return _tagger


def available() -> bool:
    return _get_tagger() is not None


def kata_to_hira(s: str) -> str:
    return "".join(chr(ord(c) - 0x60) if "ァ" <= c <= "ヶ" else c for c in s)


def has_kanji(s: str) -> bool:
    return bool(KANJI_RE.search(s))


def tokenize(text: str) -> list:
    """[(yüzey, okunuş_hiragana, lemma)] listesi döner."""
    tagger = _get_tagger()
    if tagger is None:
        return [(text, "", text)]
    out = []
    for w in tagger(text):
        f = w.feature
        kana = getattr(f, "kana", None)
        lemma = getattr(f, "lemma", None) or w.surface
        if not kana or kana == "*":
            kana = ""
        lemma = str(lemma).split("-")[0]  # "ジュース-juice" -> "ジュース"
        out.append((w.surface, kata_to_hira(kana), lemma))
        if w.white_space:
            out.append((w.white_space, "", ""))
    return out


def _align(surface: str, reading: str):
    """Kanji kısımlarına düşen okunuşları bulur.

    取り扱い / とりあつかい -> [('取','と'), ('り',None), ('扱','あつか'), ('い',None)]
    Eşleşme bulunamazsa bütün kelimeye tek bir okunuş verilir.
    """
    runs = [(m.group(0), m.group(1) is not None) for m in _RUN_RE.finditer(surface)]
    pattern = "^" + "".join(
        "(.+?)" if is_k else "(" + re.escape(kata_to_hira(part)) + ")"
        for part, is_k in runs) + "$"
    m = re.match(pattern, reading)
    if not m:
        return [(surface, reading)]
    return [(part, m.group(i + 1) if is_k else None) for i, (part, is_k) in enumerate(runs)]


def to_ruby_html(text: str, mode: str = "all", known_lemmas=None) -> str:
    """Metni <ruby> etiketli HTML'e çevirir.

    mode: 'all'     -> bütün kanjilerde furigana
          'unknown' -> yalnızca bilinmeyen kelimelerde (known_lemmas dışında)
          'none'    -> furigana yok
    """
    if mode == "none" or not has_kanji(text) or not available():
        return html.escape(text).replace("\n", "<br>")
    known = known_lemmas or set()
    return "<br>".join(_line_to_ruby(line, mode, known) for line in text.split("\n"))


def _line_to_ruby(line: str, mode: str, known: set) -> str:
    if not has_kanji(line):
        return html.escape(line)
    parts = []
    for surface, reading, lemma in tokenize(line):
        if not has_kanji(surface) or not reading or (mode == "unknown" and lemma in known):
            parts.append(html.escape(surface))
            continue
        for part, rd in _align(surface, reading):
            if rd and has_kanji(part):
                parts.append(f"<ruby>{html.escape(part)}<rt>{html.escape(rd)}</rt></ruby>")
            else:
                parts.append(html.escape(part))
    return "".join(parts)


def lemmas(text: str) -> set:
    """Metindeki kanjili kelimelerin sözlük biçimleri."""
    return {lem for s, r, lem in tokenize(text) if has_kanji(s)}
