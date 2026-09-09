import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { discoverProfileModels } from "./model-discovery.mts";

test("opencode catalogue uses the configured executable and environment without entering ACP", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "consult-models-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const binary = path.join(root, "configured agent");
  await fs.writeFile(binary, '#!/bin/sh\n[ "$1" = models ] || exit 2\nprintf "%s\\n" "$CATALOGUE"\n', { mode: 0o700 });
  const entry = { registryId: "opencode", binary, args: ["acp"], env: { CATALOGUE: "provider/model\nprovider/model" }, installedAt: "2026-09-09" };
  assert.deepEqual(await discoverProfileModels(entry, root, "inherit"), { source: "opencode-catalogue", models: ["provider/model"] });
  entry.env.CATALOGUE = "unexpected diagnostic text";
  await assert.rejects(discoverProfileModels(entry, root, "inherit"), /Invalid model catalogue/u);
});
