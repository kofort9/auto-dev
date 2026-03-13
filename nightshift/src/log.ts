/**
 * Shared logging and duration formatting for nightshift modules.
 */

/** Create a prefixed logger. Each module gets its own tag (e.g., "[nightshift]", "[nightshift:panel]"). */
export function createLogger(tag: string): (msg: string) => void {
  return function log(msg: string): void {
    const time = new Date().toLocaleTimeString("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    console.log(`[${tag}] ${time} ${msg}`);
  };
}

/** Format seconds into human-readable duration (e.g., "2h 15m", "3m 42s", "17s"). */
export function formatDuration(s: number): string {
  if (s >= 3600) {
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  }
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${s}s`;
}
