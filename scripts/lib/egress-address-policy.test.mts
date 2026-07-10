import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyEgressAddress,
  EgressAddressPolicyError,
  normalizeEgressHostname,
  resolvePinnedEgressTarget,
  type EgressAddressPolicyErrorCode,
  type EgressLookup,
} from "./egress-address-policy.mts";

test("normalizeEgressHostname canonicalizes DNS names, IDN, roots, and IP forms", () => {
  assert.equal(normalizeEgressHostname("API.Example.COM."), "api.example.com");
  assert.equal(normalizeEgressHostname("b\u00fccher.example"), "xn--bcher-kva.example");
  assert.equal(normalizeEgressHostname("[2606:4700:4700::1111]"), "2606:4700:4700::1111");
  assert.equal(normalizeEgressHostname("2130706433"), "127.0.0.1");
  assert.equal(normalizeEgressHostname("::ffff:8.8.8.8"), "8.8.8.8");
});

test("normalizeEgressHostname rejects ambiguous or malformed host syntax", () => {
  for (const hostname of [
    "",
    " localhost",
    "localhost",
    "example.com:443",
    "user@example.com",
    "example.com/path",
    "example.com?query",
    "example.com#fragment",
    "example.com%00.invalid",
    "*.example.com",
    "bad_name.example",
    "-bad.example",
    "bad-.example",
    "example..com",
    "[127.0.0.1]",
    "fe80::1%lo0",
  ]) {
    assert.throws(
      () => normalizeEgressHostname(hostname),
      (error) => hasCode(error, "invalid-hostname"),
      hostname,
    );
  }
});

test("classifyEgressAddress permits ordinary global IPv4 and IPv6", () => {
  assert.deepEqual(classifyEgressAddress("8.8.8.8"), {
    address: "8.8.8.8",
    family: 4,
    sourceFamily: 4,
    isGlobal: true,
  });
  assert.deepEqual(classifyEgressAddress("2606:4700:4700::1111"), {
    address: "2606:4700:4700::1111",
    family: 6,
    sourceFamily: 6,
    isGlobal: true,
  });
});

test("classifyEgressAddress blocks IPv4 special-use ranges", () => {
  for (const address of [
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.0.0.9",
    "192.0.2.1",
    "192.31.196.1",
    "192.52.193.1",
    "192.88.99.1",
    "192.168.0.1",
    "192.175.48.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "255.255.255.255",
  ]) {
    assert.equal(classifyEgressAddress(address).isGlobal, false, address);
  }
});

test("classifyEgressAddress blocks IPv6 special-use ranges", () => {
  for (const address of [
    "::",
    "::1",
    "64:ff9b::c000:201",
    "100::1",
    "2001::1",
    "2001:2::1",
    "2001:db8::1",
    "2002::1",
    "2620:4f:8000::1",
    "3fff::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
  ]) {
    assert.equal(classifyEgressAddress(address).isGlobal, false, address);
  }
});

test("IPv4-mapped IPv6 is classified by its effective IPv4 address", () => {
  assert.deepEqual(classifyEgressAddress("::ffff:8.8.8.8"), {
    address: "8.8.8.8",
    family: 4,
    sourceFamily: 6,
    isGlobal: true,
  });
  assert.deepEqual(classifyEgressAddress("::ffff:127.0.0.1"), {
    address: "127.0.0.1",
    family: 4,
    sourceFamily: 6,
    isGlobal: false,
  });
  assert.deepEqual(classifyEgressAddress("::ffff:169.254.169.254"), {
    address: "169.254.169.254",
    family: 4,
    sourceFamily: 6,
    isGlobal: false,
  });
});

test("resolvePinnedEgressTarget resolves once, validates all answers, and pins the first", async () => {
  const calls: string[] = [];
  const lookup: EgressLookup = async (hostname) => {
    calls.push(hostname);
    return [
      { address: "2606:4700:4700::1111", family: 6 },
      { address: "8.8.8.8", family: 4 },
    ];
  };

  assert.deepEqual(
    await resolvePinnedEgressTarget(
      { hostname: "DNS.Google.", port: 443 },
      lookup,
    ),
    {
      hostname: "dns.google",
      port: 443,
      address: "2606:4700:4700::1111",
      family: 6,
    },
  );
  assert.deepEqual(calls, ["dns.google"]);
});

test("resolvePinnedEgressTarget handles public IP literals without DNS", async () => {
  let called = false;
  const lookup: EgressLookup = async () => {
    called = true;
    return [];
  };

  assert.deepEqual(
    await resolvePinnedEgressTarget({ hostname: "8.8.8.8", port: 443 }, lookup),
    {
      hostname: "8.8.8.8",
      port: 443,
      address: "8.8.8.8",
      family: 4,
    },
  );
  assert.equal(called, false);
});

test("resolvePinnedEgressTarget rejects every port except integer 443", async () => {
  const lookup: EgressLookup = async () => [{ address: "8.8.8.8", family: 4 }];
  for (const port of [80, 444, 443.1, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(
      resolvePinnedEgressTarget({ hostname: "example.com", port }, lookup),
      (error) => hasCode(error, "port-not-allowed"),
    );
  }
});

test("resolvePinnedEgressTarget fails closed on empty and failed resolution", async () => {
  await assert.rejects(
    resolvePinnedEgressTarget(
      { hostname: "example.com", port: 443 },
      async () => [],
    ),
    (error) => hasCode(error, "resolution-empty"),
  );
  await assert.rejects(
    resolvePinnedEgressTarget(
      { hostname: "example.com", port: 443 },
      async () => {
        throw new Error("dns unavailable");
      },
    ),
    (error) => hasCode(error, "resolution-failed"),
  );
});

test("resolvePinnedEgressTarget rejects mixed public and non-global answers", async () => {
  await assert.rejects(
    resolvePinnedEgressTarget(
      { hostname: "rebinding.example", port: 443 },
      async () => [
        { address: "8.8.8.8", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
    ),
    (error) => hasCode(error, "non-global-address"),
  );
  await assert.rejects(
    resolvePinnedEgressTarget(
      { hostname: "metadata.example", port: 443 },
      async () => [
        { address: "2606:4700:4700::1111", family: 6 },
        { address: "::ffff:169.254.169.254", family: 6 },
      ],
    ),
    (error) => hasCode(error, "non-global-address"),
  );
});

test("resolvePinnedEgressTarget rejects malformed resolver output and family mismatches", async () => {
  const malformedLookups = [
    async () => [{ address: "not-an-ip", family: 4 as const }],
    async () => [{ address: "8.8.8.8", family: 6 as const }],
    async () => [{ address: "2606:4700:4700::1111", family: 4 as const }],
    async () => [{ address: "", family: 4 as const }],
  ];
  for (const lookup of malformedLookups) {
    await assert.rejects(
      resolvePinnedEgressTarget(
        { hostname: "example.com", port: 443 },
        lookup,
      ),
      (error) => hasCode(error, "resolution-invalid"),
    );
  }
});

test("resolvePinnedEgressTarget normalizes an approved mapped resolver answer for dialing", async () => {
  assert.deepEqual(
    await resolvePinnedEgressTarget(
      { hostname: "example.com", port: 443 },
      async () => [{ address: "::ffff:8.8.4.4", family: 6 }],
    ),
    {
      hostname: "example.com",
      port: 443,
      address: "8.8.4.4",
      family: 4,
    },
  );
});

function hasCode(error: unknown, code: EgressAddressPolicyErrorCode): boolean {
  return error instanceof EgressAddressPolicyError && error.code === code;
}
