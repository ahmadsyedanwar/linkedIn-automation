/**
 * LinkedIn session / URL helpers (no Playwright dependency).
 */

export function isLoggedInUrl(url: string): boolean {
  return (
    !url.includes("/login") &&
    !url.includes("/checkpoint") &&
    !url.includes("/uas/")
  );
}

export function extractThreadIdFromMessagingUrl(url: string): string | null {
  const m = url.match(/\/messaging\/thread\/([^/?#]+)/);
  return m ? m[1] : null;
}
