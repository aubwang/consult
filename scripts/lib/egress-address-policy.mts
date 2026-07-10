import { BlockList, isIP } from "node:net";
import { domainToASCII } from "node:url";

export type EgressAddressFamily = 4 | 6;

export interface EgressLookupAddress {
  address: string;
  family: EgressAddressFamily;
}

export type EgressLookup = (
  hostname: string,
) => Promise<readonly EgressLookupAddress[]>;

export interface PinnedEgressTarget {
  hostname: string;
  port: 443;
  address: string;
  family: EgressAddressFamily;
}

export type EgressAddressPolicyErrorCode =
  | "invalid-hostname"
  | "port-not-allowed"
  | "resolution-failed"
  | "resolution-empty"
  | "resolution-invalid"
  | "non-global-address";

export class EgressAddressPolicyError extends Error {
  readonly code: EgressAddressPolicyErrorCode;

  constructor(code: EgressAddressPolicyErrorCode, message: string) {
    super(message);
    this.name = "EgressAddressPolicyError";
    this.code = code;
  }
}

export interface ClassifiedEgressAddress {
  address: string;
  family: EgressAddressFamily;
  sourceFamily: EgressAddressFamily;
  isGlobal: boolean;
}

const NON_GLOBAL_IPV4 = buildBlockList("ipv4", [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["192.175.48.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
]);

const GLOBAL_IPV6 = buildBlockList("ipv6", [["2000::", 3]]);
const NON_GLOBAL_IPV6 = buildBlockList("ipv6", [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["2620:4f:8000::", 48],
  ["3fff::", 20],
]);

/**
 * Normalize a URL hostname without allowing URL syntax to leak into the host
 * field. DNS names are returned as lower-case ASCII without a trailing root
 * dot; IP literals are returned in canonical form.
 */
export function normalizeEgressHostname(rawHostname: string): string {
  if (
    rawHostname.length === 0 ||
    rawHostname.length > 1_024 ||
    rawHostname !== rawHostname.trim() ||
    /[\u0000-\u0020\u007f]/u.test(rawHostname) ||
    /[/?#@\\%]/u.test(rawHostname)
  ) {
    throw invalidHostname(rawHostname);
  }

  const bracketed = /^\[([^\]]+)\]$/u.exec(rawHostname);
  if (bracketed) {
    const normalized = normalizeIpLiteral(bracketed[1]);
    if (!normalized || normalized.sourceFamily !== 6) {
      throw invalidHostname(rawHostname);
    }
    return normalized.address;
  }
  if (rawHostname.includes("[") || rawHostname.includes("]")) {
    throw invalidHostname(rawHostname);
  }

  const directIp = normalizeIpLiteral(rawHostname);
  if (directIp) {
    return directIp.address;
  }
  if (rawHostname.includes(":")) {
    throw invalidHostname(rawHostname);
  }

  let parsedHostname: string;
  try {
    const parsed = new URL(`http://${rawHostname}/`);
    if (
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      throw invalidHostname(rawHostname);
    }
    parsedHostname = parsed.hostname;
  } catch (error) {
    if (error instanceof EgressAddressPolicyError) {
      throw error;
    }
    throw invalidHostname(rawHostname);
  }

  const ascii = domainToASCII(parsedHostname.replace(/\.$/u, "")).toLowerCase();
  if (!ascii || ascii.length > 253) {
    throw invalidHostname(rawHostname);
  }

  const parsedIp = normalizeIpLiteral(ascii);
  if (parsedIp) {
    return parsedIp.address;
  }

  const labels = ascii.split(".");
  if (
    labels.length < 2 ||
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
    )
  ) {
    throw invalidHostname(rawHostname);
  }
  return ascii;
}

/**
 * Classify one literal address. IPv4-mapped IPv6 is reduced to its effective
 * IPv4 address so the IPv4 special-use policy cannot be bypassed through a
 * mapped spelling.
 */
export function classifyEgressAddress(address: string): ClassifiedEgressAddress {
  const normalized = normalizeIpLiteral(address);
  if (!normalized) {
    throw new EgressAddressPolicyError(
      "resolution-invalid",
      `resolver returned an invalid IP address: ${JSON.stringify(address)}`,
    );
  }

  const isGlobal =
    normalized.family === 4
      ? !NON_GLOBAL_IPV4.check(normalized.address, "ipv4")
      : GLOBAL_IPV6.check(normalized.address, "ipv6") &&
        !NON_GLOBAL_IPV6.check(normalized.address, "ipv6");
  return { ...normalized, isGlobal };
}

/**
 * Resolve and authorize a destination once, then return a literal address for
 * the caller to dial. Every resolver answer must be valid and globally
 * routable; a public/private mixture is rejected rather than filtered.
 */
export async function resolvePinnedEgressTarget(
  target: { hostname: string; port: number },
  lookup: EgressLookup,
): Promise<PinnedEgressTarget> {
  if (!Number.isInteger(target.port) || target.port !== 443) {
    throw new EgressAddressPolicyError(
      "port-not-allowed",
      `egress port is not allowed: ${JSON.stringify(target.port)}`,
    );
  }

  const hostname = normalizeEgressHostname(target.hostname);
  const literalFamily = isIP(hostname) as 0 | EgressAddressFamily;
  if (literalFamily !== 0) {
    const classified = classifyEgressAddress(hostname);
    if (!classified.isGlobal) {
      throw nonGlobalAddress(hostname);
    }
    return {
      hostname,
      port: 443,
      address: classified.address,
      family: classified.family,
    };
  }

  let answers: readonly EgressLookupAddress[];
  try {
    answers = await lookup(hostname);
  } catch {
    throw new EgressAddressPolicyError(
      "resolution-failed",
      `failed to resolve egress hostname: ${JSON.stringify(hostname)}`,
    );
  }
  if (!Array.isArray(answers) || answers.length === 0) {
    throw new EgressAddressPolicyError(
      "resolution-empty",
      `resolver returned no addresses for: ${JSON.stringify(hostname)}`,
    );
  }

  const classifiedAnswers = answers.map((answer) => {
    if (
      !answer ||
      typeof answer.address !== "string" ||
      (answer.family !== 4 && answer.family !== 6)
    ) {
      throw new EgressAddressPolicyError(
        "resolution-invalid",
        `resolver returned a malformed address for: ${JSON.stringify(hostname)}`,
      );
    }
    const classified = classifyEgressAddress(answer.address);
    if (classified.sourceFamily !== answer.family) {
      throw new EgressAddressPolicyError(
        "resolution-invalid",
        `resolver returned an address-family mismatch for: ${JSON.stringify(hostname)}`,
      );
    }
    if (!classified.isGlobal) {
      throw nonGlobalAddress(classified.address);
    }
    return classified;
  });

  const pinned = classifiedAnswers[0];
  return {
    hostname,
    port: 443,
    address: pinned.address,
    family: pinned.family,
  };
}

interface NormalizedIpAddress {
  address: string;
  family: EgressAddressFamily;
  sourceFamily: EgressAddressFamily;
}

function normalizeIpLiteral(address: string): NormalizedIpAddress | null {
  const sourceFamily = isIP(address) as 0 | EgressAddressFamily;
  if (sourceFamily === 0 || address.includes("%")) {
    return null;
  }
  if (sourceFamily === 4) {
    return { address, family: 4, sourceFamily: 4 };
  }

  let canonical: string;
  try {
    canonical = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
  const bytes = ipv6Bytes(canonical);
  if (!bytes) {
    return null;
  }
  if (
    bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff
  ) {
    return {
      address: `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`,
      family: 4,
      sourceFamily: 6,
    };
  }
  return { address: canonical, family: 6, sourceFamily: 6 };
}

function ipv6Bytes(address: string): Uint8Array | null {
  const halves = address.split("::");
  if (halves.length > 2) {
    return null;
  }
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (
    [...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/iu.test(part)) ||
    (halves.length === 1 && left.length !== 8) ||
    (halves.length === 2 && left.length + right.length >= 8)
  ) {
    return null;
  }
  const parts = [
    ...left,
    ...Array(8 - left.length - right.length).fill("0"),
    ...right,
  ];
  const bytes = new Uint8Array(16);
  for (const [index, part] of parts.entries()) {
    const value = Number.parseInt(part, 16);
    bytes[index * 2] = value >> 8;
    bytes[index * 2 + 1] = value & 0xff;
  }
  return bytes;
}

function buildBlockList(
  family: "ipv4" | "ipv6",
  subnets: ReadonlyArray<readonly [string, number]>,
): BlockList {
  const blockList = new BlockList();
  for (const [network, prefix] of subnets) {
    blockList.addSubnet(network, prefix, family);
  }
  return blockList;
}

function invalidHostname(rawHostname: string): EgressAddressPolicyError {
  return new EgressAddressPolicyError(
    "invalid-hostname",
    `invalid egress hostname: ${JSON.stringify(rawHostname)}`,
  );
}

function nonGlobalAddress(address: string): EgressAddressPolicyError {
  return new EgressAddressPolicyError(
    "non-global-address",
    `egress destination resolved to a non-global address: ${JSON.stringify(address)}`,
  );
}
