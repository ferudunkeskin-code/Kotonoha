"""Yapay zekâ sağlayıcıları için ortak arayüz.

Her sağlayıcı aynı `chat()` metodunu sunar; programın geri kalanı
Claude mu OpenAI mı kullanıldığını bilmez.
"""
import json
import re


class LLMError(Exception):
    pass


class LLMProvider:
    name = "base"

    def chat(self, system: str, messages: list, max_tokens: int = 1500,
             temperature: float = 0.7) -> str:
        raise NotImplementedError


def normalize_messages(messages: list) -> list:
    """Mesajları API'lerin kabul ettiği biçime getirir.

    - Yalnızca 'user' ve 'assistant' rolleri kalır.
    - Art arda gelen aynı roller birleştirilir.
    - İlk mesaj 'assistant' ise (ör. rol yapmayı avatar başlatıyorsa)
      başa kısa bir kullanıcı mesajı eklenir; Claude bunu şart koşar.
    """
    out = []
    for m in messages:
        role = m.get("role")
        content = (m.get("content") or "").strip()
        if role not in ("user", "assistant") or not content:
            continue
        if out and out[-1]["role"] == role:
            out[-1]["content"] += "\n\n" + content
        else:
            out.append({"role": role, "content": content})
    if out and out[0]["role"] == "assistant":
        out.insert(0, {"role": "user", "content": "（始めてください）"})
    if not out:
        out = [{"role": "user", "content": "（始めてください）"}]
    return out


_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)


def extract_json(text: str):
    """Model cevabından JSON nesnesini çıkarır. Bulamazsa None döner."""
    if not text:
        return None
    t = _FENCE.sub("", text.strip())
    try:
        return json.loads(t)
    except Exception:
        pass
    start, end = t.find("{"), t.rfind("}")
    if start != -1 and end > start:
        try:
            return json.loads(t[start:end + 1])
        except Exception:
            return None
    return None
