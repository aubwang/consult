import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { boundedExecutionLaunch, probeExecutionLimits, EXECUTION_LIMITS } from "./execution-limits.mts";
import { startJobAgent } from "./job-agent.mts";
import { newSession, promptTurn } from "./acp-client.mts";
import { writeJobRecord } from "./job-records.mts";

const native = process.env.CONSULT_TEST_EXECUTION === "1" && process.platform === "linux";
const exec = promisify(execFile);

test("execute launch uses a cgroup and carries no credential values in argv", { skip: process.platform !== "linux" }, () => {
  const bounded = boundedExecutionLaunch({ binary: "/bin/true", args: [], cwd: process.cwd(), env: { TEST_TOKEN: "dummy-value" } });
  assert.ok(bounded.launch.args.includes(`--property=MemoryMax=${EXECUTION_LIMITS.memoryBytes}`));
  assert.ok(bounded.launch.args.includes(`--property=TasksMax=${EXECUTION_LIMITS.processes}`));
  assert.ok(!bounded.launch.args.join(" ").includes("dummy-value"));
});

test("native execute guard verifies kernel limits and enforces per-file bounds", { skip: !native }, async (t) => {
  await probeExecutionLimits();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "consult-exec-limit-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bounded = boundedExecutionLaunch({ binary: process.execPath, args: ["-e", `require('fs').writeFileSync('bounded', Buffer.alloc(${EXECUTION_LIMITS.fileBytes + 1}));`], cwd: root, env: {} });
  try {
    await assert.rejects(exec(bounded.launch.binary, bounded.launch.args, { cwd: root, env: bounded.launch.env, timeout: 15_000 }));
    assert.ok((await fs.stat(path.join(root, "bounded"))).size <= EXECUTION_LIMITS.fileBytes);
  } finally { await bounded.terminate(); }
});

for (const profile of ["codex", "claude"]) test(`native ${profile} execute Job runs a regression test inside confinement`, { skip: !native }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "consult-exec-profile-"));
  const source = path.join(root, "source"); const cwd = path.join(root, "isolated");
  await fs.mkdir(source); await fs.mkdir(cwd);
  const oldData = process.env.CONSULT_DATA_DIR; process.env.CONSULT_DATA_DIR = path.join(root, "state");
  t.after(async () => { if (oldData === undefined) delete process.env.CONSULT_DATA_DIR; else process.env.CONSULT_DATA_DIR = oldData; await fs.rm(root, { recursive: true, force: true }); });
  await fs.writeFile(path.join(cwd, "check.test.mjs"), `import {test} from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; test('regression',()=>{assert.equal(2+2,4); fs.writeFileSync('verified.txt','passed'); assert.throws(()=>fs.writeFileSync(${JSON.stringify(path.join(source, "escape.txt"))},'escape'));});`);
  // Synthetic ACP Profile requests permission exactly as a real adapter does,
  // then invokes a native child command only when Core grants that request.
  await fs.writeFile(path.join(cwd, "agent.mjs"), `import {spawnSync} from 'node:child_process';
    let buffer=''; let promptId; const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
    process.stdin.on('data',chunk=>{ buffer+=chunk; let at; while((at=buffer.indexOf('\\n'))>=0){const m=JSON.parse(buffer.slice(0,at));buffer=buffer.slice(at+1);
      if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1,agentCapabilities:{}}});
      if(m.method==='session/new')send({jsonrpc:'2.0',id:m.id,result:{sessionId:'test-session'}});
      if(m.method==='session/prompt'){promptId=m.id;send({jsonrpc:'2.0',id:'permission',method:'session/request_permission',params:{sessionId:'test-session',options:[{kind:'allow_once',optionId:'allow',name:'Allow'}],toolCall:{toolCallId:'test',kind:'execute',rawInput:{command:['node','--test','check.test.mjs'],cwd:process.cwd()}}}});}
      if(m.id==='permission'){const allowed=m.result?.outcome?.optionId==='allow';const child=allowed?spawnSync('node',['--test','check.test.mjs']):null;send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'test-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:allowed?'tests exit='+child.status:'denied'}}}});send({jsonrpc:'2.0',id:promptId,result:{stopReason:'end_turn'}});}
    }});`);
  const authority = { schemaVersion: 1 as const, mode: "write" as const, confinement: "confined" as const, allowExecute: true, allowFetch: false };
  await writeJobRecord(source, "job-native-exec", { jobId: "job-native-exec", authority, mode: "write", isolated: true, isolatedWorkspace: { executionRoot: cwd } as any });
  const agent = await startJobAgent({ binary: process.execPath, args: [path.join(cwd, "agent.mjs")], cwd, stateWorkspaceRoot: source, jobId: "job-native-exec", profileRegistryId: profile, authority,
    env: { HOME: root, CONSULT_DATA_DIR: process.env.CONSULT_DATA_DIR, [profile === "codex" ? "CONSULT_OPENAI_API_KEY" : "CONSULT_CLAUDE_API_KEY"]: "synthetic-test-placeholder" },
    runtime: { handleSessionUpdate: async () => {}, getSessionAuthority: () => authority, notePermissionDecision: () => {} },
  });
  try {
    const session = await newSession(agent.connection, { cwd });
    let output = "";
    for await (const event of promptTurn(agent.connection, { sessionId: session.sessionId, prompt: "Run the regression test" })) if (event.type === "update" && event.update.sessionUpdate === "agent_message_chunk" && event.update.content.type === "text") output += event.update.content.text;
    assert.equal(output, "tests exit=0");
    assert.equal(await fs.readFile(path.join(cwd, "verified.txt"), "utf8"), "passed");
    await assert.rejects(fs.access(path.join(source, "escape.txt")));
  } finally { await agent.dispose(); }
});

test("scope cleanup kills descendants that leave the original process group", { skip: !native }, async () => {
  const bounded = boundedExecutionLaunch({ binary: process.execPath, args: ["-e", `const child=require('node:child_process').spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{detached:true,stdio:'ignore'}); console.log(child.pid);child.unref();`], cwd: process.cwd(), env: {} });
  try {
    const result = await exec(bounded.launch.binary, bounded.launch.args, { cwd: bounded.launch.cwd, env: bounded.launch.env, timeout: 10_000 });
    const pid = Number(result.stdout.trim()); assert.ok(Number.isInteger(pid) && pid > 1);
    await bounded.terminate();
    const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8").catch(() => "");
    // A reparented zombie may await init's reap; it cannot execute or hold files.
    assert.ok(stat === "" || /\) Z /u.test(stat));
  } finally { await bounded.terminate(); }
});
