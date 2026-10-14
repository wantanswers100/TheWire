// wire weather — current conditions via wttr.in (free, no API key, auto-detects location from IP)
//
// Usage:
//   wire weather                  # auto-detect location from IP
//   wire weather Dallas           # specific city
//   wire weather "Dallas, TX"     # city + state
//   wire weather 75001            # US ZIP code (wttr.in supports these natively)
//   wire weather --format <1|2|3|4|v2>  # output format (default: v2)

export async function runWeather(args: string[]): Promise<void> {
  if (args[0] === "--help" || args[0] === "-h") {
    console.log(`wire weather — current weather via wttr.in (free, no API key)

Usage:
  wire weather                  Auto-detect location from IP
  wire weather <city>           Specific city
  wire weather <ZIP>            US ZIP code
  wire weather "City, State"    City + state/country

Formats (--format flag):
  v2   Compact 2-line summary (default)
  1    One line: condition only
  3    One line: city + temp + condition
  4    One line: city + conditions + wind

Examples:
  wire weather
  wire weather London
  wire weather 75001
  wire weather "New York, NY"
  wire weather Tokyo --format 3`);
    return;
  }

  // Parse --format flag
  let format = "v2";
  const formatIdx = args.indexOf("--format");
  const filteredArgs = [...args];
  if (formatIdx !== -1) {
    format = filteredArgs[formatIdx + 1] ?? "v2";
    filteredArgs.splice(formatIdx, 2);
  }

  const location = filteredArgs.join(" ").trim();
  const encodedLoc = location ? encodeURIComponent(location) : "";
  const url = `https://wttr.in/${encodedLoc}?format=${encodeURIComponent(format)}&lang=en`;

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "wire-cli/1.0 (curl)" },
      signal: AbortSignal.timeout(8_000),
    });

    if (!res.ok) {
      console.error(`[weather] wttr.in returned ${res.status} — try a different location`);
      process.exit(1);
    }

    const text = (await res.text()).trim();
    if (!text) {
      console.error("[weather] Empty response from wttr.in");
      process.exit(1);
    }

    console.log(text);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("abort") || msg.includes("timeout")) {
      console.error("[weather] Request timed out — check network connectivity");
    } else {
      console.error(`[weather] ${msg}`);
    }
    process.exit(1);
  }
}
