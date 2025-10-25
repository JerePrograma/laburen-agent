// frontend/src/lib/openrouter.ts
type ORMessage = { role: "system" | "user" | "assistant"; content: string };

export async function openrouterChat(params: {
  system: string;
  messages: { role: "user" | "assistant"; content: string }[];
  temperature?: number;
  maxTokens?: number;
}): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY ausente");

  const model = process.env.OPENROUTER_MODEL || "anthropic/claude-3.5-haiku";
  const referer =
    (process.env.NEXT_PUBLIC_BACKEND_URL && process.env.NEXT_PUBLIC_BACKEND_URL.replace(/\/$/, "")) ||
    "https://app.jereprograma.com";

  const body = {
    model,
    messages: [
      { role: "system", content: params.system },
      ...params.messages.map<ORMessage>((m) => ({ role: m.role, content: m.content })),
    ],
    temperature: params.temperature ?? 0.2,
    max_tokens: params.maxTokens ?? 1024,
  };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 60_000);

  let res: Response;
  try {
    res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": referer,
        "X-Title": "Laburen AI Agent",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(t);
    throw new Error(`openrouter: fallo de red/timeout: ${String(e)}`);
  }
  clearTimeout(t);

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`openrouter ${res.status}: ${text || res.statusText}`);
  }

  const json: any = await res.json().catch(() => ({}));
  const text: unknown =
    json?.choices?.[0]?.message?.content ??
    json?.choices?.[0]?.delta?.content ??
    "";

  if (typeof text !== "string" || !text.trim()) {
    throw new Error("openrouter: respuesta vacía");
  }
  return text.trim();
}
