/**
 * Shared "is this host on a private/internal network" check, used by both
 * fetch_url (src/tools/fetchUrl.ts) and the MCP HTTP transport guard
 * (src/mcp/client.ts) so the two SSRF chokepoints can't silently drift apart.
 */
export function isPrivateOrLoopbackHost(rawHost: string): boolean {
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "0.0.0.0" || host === "::1" || host === "::") return true;
  // IPv4 private / loopback / link-local ranges, incl. cloud metadata (169.254.169.254).
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 10 ||
      a === 127 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 169 && b === 254) ||
      a === 0
    );
  }
  // IPv6 loopback / unique-local (fc00::/7) / link-local (fe80::/10).
  if (host.includes(":") && /^(fc|fd|fe8|fe9|fea|feb)/.test(host)) return true;
  return false;
}

/** Loopback only — used where private-but-routable (e.g. LAN) hosts are still acceptable. */
export function isLoopbackHost(rawHost: string): boolean {
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost")
  );
}
