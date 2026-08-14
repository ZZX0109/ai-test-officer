export type PagePoint = { x: number; y: number; imageWidth: number; imageHeight: number };
export type DrawState = PagePoint & { left: number; top: number; width: number; height: number };

export function pointInSharedBrowser(clientX: number, clientY: number, bounds: DOMRect, draw: DrawState): PagePoint | null {
  const localX = clientX - bounds.left;
  const localY = clientY - bounds.top;
  if (localX < draw.left || localX > draw.left + draw.width || localY < draw.top || localY > draw.top + draw.height) return null;
  return {
    x: (localX - draw.left) / draw.width * draw.imageWidth,
    y: (localY - draw.top) / draw.height * draw.imageHeight,
    imageWidth: draw.imageWidth,
    imageHeight: draw.imageHeight
  };
}
