import assert from "node:assert/strict";
import { test } from "node:test";

import { COMMANDS_WITH_USAGE } from "./command-help.mts";
import { HELP_TOPICS, helpAll, helpFor, helpOverview, helpTopic } from "./help.mts";

// The overview is the only place a reader learns a topic exists, so a topic
// that is registered but unlisted is invisible, and a listed topic that does
// not resolve is a dead end.
test("the overview lists exactly the topics that resolve", () => {
  const overview = helpOverview();
  const listed = overview
    .slice(overview.indexOf("Topics:"), overview.indexOf("Profile selection:"))
    .split("\n")
    .map((line) => /^ {2}(\S+) {2,}\S/u.exec(line)?.[1])
    .filter((name): name is string => Boolean(name));

  assert.deepEqual(listed, [...HELP_TOPICS]);
  for (const topic of HELP_TOPICS) {
    assert.ok(helpTopic(topic), `${topic} is listed but does not resolve`);
  }
});

test("every topic page names itself and points somewhere deeper", () => {
  for (const topic of HELP_TOPICS) {
    const page = helpTopic(topic);

    assert.ok(page, topic);
    assert.match(page, new RegExp(`^Topic: ${topic}\\n`, "u"), topic);
    assert.match(page, /\nSee also: consult /u, `${topic} has no onward pointer`);
  }
});

// A topic page a reader cannot finish defeats the point of splitting them up.
test("topic pages stay individually readable", () => {
  for (const topic of HELP_TOPICS) {
    const lines = (helpTopic(topic) ?? "").split("\n");

    assert.ok(lines.length < 140, `${topic} page is ${lines.length} lines`);
    for (const line of lines) {
      assert.ok(line.length <= 80, `${topic} line exceeds 80 columns: ${line}`);
    }
  }
});

test("helpFor resolves topics, commands, and the bare overview", () => {
  assert.equal(helpFor(undefined, false).stdout, helpOverview());
  assert.equal(helpFor("help", false).stdout, helpOverview());
  assert.equal(helpFor("authority", false).stdout, helpTopic("authority"));
  assert.match(helpFor("delegate", false).stdout, /^Usage:\n {2}consult delegate/u);
  assert.equal(helpFor(undefined, true).stdout, helpAll());
});

// A command name and a topic name must not collide: `consult help review` has
// to answer with one of them deterministically.
test("a name shared by a command and a topic resolves to the topic", () => {
  const shared = HELP_TOPICS.filter((topic) => COMMANDS_WITH_USAGE.includes(topic));

  assert.deepEqual(shared, ["review"], "update this test if the overlap changes");
  assert.equal(helpFor("review", false).stdout, helpTopic("review"));
  assert.match(helpFor("review", false).stdout, /^Topic: review\n/u);
});

test("helpFor rejects an unknown name with an actionable hint", () => {
  const typo = helpFor("delegaton", false);
  const unrelated = helpFor("kubernetes", false);

  assert.equal(typo.exitCode, 2);
  assert.equal(typo.stdout, "");
  assert.match(typo.stderr, /did you mean 'consult help delegation'\?/u);
  assert.equal(unrelated.exitCode, 2);
  assert.match(unrelated.stderr, new RegExp(`topics: ${HELP_TOPICS.join(", ")}`, "u"));
});

test("helpAll contains the overview and every topic once", () => {
  const all = helpAll();

  assert.ok(all.startsWith(helpOverview()));
  for (const topic of HELP_TOPICS) {
    const occurrences = all.split(`\nTopic: ${topic}\n`).length - 1;

    assert.equal(occurrences, 1, `${topic} appears ${occurrences} times`);
  }
});
