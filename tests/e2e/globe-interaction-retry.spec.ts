import { test, expect, type Locator } from '@playwright/test';
import type { PublicCatalog } from '../../shared/contracts.js';
import type { DemoGeometry } from '../../shared/globe.js';
import { prepareDiscovery } from './helpers.js';

type Vector = { x: number; y: number; z: number };
type Rectangle = { x: number; y: number; width: number; height: number };
type ViewOffset = { fullWidth: number; fullHeight: number; offsetX: number; offsetY: number; width: number; height: number };
type VisiblePoint = { id: string; name: string; position: Vector; screen: { x: number; y: number }; pointer: { x: number; y: number }; camera: string };
const dot = (a: Vector, b: Vector) => a.x * b.x + a.y * b.y + a.z * b.z;
const subtract = (a: Vector, b: Vector): Vector => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const cross = (a: Vector, b: Vector): Vector => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const unit = (a: Vector): Vector => { const length = Math.hypot(a.x, a.y, a.z); return { x: a.x / length, y: a.y / length, z: a.z / length }; };
function overlaps(a: Rectangle, b: Rectangle, margin = 0) {
  return a.x < b.x + b.width + margin && a.x + a.width > b.x - margin && a.y < b.y + b.height + margin && a.y + a.height > b.y - margin;
}

/** Independent pinhole projection: published camera pose, specified 45-degree FOV,
 * origin look-at and north-up basis. No renderer hit/selection/projection helper is used. */
function project(position: Vector, camera: Vector, rect: Rectangle, view: ViewOffset | null = null) {
  const forward = unit({ x: -camera.x, y: -camera.y, z: -camera.z });
  const right = unit(cross(forward, { x: 0, y: 1, z: 0 })), up = cross(right, forward);
  const relative = subtract(position, camera), depth = dot(relative, forward);
  if (depth <= .02 || depth >= 40) return null;
  const tangent = Math.tan(22.5 * Math.PI / 180);
  const fullWidth = view?.fullWidth ?? rect.width, fullHeight = view?.fullHeight ?? rect.height;
  const x = dot(relative, right) / (depth * tangent * fullWidth / fullHeight), y = dot(relative, up) / (depth * tangent);
  // Independently crop the specified full pinhole image to the native camera's
  // declared off-axis view. Do not read renderer-computed screen coordinates.
  const localX = ((x + 1) * fullWidth / 2 - (view?.offsetX ?? 0)) / (view?.width ?? rect.width);
  const localY = ((1 - y) * fullHeight / 2 - (view?.offsetY ?? 0)) / (view?.height ?? rect.height);
  if (localX <= 0 || localX >= 1 || localY <= 0 || localY >= 1) return null;
  // Keep the entire camera-to-point segment clear of the unit Earth, with a small
  // limb margin. This avoids using an occluded point as a supposed click fixture.
  const segment = subtract(position, camera), t = Math.max(0, Math.min(1, -dot(camera, segment) / dot(segment, segment)));
  if (Math.hypot(camera.x + segment.x * t, camera.y + segment.y * t, camera.z + segment.z * t) <= 1.01) return null;
  return { x: rect.x + localX * rect.width, y: rect.y + localY * rect.height };
}

async function frames(canvas: Locator) {
  await canvas.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

async function unselectedPointerTarget(stage: Locator, canvas: Locator, geometry: DemoGeometry, catalog: PublicCatalog): Promise<VisiblePoint> {
  const positions = geometry.tracks.map(track => {
    // Held D0 is an exact source knot. Reading that raw knot avoids importing the
    // implementation's evaluation or display projection into this assertion.
    const knot = track.knots.find(value => value.at === geometry.epoch);
    expect(knot, `${track.itemId} has its actual represented-time source knot`).toBeDefined();
    return { id: track.itemId, name: catalog.items.find(item => item.id === track.itemId)!.name,
      position: { x: knot!.direction.x * knot!.radius, y: knot!.direction.y * knot!.radius, z: knot!.direction.z * knot!.radius } };
  });
  // Deliberate keyboard rotation is an ordinary user route to a currently visible
  // point, not a selection shortcut. Never read a reticle/app selection callback.
  for (let turn = 0; turn < 32; turn++) {
    await frames(canvas);
    const camera = (await canvas.getAttribute('data-camera-position'))!;
    const [x, y, z] = JSON.parse(camera) as number[];
    const rect = (await canvas.boundingBox())!, frame = (await stage.boundingBox())!, hud = (await stage.locator('.globe-hud').boundingBox())!;
    const drawn = new Set(((await canvas.getAttribute('data-drawable-ids')) ?? '').split(','));
    for (const object of positions) {
      if (!drawn.has(object.id)) continue;
      const point = project(object.position, { x: x!, y: y!, z: z! }, rect);
      if (!point) continue;
      const reticle = { x: point.x - 22, y: point.y - 22, width: 44, height: 44 };
      if (reticle.x < frame.x + 8 || reticle.y < frame.y + 8 || reticle.x + 44 > frame.x + frame.width - 8 || reticle.y + 44 > frame.y + frame.height - 8 || overlaps(reticle, hud, 8)) continue;
      // Ten pixels misses the tiny unselected sprite but remains well inside the
      // specified 44px target. Both engines receive the same whole CSS pixel.
      for (const offset of [{ x: 10, y: 0 }, { x: -10, y: 0 }, { x: 0, y: 10 }, { x: 0, y: -10 }]) {
        const pointer = { x: Math.round(point.x + offset.x), y: Math.round(point.y + offset.y) };
        const accessible = await canvas.evaluate((node, at) => document.elementFromPoint(at.x, at.y) === node, pointer);
        if (accessible) return { ...object, screen: point, pointer, camera };
      }
    }
    await canvas.focus(); await canvas.press('ArrowRight');
  }
  throw new Error('No source-defined unselected satellite was exposed clear of the HUD after one deliberate camera turn.');
}

for (const width of [1440, 1024, 768]) {
  test(`pointer selects an unselected satellite's 44px target; Follow and Stop remain usable at ${width}px @slice-07`, async ({ page }, info) => {
    // This case also resizes, expands/collapses the HUD and resets the camera.
    // Give that whole software-rendered sequence time without relaxing actions.
    if (width === 1440) test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 1000 }); await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/'); await prepareDiscovery(page, 'SAR imagery with maximum ground resolution 10 m.');
    await page.getByRole('button', { name: 'Globe view', exact: true }).click();
    const stage = page.getByRole('region', { name: 'Public demonstration geometry', exact: true });
    const canvas = stage.locator('canvas[aria-label="Demonstration Earth globe"]');
    await expect(canvas).toHaveAttribute('data-texture', 'ready');
    await expect(stage.getByRole('button', { name: 'Follow selected', exact: true })).toBeDisabled();
    await expect(stage.locator('.globe-selected-reticle')).toHaveCount(0);
    await stage.getByRole('combobox', { name: 'Show orbits for', exact: true }).selectOption('all');
    await stage.getByRole('button', { name: 'Reset view', exact: true }).click();
    const catalogResponse = await page.request.get('/api/public/catalog'), geometryResponse = await page.request.get('/api/public/geometry');
    expect(catalogResponse.ok()).toBe(true); expect(geometryResponse.ok()).toBe(true);
    const catalog = await catalogResponse.json() as PublicCatalog, geometry = await geometryResponse.json() as DemoGeometry;
    await expect(stage).toHaveAttribute('data-represented-utc', geometry.epoch);
    const chosen = await unselectedPointerTarget(stage, canvas, geometry, catalog);
    await expect(stage.locator('.globe-selected-reticle')).toHaveCount(0);
    await page.mouse.move(chosen.pointer.x, chosen.pointer.y);
    await frames(canvas);
    const hoverName = stage.locator('.globe-hover-card strong');
    const hoveredName = await hoverName.count() ? await hoverName.textContent() : null;
    await page.mouse.click(chosen.pointer.x, chosen.pointer.y);
    const details = page.getByRole(width < 1024 ? 'dialog' : 'complementary', { name: 'Discovery details', exact: true });
    await expect(details.getByRole('heading', { name: chosen.name, exact: true })).toBeVisible();
    expect(hoveredName, 'The same unselected 44px pointer target exposes this satellite before selection').toBe(chosen.name);
    await expect(details.getByText(chosen.id, { exact: true })).toBeVisible();
    await details.getByRole('button', { name: 'Close Discovery details', exact: true }).click();
    await expect(details).toHaveCount(0); await expect(page.locator('#root')).toHaveJSProperty('inert', false);
    await frames(canvas);
    await expect(canvas).toHaveAttribute('data-camera-position', chosen.camera);
    const reticle = stage.locator('.globe-selected-reticle'); await expect(reticle).toBeVisible();
    const initialReticle = (await reticle.boundingBox())!;
    expect(initialReticle.width).toBe(44); expect(initialReticle.height).toBe(44);
    expect(Math.abs(initialReticle.x + 22 - chosen.screen.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(initialReticle.y + 22 - chosen.screen.y)).toBeLessThanOrEqual(1);
    expect(overlaps(initialReticle, (await stage.locator('.globe-hud').boundingBox())!)).toBe(false);
    const follow = stage.getByRole('button', { name: 'Follow selected', exact: true }); await expect(follow).toBeEnabled();
    await follow.click();
    const stop = stage.getByRole('button', { name: 'Stop following', exact: true }); await expect(stop).toBeVisible();
    await expect(canvas).not.toHaveAttribute('data-camera-position', chosen.camera);
    await frames(canvas); await expect(reticle).toBeVisible();
    const followedReticle = (await reticle.boundingBox())!;
    let followedCamera = (await canvas.getAttribute('data-camera-position'))!;
    const [followX, followY, followZ] = JSON.parse(followedCamera) as number[];
    let followedView = (await canvas.getAttribute('data-view-offset'))!;
    const followedPoint = project(chosen.position, { x: followX!, y: followY!, z: followZ! }, (await canvas.boundingBox())!, JSON.parse(followedView) as ViewOffset | null);
    expect(followedPoint, 'Follow keeps this exact source point in the visible camera frame').not.toBeNull();
    expect(Math.abs(followedReticle.x + 22 - followedPoint!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(followedReticle.y + 22 - followedPoint!.y)).toBeLessThanOrEqual(1);
    expect(overlaps(followedReticle, (await stage.locator('.globe-hud').boundingBox())!), 'Following must leave the selected marker visible outside the controls').toBe(false);
    await expect(page.getByRole('region', { name: 'Discovery query results', exact: true }).getByText('No area applied', { exact: true })).toBeVisible();
    await expect(stage).toHaveAttribute('data-represented-utc', geometry.epoch);
    if (width === 1440) {
      await page.setViewportSize({ width: 1024, height: 1000 }); await frames(canvas);
      for (const expanded of [true, false]) {
        await stage.getByRole('button', { name: 'Orbit details', exact: true }).click();
        await expect(stage.getByRole('button', { name: 'Orbit details', exact: true })).toHaveAttribute('aria-pressed', String(expanded));
        await frames(canvas); const marker = (await reticle.boundingBox())!, controls = (await stage.locator('.globe-hud').boundingBox())!;
        expect(overlaps(marker, controls), 'Resize and expanded details keep the selected point clear of controls').toBe(false);
        const [x, y, z] = JSON.parse((await canvas.getAttribute('data-camera-position'))!) as number[];
        const at = project(chosen.position, { x: x!, y: y!, z: z! }, (await canvas.boundingBox())!, JSON.parse((await canvas.getAttribute('data-view-offset'))!) as ViewOffset | null);
        expect(at).not.toBeNull(); expect(Math.abs(marker.x + 22 - at!.x)).toBeLessThanOrEqual(1); expect(Math.abs(marker.y + 22 - at!.y)).toBeLessThanOrEqual(1);
      }
      followedCamera = (await canvas.getAttribute('data-camera-position'))!; followedView = (await canvas.getAttribute('data-view-offset'))!;
      await expect(stage).toHaveAttribute('data-represented-utc', geometry.epoch);
      await expect(page.getByRole('region', { name: 'Discovery query results', exact: true }).getByText('No area applied', { exact: true })).toBeVisible();
    }
    await stop.click(); await expect(follow).toBeVisible(); await frames(canvas);
    await frames(canvas); await expect(canvas).toHaveAttribute('data-camera-position', followedCamera);
    await expect(canvas).toHaveAttribute('data-view-offset', followedView);
    await expect(stage.getByRole('button', { name: 'Resume rotation', exact: true })).toBeVisible();
    if (width === 1440) {
      await stage.getByRole('button', { name: 'Reset view', exact: true }).click(); await frames(canvas); await expect(canvas).toHaveAttribute('data-view-offset', 'null');
      const pose = JSON.parse((await canvas.getAttribute('data-camera-position'))!) as number[], radians = Math.PI / 180;
      [3.3 * Math.cos(18 * radians) * Math.cos(35 * radians), 3.3 * Math.sin(18 * radians), -3.3 * Math.cos(18 * radians) * Math.sin(35 * radians)].forEach((value, index) => expect(pose[index]).toBeCloseTo(value, 12));
    }
    await page.screenshot({ path: info.outputPath(`actual-pointer-follow-${width}.png`) });
  });
}
