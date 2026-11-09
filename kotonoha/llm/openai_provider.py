from .base import LLMProvider, LLMError, normalize_messages

DEFAULT_OPENAI_MODEL = "gpt-4o"


class OpenAIProvider(LLMProvider):
    name = "openai"

    def __init__(self, api_key: str, model: str = ""):
        try:
            from openai import OpenAI
        except ImportError as e:
            raise LLMError("'openai' paketi kurulu değil: pip install openai") from e
        if not api_key:
            raise LLMError("API_KEY_MISSING")
        self.client = OpenAI(api_key=api_key)
        self.model = model or DEFAULT_OPENAI_MODEL

    def chat(self, system, messages, max_tokens=1500, temperature=0.7):
        msgs = [{"role": "system", "content": system}] + normalize_messages(messages)
        try:
            resp = self.client.chat.completions.create(
                model=self.model,
                messages=msgs,
                max_tokens=max_tokens,
                temperature=temperature,
            )
        except Exception as e:
            raise LLMError(f"OpenAI hatası: {e}") from e
        return resp.choices[0].message.content or ""
