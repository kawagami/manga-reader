// Double mode pairs page N (right, manga order) with page N+1 (left). A
// landscape page is already a full spread, so it can't share one — checking
// only the lead page would squeeze a landscape N+1 into half a spread.
//
// Navigation (App) and rendering/preload (Viewer) must agree on this, hence one
// shared function. Orientation is unknown until an image loads; unknown is
// treated as portrait so a spread pairs optimistically and collapses once the
// landscape half reports in.
export function spreadStride(
  images: string[],
  landscape: Map<string, boolean>,
  page: number,
  doubleMode: boolean,
): number {
  if (!doubleMode) return 1;
  if (page + 1 >= images.length) return 1;
  if (landscape.get(images[page]) === true) return 1;
  if (landscape.get(images[page + 1]) === true) return 1;
  return 2;
}

// Where paging forward from page 0 comes to rest — the "last page" target.
// Clamping to images.length - 1 instead shows the final page alone in double
// mode and shifts every spread's pairing by one on the way back.
export function lastSpreadStart(
  images: string[],
  landscape: Map<string, boolean>,
  doubleMode: boolean,
): number {
  let p = 0;
  for (;;) {
    const next = p + spreadStride(images, landscape, p, doubleMode);
    if (next > images.length - 1) return p;
    p = next;
  }
}
