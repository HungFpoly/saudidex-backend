import { CreateMLCEngine, type MLCEngine } from "@mlc-ai/web-llm";

export const WEBLLM_MODEL = "Llama-3.1-8B-Instruct-q4f32_1-MLC";

let enginePromise: Promise<MLCEngine> | null = null;

/**
 * Returns a singleton WebLLM engine instance.
 * The model is downloaded and cached on first call — subsequent calls reuse it.
 * Model size is ~2-4 GB (quantized), cached in the browser after first download.
 */
export const getWebLLMEngine = async (
  onProgress?: (report: { progress: number; text: string }) => void
): Promise<MLCEngine> => {
  if (!enginePromise) {
    enginePromise = CreateMLCEngine(WEBLLM_MODEL, {
      initProgressCallback: (report) => {
        onProgress?.({ progress: report.progress, text: report.text });
        console.log(`[WebLLM] ${report.text} (${(report.progress * 100).toFixed(1)}%)`);
      }
    });
  }
  return enginePromise;
};

/**
 * Checks if WebGPU is available in the current browser.
 * WebLLM requires WebGPU support (Chrome 113+, Edge 113+, Firefox Nightly).
 */
export const isWebGPUAvailable = (): boolean => {
  return typeof navigator !== "undefined" && !!(navigator as any).gpu;
};

/**
 * Send a chat message to WebLLM and return the response text.
 */
export const webLLMChat = async (
  messages: Array<{ role: string; content: string }>,
  onProgress?: (report: { progress: number; text: string }) => void
): Promise<string> => {
  const engine = await getWebLLMEngine(onProgress);

  const chatMessages = messages.map(m => ({
    role: m.role as "user" | "assistant" | "system",
    content: m.content
  }));

  const response = await engine.chat.completions.create({
    messages: chatMessages,
    temperature: 0.3,
    max_tokens: 4096
  });

  return response.choices[0]?.message?.content || "";
};

/**
 * Send a chat message to WebLLM with JSON mode (forces structured output).
 */
export const webLLMChatJSON = async (
  systemInstruction: string,
  userPrompt: string,
  onProgress?: (report: { progress: number; text: string }) => void
): Promise<any> => {
  const response = await webLLMChat([
    {
      role: "system",
      content: `${systemInstruction}\nIMPORTANT: Return ONLY valid JSON. No preamble, no explanation, no markdown code blocks.`
    },
    { role: "user", content: userPrompt }
  ], onProgress);

  // Strip markdown code fences if present
  const cleaned = response
    .replace(/^```(?:json)?\s*/m, "")
    .replace(/\s*```$/m, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    console.error("WebLLM JSON parse error, raw response:", cleaned);
    throw new Error(`Failed to parse WebLLM JSON response: ${(e as Error).message}`);
  }
};
