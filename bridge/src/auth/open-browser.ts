/**
 * Best-effort default-browser opener, ported from the darwin branch of OMP
 * packages/coding-agent/src/utils/open.ts @ 8500092.
 *
 * Kept from the OMP source: spawn `open <url>` with all stdio ignored, never
 * throw (the caller still has the URL as a copy fallback).
 *
 * Deviations from the OMP source (with reasons):
 * - Only the darwin opener is ported; the bridge targets macOS.
 * - The opener is a parameter injection point rather than a module-global
 *   override, and the non-zero-exit warning telemetry is dropped because this
 *   module has no logger dependency.
 */

export type BrowserOpener = (url: string) => void;

/** Spawn macOS `open <url>`; best-effort, never throws. */
export function spawnMacOpen(url: string): void {
  Bun.spawn(["open", url], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
}

export const defaultBrowserOpener: BrowserOpener = spawnMacOpen;

/**
 * Open a URL in the default browser. Best-effort and never throws; `opener`
 * is injectable so tests and alternate hosts can capture the URL instead of
 * spawning a process.
 */
export function openInBrowser(url: string, opener: BrowserOpener = defaultBrowserOpener): void {
  try {
    opener(url);
  } catch {
    // Deliberately best-effort (OMP openPath contract): a failed opener must
    // not abort the login flow that still has the URL to show the user.
  }
}
