import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_REPORT_MESSAGE_BYTES,
  REPORT_MESSAGE_TRUNCATED_MARKER,
  boundReportMessage,
  jobReportLogEntry,
  renderReportLogEntry,
  reportParamsFromLogEntry,
} from "./job-reports.mts";

test("boundReportMessage keeps a message inside the byte bound with the marker", () => {
  const short = boundReportMessage("hello");
  const long = boundReportMessage("é".repeat(4000));

  assert.equal(short, "hello");
  assert.equal(Buffer.byteLength(long), MAX_REPORT_MESSAGE_BYTES);
  assert.ok(long.endsWith(REPORT_MESSAGE_TRUNCATED_MARKER));
  // Truncation lands on a code point boundary, so the bounded text still decodes.
  assert.ok(long.startsWith("éé"));
  assert.doesNotMatch(long, /�/u);
});

test("jobReportLogEntry omits data unless a payload was given", () => {
  const withoutData = jobReportLogEntry({
    jobId: "job-1",
    at: "2026-08-18T00:00:00.000Z",
    type: "progress",
    message: "hi",
  });
  const withData = jobReportLogEntry({
    jobId: "job-1",
    at: "2026-08-18T00:00:00.000Z",
    type: "progress",
    message: "hi",
    data: null,
  });

  assert.deepEqual(Object.keys(withoutData.params), ["jobId", "at", "type", "message"]);
  assert.deepEqual(withData.params.data, null);
});

// Report lines are written by delegated Jobs, so reading one is reading
// untrusted input: anything that is not a well-formed report is not a report.
test("reportParamsFromLogEntry rejects entries that are not well-formed reports", () => {
  const rejected: unknown[] = [
    null,
    "consult/report",
    { method: "consult/update", params: { type: "progress", message: "hi" } },
    { method: "consult/report" },
    { method: "consult/report", params: [] },
    { method: "consult/report", params: { type: "shouting", message: "hi" } },
    { method: "consult/report", params: { type: "progress", message: 7 } },
  ];

  for (const entry of rejected) {
    assert.equal(reportParamsFromLogEntry(entry), null, JSON.stringify(entry) ?? "undefined");
  }
  assert.deepEqual(
    reportParamsFromLogEntry({
      method: "consult/report",
      params: { type: "progress", message: "hi", extra: true },
    }),
    { jobId: "", at: "", type: "progress", message: "hi" },
  );
});

test("renderReportLogEntry produces one line and ignores non-report entries", () => {
  assert.equal(
    renderReportLogEntry({
      method: "consult/report",
      params: { jobId: "job-1", at: "now", type: "blocked", message: "line one\nline two" },
    }),
    "[report blocked: line one line two]\n",
  );
  assert.equal(renderReportLogEntry({ method: "consult/finalized", params: {} }), "");
});
