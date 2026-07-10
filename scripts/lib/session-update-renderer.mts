import type {
  BrokerJobUpdateNotification,
  BrokerSessionUpdate,
} from "./broker-job-runtime.mts";

export type RenderSessionUpdateInput =
  | BrokerSessionUpdate
  | BrokerJobUpdateNotification;

export function extractAgentMessageText(notification: RenderSessionUpdateInput): string {
  const update = unwrapSessionUpdate(notification);
  if (
    update.sessionUpdate === "agent_message_chunk" &&
    update.content?.type === "text" &&
    typeof update.content.text === "string"
  ) {
    return update.content.text;
  }
  return "";
}

export function renderSessionUpdate(notification: RenderSessionUpdateInput): string {
  const update = unwrapSessionUpdate(notification);
  const agentText = extractAgentMessageText(update);
  if (agentText) {
    return agentText;
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

function unwrapSessionUpdate(notification: RenderSessionUpdateInput): BrokerSessionUpdate {
  return ((notification as BrokerJobUpdateNotification).update ??
    notification) as BrokerSessionUpdate;
}
