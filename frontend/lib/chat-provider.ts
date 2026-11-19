import { createOpenAI } from "@ai-sdk/openai";

export function getChatProviderConfig() {
  const provider = (process.env.AI_PROVIDER || "openai").trim().toLowerCase();
  
  // Groq usa la API compatible con OpenAI
  if (provider === "groq") {
    const apiKey = process.env.GROQ_API_KEY?.trim();
    const model = process.env.GROQ_MODEL?.trim() || "openai/gpt-oss-120b";
    
    if (!apiKey || model.startsWith("sk-")) return null;
    
    return {
      provider: "groq",
      apiKey,
      model,
      baseURL: "https://api.groq.com/openai/v1",
    };
  }
  
  if (provider !== "openai" && provider !== "deepseek") return null;
  
  const apiKey = (provider === "deepseek" ? process.env.DEEPSEEK_API_KEY : process.env.OPENAI_API_KEY)?.trim();
  const fallbackModel = provider === "deepseek" ? "deepseek-flash" : "gpt-4o-mini";
  const model = (provider === "deepseek" ? process.env.DEEPSEEK_MODEL : process.env.OPENAI_MODEL)?.trim() || fallbackModel;
  
  if (!apiKey || model.startsWith("sk-")) return null;
  
  return {
    provider,
    apiKey,
    model,
    baseURL: provider === "deepseek" ? "https://api.deepseek.com/v1" : "https://api.openai.com/v1",
  };
}

export function createChatModel(config: NonNullable<ReturnType<typeof getChatProviderConfig>>) {
  return createOpenAI({ apiKey: config.apiKey, baseURL: config.baseURL }).chat(config.model);
}
