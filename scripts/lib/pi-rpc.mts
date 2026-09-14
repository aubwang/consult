import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readJsonlMessages } from "./jsonl-framing.mts";

export type PiEvent = Record<string, any>;

/** One Pi subprocess, retained across prompt turns. Responses acknowledge
 * commands; only agent_settled completes a prompt. All framing is bounded. */
export class PiRpc {
  child: ChildProcessWithoutNullStreams;
  #pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  #next = 0;
  #buffer: Buffer = Buffer.alloc(0);
  #failure: Error | undefined;
  onEvent: (event: PiEvent) => void | Promise<void> = () => {};
  onFailure: (error: Error) => void = () => {};

  constructor(binary: string, args: string[], cwd: string) {
    this.child = spawn(binary, args, { cwd, env: { ...process.env, PI_OFFLINE: "1", PI_TELEMETRY: "0" }, stdio: ["pipe", "pipe", "pipe"] });
    // Do not forward Pi startup output, which may contain provider/account data.
    this.child.stderr.resume();
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.once("error", (error) => this.fail(error));
    this.child.once("exit", (code, signal) => this.fail(new Error(`Pi exited (${signal ?? code})`)));
    void this.consume().catch((error) => this.fail(error instanceof Error ? error : new Error(String(error))));
  }

  async consume(): Promise<void> {
    for await (const chunk of this.child.stdout) {
      const frame = readJsonlMessages(this.#buffer, chunk as Buffer);
      this.#buffer = frame.buffer;
      if (frame.error) throw frame.error;
      for (const line of frame.lines) {
        if (!line.trim()) continue;
        const event: PiEvent = JSON.parse(line);
        if (event.type === "response") {
          const pending = this.#pending.get(event.id);
          if (!pending) continue;
          this.#pending.delete(event.id);
          clearTimeout(pending.timer);
          if (event.success === true) pending.resolve(event.data);
          else pending.reject(new Error(`Pi ${event.command ?? "command"} failed: ${String(event.error ?? "unknown error").slice(0, 1000)}`));
        } else await this.onEvent(event);
      }
    }
  }

  request(type: string, data: Record<string, unknown> = {}): Promise<any> {
    if (this.#failure) return Promise.reject(this.#failure);
    const id = `consult-${++this.#next}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error(`Pi ${type} timed out`)), 10_000);
      this.#pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ ...data, type, id })}\n`);
    });
  }

  fail(error: Error): void {
    if (this.#failure) return;
    this.#failure = error;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.#pending.clear();
    this.onFailure(error);
    this.child.kill();
  }

  close(): void {
    this.fail(new Error("Pi transport closed"));
  }
}
