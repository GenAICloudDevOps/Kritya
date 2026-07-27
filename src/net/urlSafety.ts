/**
 * Shared "is this host on a private/internal network" check, used by both
 * fetch_url (src/tools/fetchUrl.ts) and the MCP HTTP transport guard
 * (src/mcp/client.ts) so the two SSRF chokepoints can't silently drift apart.
 */
function isPrivateIPv4Parts(a: number, b: number): boolean {
  return (
    a === 10 ||
    a === 127 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 169 && b === 254) ||
    a === 0
  );
}

function parseIPv4(host: string): [number, number, number, number] | null {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return parts as [number, number, number, number];
}

/**
 * Expands an IPv6 literal (no brackets/zone id) into its 8 16-bit groups, or
 * null if it isn't a valid IPv6 literal. Handles "::" compression and a
 * trailing embedded IPv4 tail (e.g. "::ffff:169.254.169.254").
 */
function parseIPv6Groups(host: string): number[] | null {
  if (!host.includes(":")) return null;

  // Normalize a trailing embedded IPv4 (e.g. "::ffff:169.254.169.254") into
  // two plain hextets first, so the rest of the parser only ever deals with
  // a pure hextet address — no separate bookkeeping for the IPv4 tail.
  let normalized = host;
  const ipv4Tail = host.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (ipv4Tail) {
    const parts = parseIPv4(ipv4Tail[1]);
    if (!parts) return null;
    const g1 = (((parts[0] << 8) | parts[1]) >>> 0).toString(16);
    const g2 = (((parts[2] << 8) | parts[3]) >>> 0).toString(16);
    normalized = host.slice(0, host.length - ipv4Tail[1].length) + g1 + ":" + g2;
  }

  const sides = normalized.split("::");
  if (sides.length > 2) return null;

  const parseHextets = (s: string): number[] | null => {
    if (s === "") return [];
    const hextets = s.split(":");
    const nums: number[] = [];
    for (const h of hextets) {
      if (!/^[0-9a-f]{1,4}$/.test(h)) return null;
      nums.push(parseInt(h, 16));
    }
    return nums;
  };

  if (sides.length === 1) {
    const groups = parseHextets(sides[0]);
    return groups && groups.length === 8 ? groups : null;
  }

  const left = parseHextets(sides[0]);
  const right = parseHextets(sides[1]);
  if (!left || !right) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  return [...left, ...Array<number>(missing).fill(0), ...right];
}

function isPrivateOrLoopbackIPv6Groups(groups: number[]): boolean {
  const allZero = (from: number, to: number) => groups.slice(from, to).every((g) => g === 0);

  // ::1 loopback and :: unspecified.
  if (allZero(0, 7) && (groups[7] === 0 || groups[7] === 1)) return true;
  // fc00::/7 unique-local.
  if ((groups[0] & 0xfe00) === 0xfc00) return true;
  // fe80::/10 link-local.
  if ((groups[0] & 0xffc0) === 0xfe80) return true;
  // IPv4-mapped (::ffff:a.b.c.d) and deprecated IPv4-compatible (::a.b.c.d) —
  // both embed a real IPv4 address in the low 32 bits and must be judged by
  // that address's range, not treated as "just IPv6" and allowed through.
  if (allZero(0, 5) && (groups[5] === 0 || groups[5] === 0xffff)) {
    const a = (groups[6] >> 8) & 0xff;
    const b = groups[6] & 0xff;
    return isPrivateIPv4Parts(a, b);
  }
  return false;
}

function isLoopbackIPv6Groups(groups: number[]): boolean {
  const allZero = (from: number, to: number) => groups.slice(from, to).every((g) => g === 0);
  if (allZero(0, 7) && groups[7] === 1) return true;
  // IPv4-mapped/compatible loopback, e.g. ::ffff:127.0.0.1.
  if (allZero(0, 5) && (groups[5] === 0 || groups[5] === 0xffff)) {
    return groups[6] >> 8 === 127;
  }
  return false;
}

export function isPrivateOrLoopbackHost(rawHost: string): boolean {
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;

  const v4 = parseIPv4(host);
  if (v4) return isPrivateIPv4Parts(v4[0], v4[1]);

  const v6 = parseIPv6Groups(host);
  if (v6) return isPrivateOrLoopbackIPv6Groups(v6);

  return false;
}

/** Loopback only — used where private-but-routable (e.g. LAN) hosts are still acceptable. */
export function isLoopbackHost(rawHost: string): boolean {
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;

  const v4 = parseIPv4(host);
  if (v4) return v4[0] === 127;

  const v6 = parseIPv6Groups(host);
  if (v6) return isLoopbackIPv6Groups(v6);

  return false;
}
