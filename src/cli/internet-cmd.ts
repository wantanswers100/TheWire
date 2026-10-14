// wire internet — full network information: interfaces, IPs, MACs, gateway, DNS, public IP

import { networkInterfaces } from "node:os";
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

function ok(s: string): string   { return `\x1b[32m${s}\x1b[0m`; }
function warn(s: string): string { return `\x1b[33m${s}\x1b[0m`; }
function dim(s: string): string  { return `\x1b[2m${s}\x1b[0m`; }
function bold(s: string): string { return `\x1b[1m${s}\x1b[0m`; }
function cyan(s: string): string { return `\x1b[36m${s}\x1b[0m`; }

// ─── Connectivity check ───────────────────────────────────────────────────────

async function checkConnectivity(): Promise<boolean> {
  try {
    await fetch("https://dns.google", { signal: AbortSignal.timeout(3000) });
    return true;
  } catch {
    return false;
  }
}

// ─── Public IP via ipinfo.io ──────────────────────────────────────────────────

interface IpInfo {
  ip?:       string;
  hostname?: string;
  city?:     string;
  region?:   string;
  country?:  string;
  org?:      string;
  timezone?: string;
  loc?:      string;
}

async function fetchPublicInfo(): Promise<IpInfo | null> {
  try {
    const res = await fetch("https://ipinfo.io/json", {
      signal: AbortSignal.timeout(5000),
      headers: { "Accept": "application/json" },
    });
    if (!res.ok) return null;
    return await res.json() as IpInfo;
  } catch {
    return null;
  }
}

// ─── Default gateway ─────────────────────────────────────────────────────────

function getDefaultGateway(): string {
  try {
    const out = execSync("ip route show default 2>/dev/null", { encoding: "utf8", timeout: 2000 });
    const match = out.match(/via\s+(\S+)/);
    return match?.[1] ?? "unknown";
  } catch {
    return "unknown";
  }
}

// ─── DNS servers ─────────────────────────────────────────────────────────────

function getDnsServers(): string[] {
  try {
    if (!existsSync("/etc/resolv.conf")) return [];
    const lines = readFileSync("/etc/resolv.conf", "utf8").split("\n");
    return lines
      .filter(l => l.startsWith("nameserver"))
      .map(l => l.replace(/^nameserver\s+/, "").trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ─── Hostname ────────────────────────────────────────────────────────────────

function getHostname(): string {
  try {
    return execSync("hostname -f 2>/dev/null || hostname", { encoding: "utf8", timeout: 1000 }).trim();
  } catch {
    return "unknown";
  }
}

// ─── Network interfaces ───────────────────────────────────────────────────────

interface IfaceInfo {
  name:    string;
  mac:     string;
  addrs:   Array<{ family: string; address: string; netmask: string; cidr: string }>;
  isUp:    boolean;
}

function getInterfaces(): IfaceInfo[] {
  const ifaces = networkInterfaces();
  const results: IfaceInfo[] = [];

  for (const [name, entries] of Object.entries(ifaces)) {
    if (!entries || entries.length === 0) continue;

    const mac = entries.find(e => e.mac && e.mac !== "00:00:00:00:00:00")?.mac ?? "—";
    const addrs = entries.map(e => ({
      family:  e.family,
      address: e.address,
      netmask: e.netmask,
      cidr:    e.cidr ?? `${e.address}/${netmaskToCidr(e.netmask)}`,
    }));

    results.push({ name, mac, addrs, isUp: addrs.length > 0 });
  }

  return results.sort((a, b) => {
    // lo last
    if (a.name === "lo") return 1;
    if (b.name === "lo") return -1;
    return a.name.localeCompare(b.name);
  });
}

function netmaskToCidr(mask: string): number {
  return mask.split(".").reduce((acc, oct) => {
    let n = parseInt(oct, 10);
    let bits = 0;
    while (n > 0) { bits += n & 1; n >>= 1; }
    return acc + bits;
  }, 0);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export async function runInternet(_args: string[]): Promise<void> {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`${bold("Wire")} ${cyan("Internet")}  ${dim(ts)}`);
  console.log(dim("─".repeat(60)));

  // Connectivity
  const connected = await checkConnectivity();
  console.log(`\n${bold("Connectivity")}`);
  console.log(`  ${connected ? ok("✓  connected") : warn("✗  no internet connection")}`);

  // Hostname
  const hostname = getHostname();
  console.log(`\n${bold("Host")}`);
  console.log(`  hostname    ${cyan(hostname)}`);

  // Network interfaces
  const ifaces = getInterfaces();
  console.log(`\n${bold("Interfaces")}`);

  for (const iface of ifaces) {
    const isLoopback = iface.name === "lo";
    console.log(`\n  ${bold(iface.name)}${isLoopback ? dim("  (loopback)") : ""}`);
    if (iface.mac !== "—") {
      console.log(`    MAC         ${iface.mac}`);
    }
    for (const addr of iface.addrs) {
      const label = addr.family === "IPv4" ? "IPv4" : "IPv6 ";
      console.log(`    ${label}        ${cyan(addr.cidr)}  ${dim(`netmask ${addr.netmask}`)}`);
    }
  }

  // Gateway
  const gateway = getDefaultGateway();
  console.log(`\n${bold("Gateway")}`);
  console.log(`  default     ${cyan(gateway)}`);

  // DNS
  const dns = getDnsServers();
  console.log(`\n${bold("DNS")}`);
  if (dns.length === 0) {
    console.log(dim("  none found in /etc/resolv.conf"));
  } else {
    for (const server of dns) {
      console.log(`  nameserver  ${cyan(server)}`);
    }
  }

  // Public IP
  console.log(`\n${bold("Public IP")}`);
  if (!connected) {
    console.log(dim("  offline — skipping"));
  } else {
    const info = await fetchPublicInfo();
    if (!info) {
      console.log(warn("  could not reach ipinfo.io"));
    } else {
      if (info.ip)       console.log(`  IP          ${cyan(info.ip)}`);
      if (info.hostname) console.log(`  hostname    ${info.hostname}`);
      if (info.org)      console.log(`  ISP / org   ${info.org}`);
      if (info.city || info.region || info.country) {
        const loc = [info.city, info.region, info.country].filter(Boolean).join(", ");
        console.log(`  location    ${loc}`);
      }
      if (info.loc)      console.log(`  coordinates ${info.loc}`);
      if (info.timezone) console.log(`  timezone    ${info.timezone}`);
    }
  }

  console.log();
}
