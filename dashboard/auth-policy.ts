export const DEFAULT_MODEL = "openai-codex/gpt-6-astra";

export function subscriptionModel(value?: string): string {
  if (value !== undefined && (typeof value !== "string" || value.length > 300))
    throw new Error("Invalid model");
  const model = value?.trim() || DEFAULT_MODEL;
  if (!/^openai-codex\/[a-zA-Z0-9._-]+$/.test(model))
    throw new Error("Mesh Office uses ChatGPT subscription models only. Choose an openai-codex model.");
  return model;
}

export function subscriptionEnvironment(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PI_OFFLINE: "1", ...extra };
  delete env.OPENAI_API_KEY;
  return env;
}
