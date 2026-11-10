from .base import LLMProvider, LLMError, normalize_messages

DEFAULT_CLAUDE_MODEL = "claude-sonnet-5-5"


class ClaudeProvider(LLMProvider):
    name = "claude"

    def __init__(self, api_key: str, model: str = ""):
        try:
            import anthropic
        except ImportError as e:
            raise LLMError("'anthropic' paketi kurulu değil: pip install anthropic") from e
        if not api_key:
            raise LLMError("API_KEY_MISSING")
        self.client = anthropic.Anthropic(api_key=api_key)
        self.model = model or DEFAULT_CLAUDE_MODEL

    def chat(self, system, messages, max_tokens=1500, temperature=0.7):
        # Not: Yeni Claude modelleri ve güncel anthropic paketi 'temperature'
        # ayarını kabul etmiyor; bu yüzden gönderilmiyor (parametre ortak arayüz
        # için duruyor, OpenAI tarafı kullanıyor).
        try:
            resp = self.client.messages.create(
                model=self.model,
                system=system,
                messages=normalize_messages(messages),
                max_tokens=max_tokens,
            )
        except Exception as e:
            raise LLMError(f"Claude hatası: {e}") from e
        return "".join(b.text for b in resp.content if getattr(b, "type", "") == "text")
