from .base import LLMProvider, LLMError, extract_json, normalize_messages


def make_provider(name: str, api_key: str, model: str = "") -> LLMProvider:
    """Ayarlardaki seçime göre sağlayıcıyı oluşturur ('claude' varsayılan)."""
    if name == "openai":
        from .openai_provider import OpenAIProvider
        return OpenAIProvider(api_key, model)
    from .claude_provider import ClaudeProvider
    return ClaudeProvider(api_key, model)
