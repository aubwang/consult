import { newSession, type AcpConnection } from "./acp-client.mts";

// Discovery does not set a model or send a prompt. Session creation is bounded
// separately from initialization; the owning probe always disposes the agent.
export async function discoverSessionModels(connection: AcpConnection, cwd: string): Promise<string[]> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const session = await Promise.race([
      newSession(connection, { cwd }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Model discovery session timed out")), 10_000);
      }),
    ]);
    return sessionModelIds(session);
  } finally {
    clearTimeout(timer);
  }
}

export function sessionModelIds(session: unknown): string[] {
  const state = session as { models?: { availableModels?: unknown[] }; configOptions?: unknown[] } | null;
  const advertised = state?.models?.availableModels;
  let values: unknown[] = [];
  if (Array.isArray(advertised)) {
    values = advertised.map((entry: any) => typeof entry === "string" ? entry : entry?.modelId ?? entry?.id);
  } else if (Array.isArray(state?.configOptions)) {
    const options = state.configOptions as any[];
    const model = options.find((option) => option?.category === "model") ??
      options.find((option) => /model/iu.test(`${option?.id ?? ""} ${option?.name ?? ""}`));
    if (Array.isArray(model?.options)) {
      values = model.options.flatMap((entry: any) => Array.isArray(entry?.options)
        ? entry.options.map((child: any) => child?.value) : [entry?.value]);
    }
  }
  return [...new Set(values.filter((value): value is string =>
    typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value)))].sort();
}
