/** All sizes/pointers are CSS pixels; normalized image coordinates retain full precision. */
export interface Size { width: number; height: number }
export interface Point { x: number; y: number }
export interface ViewTransform { zoom: number; centerX: number; centerY: number; fitted: boolean }
export function fitView(): ViewTransform { return { zoom: 1, centerX: 0.5, centerY: 0.5, fitted: true }; }
function validSize(size: Size): boolean { return Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0; }
export function geometry(view: ViewTransform, image: Size, stage: Size): { scale: number; tx: number; ty: number } {
  if (!validSize(image) || !validSize(stage) || !Number.isFinite(view.zoom) || view.zoom <= 0 || !Number.isFinite(view.centerX) || !Number.isFinite(view.centerY)) throw new Error('Image and stage dimensions and view must be finite and positive.');
  const scale = Math.min(stage.width / image.width, stage.height / image.height) * view.zoom;
  return { scale, tx: stage.width / 2 - view.centerX * image.width * scale, ty: stage.height / 2 - view.centerY * image.height * scale };
}
export function zoomAt(view: ViewTransform, factor: number, pointer: Point, image: Size, stage: Size): ViewTransform {
  if (!Number.isFinite(factor) || factor <= 0 || !Number.isFinite(pointer.x) || !Number.isFinite(pointer.y)) return { ...view };
  const before = geometry(view, image, stage), zoom = Math.max(0.1, Math.min(20, view.zoom * factor));
  const scale = Math.min(stage.width / image.width, stage.height / image.height) * zoom;
  const x = (pointer.x - before.tx) / before.scale, y = (pointer.y - before.ty) / before.scale;
  return { zoom, centerX: (x - (pointer.x - stage.width / 2) / scale) / image.width,
    centerY: (y - (pointer.y - stage.height / 2) / scale) / image.height, fitted: false };
}
export function panBy(view: ViewTransform, dx: number, dy: number, image: Size, stage: Size): ViewTransform {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return { ...view };
  const { scale } = geometry(view, image, stage);
  return { zoom: view.zoom, centerX: view.centerX - dx / (scale * image.width), centerY: view.centerY - dy / (scale * image.height), fitted: false };
}
export function inversePoint(view: ViewTransform, pointer: Point, image: Size, stage: Size): Point | null {
  if (!Number.isFinite(pointer.x) || !Number.isFinite(pointer.y) || pointer.x < 0 || pointer.y < 0 || pointer.x > stage.width || pointer.y > stage.height) return null;
  let transform: ReturnType<typeof geometry>;
  try { transform = geometry(view, image, stage); } catch { return null; }
  const x = (pointer.x - transform.tx) / (image.width * transform.scale), y = (pointer.y - transform.ty) / (image.height * transform.scale);
  return x < 0 || x > 1 || y < 0 || y > 1 ? null : { x, y };
}
/** Maps a saved normalized point through the same transform as its exact image. */
export function forwardPoint(view: ViewTransform, point: Point, image: Size, stage: Size): Point | null {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) return null;
  try {
    const { scale, tx, ty } = geometry(view, image, stage);
    return { x: tx + point.x * image.width * scale, y: ty + point.y * image.height * scale };
  } catch { return null; }
}
/** Track maximum excursion during a gesture so dragging out and back is not a click. */
export function isPointClick(start: Point, end: Point, maximumExcursion = 0): boolean {
  if (![start.x, start.y, end.x, end.y, maximumExcursion].every(Number.isFinite) || maximumExcursion < 0) return false;
  return Math.max(Math.hypot(end.x - start.x, end.y - start.y), maximumExcursion) < 6;
}
export function canLinkNavigation(first: Size, second: Size): boolean { return validSize(first) && validSize(second) && first.width === second.width && first.height === second.height; }
