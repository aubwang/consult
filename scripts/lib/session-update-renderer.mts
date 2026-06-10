import type {
  BrokerJobUpdateNotification,
  BrokerSessionUpdate,
} from "./broker-job-runtime.mts";

export type RenderSessionUpdateInput =
  | BrokerSessionUpdate
  | BrokerJobUpdateNotification;

export function renderSessionUpdate(notification: RenderSessionUpdateInput): string {
  const update = ((notification as BrokerJobUpdateNotification).update ??
    notification) as BrokerSessionUpdate;
  if (
    update.sessionUpdate === "agent_message_chunk" &&
    update.content?.type === "text" &&
    typeof update.content.text === "string"
  ) {
    return update.content.text;
  }
  if (update.sessionUpdate === "tool_call") {
    if (update.kind != null || update.title != null) {
      return `[tool_call ${update.kind ?? ""}${update.kind && update.title ? ": " : ""}${
        update.title ?? ""
      }]\n`;
    }
    return `[tool_call ${update.toolCall?.name ?? update.name ?? "unknown"}]\n`;
  }
  return "";
}
