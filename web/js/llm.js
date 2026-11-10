// Yapay zekâ bağlantısı: Claude (varsayılan) ya da OpenAI, doğrudan tarayıcıdan.
// API anahtarı yalnızca bu cihazda saklanır, sitenin kodunda yoktur.

export class LLMError extends Error {}

export function normalizeMessages(messages) {
  const out = [];
  for (const m of messages) {
    const role = m.role, content = (m.content || "").trim();
    if (!["user", "assistant"].includes(role) || !content) continue;
    if (out.length && out[out.length - 1].role === role) out[out.length - 1].content += "\n\n" + content;
    else out.push({ role, content });
  }
  if (out.length && out[0].role === "assistant") out.unshift({ role: "user", content: "（始めてください）" });
  if (!out.length) out.push({ role: "user", content: "（始めてください）" });
  return out;
}

export function extractJson(text) {
  if (!text) return null;
  const t = text.trim().replace(/^```(?:json)?\s*|\s*```$/gm, "");
  try { return JSON.parse(t); } catch (e) { /* aşağıda dene */ }
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a !== -1 && b > a) {
    try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { return null; }
  }
  return null;
}

async function post(url, headers, body) {
  let res;
  try {
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  } catch (e) {
    throw new LLMError("İnternete ulaşılamadı. Wi-Fi bağlantısını kontrol edin.");
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* boş cevap */ }
  if (!res.ok) {
    const msg = data?.error?.message || res.statusText;
    if (res.status === 401) throw new LLMError("API anahtarı geçersiz. ⚙ Ayarlar'dan kontrol edin.");
    if (res.status === 429) throw new LLMError("Çok sık istek ya da bakiye bitti: " + msg);
    throw new LLMError(`Yapay zekâ hatası (${res.status}): ${msg}`);
  }
  return data;
}

export async function chat(s, system, messages, maxTokens = 1500) {
  const msgs = normalizeMessages(messages);
  if (s.provider === "openai") {
    if (!s.openai_key) throw new LLMError("API_KEY_MISSING");
    const d = await post("https://api.openai.com/v1/chat/completions",
      { "content-type": "application/json", authorization: `Bearer ${s.openai_key}` },
      { model: s.openai_model || "gpt-4o", max_tokens: maxTokens,
        messages: [{ role: "system", content: system }, ...msgs] });
    return d.choices?.[0]?.message?.content || "";
  }
  if (!s.claude_key) throw new LLMError("API_KEY_MISSING");
  const d = await post("https://api.anthropic.com/v1/messages", {
    "content-type": "application/json",
    "x-api-key": s.claude_key,
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true",
  }, { model: s.claude_model || "claude-sonnet-5-5", max_tokens: maxTokens, system, messages: msgs });
  return (d.content || []).filter(b => b.type === "text").map(b => b.text).join("");
}
