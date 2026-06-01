import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { findRegistryEntry, loadRegistry } from "./registry.mjs";

test("loadRegistry returns the shipped v1 registry entries", async () => {
  const registry = await loadRegistry();

  assert.equal(registry.schemaVersion, 1);
  assert.equal(registry.agents.length, 5);
  for (const agent of registry.agents) {
    assert.equal(typeof agent.id, "string");
    assert.equal(typeof agent.label, "string");
    if ("notes" in agent) {
      assert.equal(typeof agent.notes, "string");
    }
    assert.equal(typeof agent.binary, "string");
    assert.equal(Array.isArray(agent.args), true);
    assert.equal(typeof agent.install.type, "string");
    assert.equal(typeof agent.supports.resume, "boolean");
    assert.equal(typeof agent.supports.load, "boolean");
    if (agent.install.type === "cargo" || agent.install.type === "npm") {
      assert.equal(typeof agent.install.cmd, "string");
    } else if (agent.install.type === "github-release") {
      assert.equal(typeof agent.install.repo, "string");
      assert.equal(typeof agent.install.version, "string");
      assert.equal(typeof agent.install.assetTemplate, "string");
    } else {
      assert.fail(`unknown install type: ${agent.install.type}`);
    }
  }
});

test("Gemini registry entry uses the native ACP mode", async () => {
  const registry = await loadRegistry();
  const gemini = findRegistryEntry(registry, "gemini");

  assert.equal(gemini.label, "Google Gemini CLI");
  assert.equal(gemini.binary, "gemini");
  assert.deepEqual(gemini.args, ["--acp"]);
  assert.deepEqual(gemini.install, {
    type: "npm",
    cmd: "npm install -g @google/gemini-cli",
  });
  assert.deepEqual(gemini.supports, { resume: false, load: true });
});

test("loadRegistry returns non-empty notes for every shipped registry entry", async () => {
  const registry = await loadRegistry();

  for (const agent of registry.agents) {
    assert.equal(typeof agent.notes, "string");
    assert.notEqual(agent.notes.trim(), "");
  }
});

test("findRegistryEntry returns an entry by id or null", () => {
  const registry = {
    schemaVersion: 1,
    agents: [{ id: "codex" }, { id: "claude" }],
  };

  assert.deepEqual(findRegistryEntry(registry, "claude"), { id: "claude" });
  assert.equal(findRegistryEntry(registry, "missing"), null);
});

test("loadRegistry rejects a schema version mismatch", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consult-registry-"));
  const registryPath = path.join(dir, "registry.json");
  await fs.writeFile(registryPath, JSON.stringify({ schemaVersion: 2, agents: [] }));

  await assert.rejects(loadRegistry(registryPath), (error) => {
    assert.equal(error.code, "REGISTRY_SCHEMA_MISMATCH");
    assert.equal(error.path, registryPath);
    return true;
  });
});

test("loadRegistry rejects malformed JSON with a named error", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consult-registry-"));
  const registryPath = path.join(dir, "registry.json");
  await fs.writeFile(registryPath, "{", "utf8");

  await assert.rejects(loadRegistry(registryPath), (error) => {
    assert.equal(error.code, "REGISTRY_MALFORMED");
    assert.equal(error.message, `Registry file is malformed: ${registryPath}`);
    assert.equal(error.path, registryPath);
    return true;
  });
});

test("loadRegistry rejects a non-object registry with a named error", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consult-registry-"));
  const registryPath = path.join(dir, "registry.json");
  await fs.writeFile(registryPath, "null", "utf8");

  await assert.rejects(loadRegistry(registryPath), (error) => {
    assert.equal(error.code, "REGISTRY_MALFORMED");
    assert.equal(error.message, `Registry file is malformed: ${registryPath}`);
    assert.equal(error.path, registryPath);
    return true;
  });
});

test("loadRegistry rejects non-object registry entries with a named error", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consult-registry-"));
  const registryPath = path.join(dir, "registry.json");
  await fs.writeFile(registryPath, JSON.stringify({ schemaVersion: 1, agents: [null] }));

  await assert.rejects(loadRegistry(registryPath), (error) => {
    assert.equal(error.code, "REGISTRY_MALFORMED");
    assert.equal(error.message, `Registry file is malformed: ${registryPath}`);
    assert.equal(error.path, registryPath);
    return true;
  });
});

test("loadRegistry rejects non-object install and supports fields with a named error", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "consult-registry-"));
  const registryPath = path.join(dir, "registry.json");
  await fs.writeFile(
    registryPath,
    JSON.stringify({
      schemaVersion: 1,
      agents: [
        {
          id: "codex",
          label: "Codex",
          binary: "codex",
          args: [],
          install: null,
          supports: [],
        },
      ],
    }),
  );

  await assert.rejects(loadRegistry(registryPath), (error) => {
    assert.equal(error.code, "REGISTRY_MALFORMED");
    assert.equal(error.message, `Registry file is malformed: ${registryPath}`);
    assert.equal(error.path, registryPath);
    return true;
  });
});
