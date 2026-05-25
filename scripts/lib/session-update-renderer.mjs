export function renderSessionUpdate(notification) {
  const update = notification.update ?? notification;
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
