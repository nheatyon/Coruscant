import { test, expect, type Locator, type Page } from '@playwright/test';
import { PerspectiveCamera, Raycaster, Sphere, Vector2, Vector3 } from 'three';
import type { AreaCircle } from '../../shared/area-proposal.js';
import { chooseDemonstrationCatalog } from './helpers.js';

test.setTimeout(120_000);
const areaControls = (stage: Locator) => stage.getByRole('region', { name: 'Earth area controls', exact: true });
const renderedFrames = (canvas: Locator) => canvas.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
async function openGlobe(page: Page, mode: 'real' | 'demo' = 'demo', width = 1440) {
  await page.setViewportSize({ width, height: 1000 }); await page.emulateMedia({ reducedMotion: 'reduce' }); await page.goto('/');
  if (mode === 'demo') await chooseDemonstrationCatalog(page);
  await page.getByRole('button', { name: 'Globe view', exact: true }).click();
  const stage = page.getByRole('region', { name: mode === 'demo' ? 'Public demonstration geometry' : 'Real orbital prediction', exact: true });
  const canvas = stage.locator('canvas'); await expect(canvas).toBeVisible(); await expect(canvas).toHaveAttribute('data-camera-position', /\[/);
  await expect(areaControls(stage).getByRole('button', { name: 'Rotate', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await stage.getByRole('button', { name: 'Reset view', exact: true }).click(); await renderedFrames(canvas);
  return { stage, canvas };
}
/** Independent screen ray, not the application callback or a forced selected point. */
async function strokePoints(page: Page, stage: Locator, canvas: Locator) {
  const box = (await canvas.boundingBox())!, frame = (await stage.boundingBox())!;
  const position = JSON.parse((await canvas.getAttribute('data-camera-position'))!) as number[], view = JSON.parse((await canvas.getAttribute('data-view-offset'))!);
  const camera = new PerspectiveCamera(45, box.width / box.height, .02, 40); camera.position.set(position[0]!, position[1]!, position[2]!); camera.lookAt(0, 0, 0);
  if (view) camera.setViewOffset(view.fullWidth, view.fullHeight, view.offsetX, view.offsetY, view.width, view.height);
  camera.updateMatrixWorld(true); const ray = new Raycaster(), earth = new Sphere(new Vector3(), 1);
  const point = (x: number, y: number) => { ray.setFromCamera(new Vector2((x - box.x) / box.width * 2 - 1, 1 - (y - box.y) / box.height * 2), camera); const hit = ray.ray.intersectSphere(earth, new Vector3()); return hit && -hit.dot(ray.ray.direction) > .2 ? hit : null; };
  for (let y = Math.max(frame.y + 90, 100); y < Math.min(frame.y + frame.height - 160, 850); y += 36) for (let x = Math.max(frame.x + 28, 28); x < Math.min(frame.x + frame.width - 40, 1380); x += 36) {
    const start = { x: Math.round(x), y: Math.round(y) }, end = { x: Math.round(x + 8), y: Math.round(y + 4) };
    const first = point(start.x, start.y), second = point(end.x, end.y); if (!first || !second) continue;
    const radius = 6371.0088 * Math.atan2(first.clone().cross(second).length(), first.dot(second)); if (radius < 10 || radius > 450) continue;
    const unobstructed = await canvas.evaluate((node, value) => [value.start, value.end].every(p => document.elementFromPoint(p.x, p.y) === node), { start, end }); if (!unobstructed) continue;
    await page.mouse.move(start.x, start.y); await renderedFrames(canvas);
    if (!await stage.locator('.globe-ground-card').isVisible()) continue;
    let farEnd: { x: number; y: number } | null = null;
    for (const [dx, dy] of [[100, 60], [-100, 60], [100, -60], [-100, -60], [0, 100], [0, -100]]) {
      const candidate = { x: start.x + dx!, y: start.y + dy! }, v = point(candidate.x, candidate.y); if (!v || 6371.0088 * Math.atan2(first.clone().cross(v).length(), first.dot(v)) < 600) continue;
      if (await canvas.evaluate((node, p) => document.elementFromPoint(p.x, p.y) === node, candidate)) { farEnd = candidate; break; }
    }
    return { start, end, radius, farEnd };
  }
  throw new Error('No unobstructed near-side Earth stroke was available in the rendered view.');
}
async function draw(page: Page, stage: Locator, canvas: Locator) {
  const points = await strokePoints(page, stage, canvas);
  await areaControls(stage).getByRole('button', { name: 'Select area', exact: true }).click(); await expect(canvas).toHaveAttribute('data-area-mode', 'select');
  await page.mouse.move(points.start.x, points.start.y); await page.mouse.down(); await page.mouse.move(points.end.x, points.end.y, { steps: 4 }); await page.mouse.up();
  await expect(areaControls(stage).getByRole('region', { name: 'Proposed area', exact: true })).toBeVisible();
  const circle = JSON.parse((await canvas.getAttribute('data-area-preview'))!) as AreaCircle;
  expect(circle.radiusKm).toBeGreaterThanOrEqual(1); expect(circle.radiusKm).toBeLessThanOrEqual(500);
  expect(Math.abs(circle.radiusKm - points.radius)).toBeLessThan(1.5);
  return { ...points, circle };
}

test('canceling a drawn proposal through the brief clears the stale globe hint without changing the applied target @r022', async ({ page }) => {
  const { stage, canvas } = await openGlobe(page);
  const before = await canvas.getAttribute('data-applied-target');
  await draw(page, stage, canvas);
  await expect(stage.locator('.globe-area-notice')).toContainText('Proposed area.');
  await areaControls(stage).getByRole('button', { name: 'Adjust coordinates and radius', exact: true }).click();
  const brief = page.getByRole('dialog', { name: 'Your request', exact: true });
  await brief.getByRole('button', { name: 'Cancel proposal', exact: true }).click();
  await brief.getByRole('button', { name: 'Keep brief and close', exact: true }).click();
  await expect(areaControls(stage).getByRole('region', { name: 'Proposed area', exact: true })).toHaveCount(0);
  await expect(stage.locator('.globe-area-notice').filter({ hasText: 'Proposed area. The brief and its confirmation have not changed.' })).toHaveCount(0);
  await expect(canvas).toHaveAttribute('data-applied-target', before!);
});

test('both public layers draw a frozen-camera preview, then explicitly apply and separately confirm that same circle @slice-09', async ({ page }) => {
  for (const mode of ['demo', 'real'] as const) {
    const { stage, canvas } = await openGlobe(page, mode);
    const before = await canvas.getAttribute('data-applied-target'), clock = await stage.getAttribute('data-represented-utc'), camera = await canvas.getAttribute('data-camera-position');
    const { start, circle } = await draw(page, stage, canvas);
    await expect(canvas).toHaveAttribute('data-camera-position', camera!); await expect(stage).toHaveAttribute('data-represented-utc', clock!);
    await expect(canvas).toHaveAttribute('data-applied-target', before!); await expect(stage.locator('.globe-selected-reticle')).toHaveCount(0);
    await expect(areaControls(stage)).toContainText('Not applied or confirmed');
    await areaControls(stage).getByRole('button', { name: 'Use this circle', exact: true }).click();
    await expect.poll(async () => JSON.parse((await canvas.getAttribute('data-applied-target'))!)).toMatchObject({ latitude: circle.latitude, longitude: circle.longitude, radiusKm: circle.radiusKm, confirmed: false });
    await areaControls(stage).getByRole('button', { name: 'Edit coordinates and radius', exact: true }).click();
    const brief = page.getByRole('dialog', { name: 'Your request', exact: true });
    expect(Number(await brief.getByLabel('Centre latitude', { exact: true }).inputValue())).toBe(circle.latitude);
    expect(Number(await brief.getByLabel('Radius (km)', { exact: true }).inputValue())).toBe(circle.radiusKm);
    await expect(brief.getByRole('checkbox', { name: 'I chose this target and checked the area size.', exact: true })).not.toBeChecked();
    await brief.getByRole('checkbox', { name: 'I chose this target and checked the area size.', exact: true }).check();
    await brief.getByRole('button', { name: 'Keep brief and close', exact: true }).click();
    // A Rotate Earth click is informational; it cannot replace the applied choice.
    await areaControls(stage).getByRole('button', { name: 'Rotate', exact: true }).click(); await renderedFrames(canvas);
    const actual = await canvas.getAttribute('data-applied-target'); await page.mouse.click(start.x, start.y);
    await expect(areaControls(stage)).toContainText('Choose Select area to draw, or edit coordinates.'); await expect(canvas).toHaveAttribute('data-applied-target', actual!);
  }
});

test('outside/control release, Escape and focus loss restore the preceding preview; drawing never selects, follows or rotates @slice-09', async ({ page, browserName }) => {
  const { stage, canvas } = await openGlobe(page), first = await draw(page, stage, canvas), savedPreview = await canvas.getAttribute('data-area-preview'), camera = await canvas.getAttribute('data-camera-position');
  const begin = async () => { await page.mouse.move(first.start.x, first.start.y); await page.mouse.down(); await page.mouse.move(first.end.x, first.end.y); };
  await begin(); await page.mouse.move(4, 4); await page.mouse.up(); await expect(canvas).toHaveAttribute('data-area-preview', savedPreview!);
  await begin(); const control = (await areaControls(stage).getByRole('button', { name: 'Rotate', exact: true }).boundingBox())!; await page.mouse.move(control.x + control.width / 2, control.y + control.height / 2); await page.mouse.up(); await expect(canvas).toHaveAttribute('data-area-preview', savedPreview!);
  await begin(); await canvas.press('Escape'); await page.mouse.up(); await expect(canvas).toHaveAttribute('data-area-preview', savedPreview!);
  await begin(); await page.evaluate(() => window.dispatchEvent(new Event('blur'))); await page.mouse.up(); await expect(canvas).toHaveAttribute('data-area-preview', savedPreview!);
  if (browserName === 'chromium') {
    // Chromium CDP supplies actual simultaneous touch contacts; no renderer callback or coordinate injection.
    const input = await page.context().newCDPSession(page);
    await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: first.start.x, y: first.start.y }] });
    await expect(areaControls(stage)).toContainText('Drag from the circle center');
    await input.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 1, x: first.end.x, y: first.end.y }] });
    await input.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 1, x: first.end.x, y: first.end.y }, { id: 2, x: first.end.x + 20, y: first.end.y + 20 }] });
    await expect(areaControls(stage)).toContainText('Second touch canceled the stroke');
    await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await input.detach();
    await expect(canvas).toHaveAttribute('data-area-preview', savedPreview!);
  }
  await expect(canvas).toHaveAttribute('data-camera-position', camera!); await expect(canvas).toHaveAttribute('data-applied-target', 'null');
  await expect(stage.locator('.globe-selected-reticle')).toHaveCount(0); await expect(stage.getByRole('button', { name: 'Stop following', exact: true })).toHaveCount(0);
  await canvas.focus(); await canvas.press('Escape'); await expect(canvas).toHaveAttribute('data-area-preview', 'null'); await expect(canvas).toHaveAttribute('data-applied-target', 'null');
});


test('starting a new stroke invalidates a held place lookup before Escape restores the preceding preview and applied target @slice-09', async ({ page }) => {
  const { stage, canvas } = await openGlobe(page), first = await draw(page, stage, canvas), controls = areaControls(stage);
  await controls.getByRole('button', { name: 'Use this circle', exact: true }).click();
  await expect.poll(async () => JSON.parse((await canvas.getAttribute('data-applied-target'))!)).toMatchObject({ ...first.circle });
  await controls.getByRole('button', { name: 'Rotate', exact: true }).click();
  const previous = await draw(page, stage, canvas), preview = await canvas.getAttribute('data-area-preview'), applied = await canvas.getAttribute('data-applied-target');
  let captured!: () => void, failCapture!: (error: unknown) => void, release!: () => void, finished!: () => void, responseStatus: number | null = null;
  const pending = new Promise<void>((resolve, reject) => { captured = resolve; failCapture = reject; }), held = new Promise<void>(resolve => { release = resolve; }), done = new Promise<void>(resolve => { finished = resolve; });
  await page.route('**/api/place-lookups', async route => {
    try {
      // Retain the actual isolated generated-provider response and its source version.
      const response = await route.fetch(); responseStatus = response.status(); captured(); await held;
      await route.fulfill({ response }).catch(() => { /* The deliberate gesture may already have aborted this route. */ });
    } catch (error) { failCapture(error); } finally { finished(); }
  });
  try {
    await page.getByLabel('Place phrase', { exact: true }).fill('Busan Harbor');
    await page.getByRole('button', { name: 'Find place', exact: true }).click(); await pending; expect(responseStatus).toBe(200);
    await page.mouse.move(previous.start.x, previous.start.y); await page.mouse.down(); await page.mouse.move(previous.end.x, previous.end.y);
    await expect(controls.getByRole('button', { name: 'Use this circle', exact: true })).toBeDisabled();
    await expect(controls).toContainText('Release to preview');
    release(); await done; await renderedFrames(canvas);
    await canvas.press('Escape'); await page.mouse.up();
    await expect(canvas).toHaveAttribute('data-area-preview', preview!); await expect(canvas).toHaveAttribute('data-applied-target', applied!);
    await expect(controls.getByRole('region', { name: 'Proposed area', exact: true })).toBeVisible();
    await expect(page.getByText('Busan Harbor — generated provider-response test place', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Find place', exact: true })).toBeEnabled();
  } finally { release(); await page.unrouteAll({ behavior: 'ignoreErrors' }); }
});

test('click/zero radius, oversized drawing and grazing-limb input never replace the applied target or clamp a proposal @slice-09', async ({ page }) => {
  const { stage, canvas } = await openGlobe(page), points = await strokePoints(page, stage, canvas), controls = areaControls(stage);
  await controls.getByRole('button', { name: 'Select area', exact: true }).click();
  await page.mouse.click(points.start.x, points.start.y); await expect(controls).toContainText('Drag to set a radius, or enter coordinates.');
  await expect(canvas).toHaveAttribute('data-area-preview', 'null');
  expect(points.farEnd, 'A genuinely oversized near-side stroke must be available').not.toBeNull();
  await page.mouse.move(points.start.x, points.start.y); await page.mouse.down(); await page.mouse.move(points.farEnd!.x, points.farEnd!.y, { steps: 4 }); await page.mouse.up();
  await expect(controls).toContainText('outside the drawing range'); await expect(controls).toContainText('Use numeric coordinates/radius for finer or larger areas.');
  await expect(canvas).toHaveAttribute('data-area-preview', 'null');
  const box = (await canvas.boundingBox())!, frame = (await stage.boundingBox())!, position = JSON.parse((await canvas.getAttribute('data-camera-position'))!) as number[];
  const camera = new PerspectiveCamera(45, box.width / box.height, .02, 40); camera.position.set(position[0]!, position[1]!, position[2]!); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true);
  const normal = camera.position.clone().normalize(), a = new Vector3().crossVectors(normal, new Vector3(0, 1, 0)).normalize(), b = new Vector3().crossVectors(normal, a), angle = Math.acos(1 / camera.position.length()) - .001;
  let rim: { x: number; y: number } | null = null;
  for (let step = 0; step < 24; step++) {
    const around = step * Math.PI / 12, n = normal.clone().multiplyScalar(Math.cos(angle)).addScaledVector(a, Math.sin(angle) * Math.cos(around)).addScaledVector(b, Math.sin(angle) * Math.sin(around)), screen = n.project(camera);
    const p = { x: box.x + (screen.x + 1) * box.width / 2, y: box.y + (1 - screen.y) * box.height / 2 };
    if (p.x < frame.x + 12 || p.x > frame.x + frame.width - 12 || p.y < frame.y + 80 || p.y > frame.y + frame.height - 140) continue;
    if (await canvas.evaluate((node, v) => document.elementFromPoint(v.x, v.y) === node, p)) { rim = p; break; }
  }
  expect(rim, 'An unobstructed grazing rim is exercised').not.toBeNull();
  await page.mouse.move(rim!.x, rim!.y); await page.mouse.down(); await page.mouse.up();
  await expect(controls).toContainText('Move onto the visible Earth.'); await expect(canvas).toHaveAttribute('data-area-preview', 'null'); await expect(canvas).toHaveAttribute('data-applied-target', 'null');
});

test('numeric zero-origin/finer/larger fallback and keyboard modes remain independent of drawing and WebGL @slice-09', async ({ page }) => {
  await page.addInitScript(() => { const original = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function(this: HTMLCanvasElement, kind, ...args) { return kind === 'webgl2' ? null : Reflect.apply(original, this, [kind, ...args]); } as typeof original; });
  const { stage } = await openGlobeWithoutRenderer(page);
  await expect(areaControls(stage).getByRole('button', { name: 'Select area', exact: true })).toBeDisabled();
  await areaControls(stage).getByRole('button', { name: 'Edit coordinates and radius', exact: true }).click();
  const brief = page.getByRole('dialog', { name: 'Your request', exact: true });
  for (const radius of ['0.001', '1500']) {
    await brief.getByLabel('Centre latitude', { exact: true }).fill('0'); await brief.getByLabel('Centre longitude', { exact: true }).fill('0'); await brief.getByLabel('Radius (km)', { exact: true }).fill(radius);
    await brief.getByRole('button', { name: 'Use these coordinates', exact: true }).click();
    await expect(brief.getByRole('checkbox', { name: 'I chose this target and checked the area size.', exact: true })).not.toBeChecked();
    await brief.getByRole('checkbox', { name: 'I chose this target and checked the area size.', exact: true }).check();
  }
  await expect(brief.getByLabel('Radius (km)', { exact: true })).toHaveValue('1500');
  await expect(brief.getByRole('region', { name: 'Current area and place names', exact: true })).toContainText('1,500 km radius');
});
async function openGlobeWithoutRenderer(page: Page) {
  await page.goto('/'); await chooseDemonstrationCatalog(page); await page.getByRole('button', { name: 'Globe view', exact: true }).click();
  const stage = page.getByRole('region', { name: 'Public demonstration geometry', exact: true }); await expect(stage.getByRole('heading', { name: '3D globe unavailable', exact: true })).toBeVisible(); return { stage };
}

test('mode and preview controls stay reachable at390/768/1024/1440 with exclusive pressed states and keyboard numeric access @slice-09', async ({ page }) => {
  for (const width of [390, 768, 1024, 1440]) {
    const { stage, canvas } = await openGlobe(page, 'demo', width), controls = areaControls(stage);
    await controls.getByRole('button', { name: 'Rotate', exact: true }).focus(); await controls.getByRole('button', { name: 'Rotate', exact: true }).press('ArrowRight');
    await expect(controls.getByRole('button', { name: 'Select area', exact: true })).toBeFocused(); await expect(controls.getByRole('button', { name: 'Select area', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(controls.getByRole('button', { name: 'Rotate', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await renderedFrames(canvas); const camera = await canvas.getAttribute('data-camera-position'); await canvas.focus(); await canvas.press('ArrowRight'); await expect(canvas).toHaveAttribute('data-camera-position', camera!);
    const edit = controls.getByRole('button', { name: 'Edit coordinates and radius', exact: true }); await edit.focus(); await edit.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Your request', exact: true }).getByLabel('Centre latitude', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});
