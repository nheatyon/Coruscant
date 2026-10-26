import { test, expect, type Locator, type Page, type Route } from '@playwright/test';
import type { Context } from '../../shared/contracts.js';
import type { OrbitalBrowseInput, OrbitalBrowseObject, OrbitalBrowsePage } from '../../shared/orbital-contracts.js';

test.setTimeout(120_000);
const stageFor = (page: Page) => page.getByRole('region', { name: 'Real orbital prediction', exact: true });
const sourceControl = (page: Page) => page.getByRole('combobox', { name: 'Catalog', exact: true });
const vectorDot = (a: Vector, b: Vector) => a.x * b.x + a.y * b.y + a.z * b.z;
const vectorSubtract = (a: Vector, b: Vector): Vector => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const vectorCross = (a: Vector, b: Vector): Vector => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const vectorUnit = (a: Vector): Vector => { const length = Math.hypot(a.x, a.y, a.z); return { x: a.x / length, y: a.y / length, z: a.z / length }; };
type Vector = { x: number; y: number; z: number };
type Rectangle = { x: number; y: number; width: number; height: number };
type ViewOffset = { fullWidth: number; fullHeight: number; offsetX: number; offsetY: number; width: number; height: number };
type CapturedPage = { input: OrbitalBrowseInput; page: OrbitalBrowsePage };

function overlaps(a: Rectangle, b: Rectangle, margin = 0) {
  return a.x < b.x + b.width + margin && a.x + a.width > b.x - margin && a.y < b.y + b.height + margin && a.y + a.height > b.y - margin;
}

/** Independent pinhole projection of the actual API position. It uses the declared
 * camera frame, not the scene's hit testing, selected reticle or callbacks. */
function project(position: Vector, camera: Vector, rect: Rectangle, view: ViewOffset | null = null) {
  const forward = vectorUnit({ x: -camera.x, y: -camera.y, z: -camera.z });
  const right = vectorUnit(vectorCross(forward, { x: 0, y: 1, z: 0 })), up = vectorCross(right, forward);
  const relative = vectorSubtract(position, camera), depth = vectorDot(relative, forward);
  if (depth <= .02 || depth >= 40) return null;
  const tangent = Math.tan(22.5 * Math.PI / 180), width = view?.fullWidth ?? rect.width, height = view?.fullHeight ?? rect.height;
  const x = vectorDot(relative, right) / (depth * tangent * width / height), y = vectorDot(relative, up) / (depth * tangent);
  const localX = ((x + 1) * width / 2 - (view?.offsetX ?? 0)) / (view?.width ?? rect.width);
  const localY = ((1 - y) * height / 2 - (view?.offsetY ?? 0)) / (view?.height ?? rect.height);
  if (localX <= 0 || localX >= 1 || localY <= 0 || localY >= 1) return null;
  const segment = vectorSubtract(position, camera), t = Math.max(0, Math.min(1, -vectorDot(camera, segment) / vectorDot(segment, segment)));
  if (Math.hypot(camera.x + segment.x * t, camera.y + segment.y * t, camera.z + segment.z * t) <= 1.01) return null;
  return { x: rect.x + localX * rect.width, y: rect.y + localY * rect.height };
}

/** OrbitControls reconstructs Cartesian coordinates through spherical trig even
 * when paused. Check numerical pose stability, rather than decimal serialization;
 * 64 machine epsilons at the camera scale is far below a rendered pixel. */
async function expectHeldPose(canvas: Locator, serialized: string) {
  const expected = JSON.parse(serialized) as number[], actual = JSON.parse((await canvas.getAttribute('data-camera-position'))!) as number[];
  expect(expected).toHaveLength(3); expect(actual).toHaveLength(3);
  expect([...actual, ...expected].every(Number.isFinite)).toBe(true);
  const tolerance = 64 * Number.EPSILON * Math.max(1, Math.hypot(...expected));
  expect(Math.hypot(...actual.map((value, index) => value - expected[index]!)), 'paused camera remains numerically stable').toBeLessThanOrEqual(tolerance);
}

async function frames(canvas: Locator) {
  await canvas.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

function observeBrowse(page: Page) {
  const received: CapturedPage[] = [];
  page.on('response', async response => {
    if (new URL(response.url()).pathname !== '/api/orbital-browse' || response.request().method() !== 'POST' || !response.ok()) return;
    const input = response.request().postDataJSON() as OrbitalBrowseInput;
    const value = await response.json().catch(() => null) as OrbitalBrowsePage | null;
    if (value) received.push({ input, page: value });
  });
  return (visibility: OrbitalBrowseInput['visibility'], representedAt?: string) => {
    const eligible = received.filter(value => value.input.visibility === visibility && (!representedAt || value.page.representedAt === representedAt));
    const last = eligible.at(-1); if (!last || last.page.nextCursor) return null;
    const pages = eligible.filter(value => value.page.generation === last.page.generation && value.page.snapshotVersion === last.page.snapshotVersion);
    if (!pages.some(value => !value.input.cursor)) return null;
    const objects = pages.flatMap(value => value.page.objects);
    if (new Set(objects.map(value => value.id)).size !== objects.length) return null;
    return { ...last.page, objects };
  };
}

async function readyReal(page: Page) {
  const stage = stageFor(page), canvas = stage.locator('canvas[aria-label="Real predicted Earth globe"]');
  await expect(sourceControl(page)).toHaveValue('REAL');
  // Loading the lazy Three.js renderer and local texture is a separate startup
  // phase. A serial full-run trace completed it after the former 8s wait;
  // keep the functional interaction deadlines and all geometry checks below.
  await expect(canvas).toHaveAttribute('data-texture', 'ready', { timeout: 30_000 });
  await expect(stage.getByRole('button', { name: 'Reset view', exact: true })).toBeEnabled();
  await expect(stage.locator('.globe-drawing-status')).not.toContainText('Calculating');
  await expect(stage.locator('.globe-warning[role="alert"]')).toHaveCount(0);
  return { stage, canvas };
}

async function setAll(stage: Locator, canvas: Locator) {
  const control = stage.getByRole('combobox', { name: 'Show orbits for', exact: true });
  const started = await control.inputValue() !== 'all' ? stage.page().waitForResponse(response => {
    const request = response.request();
    if (new URL(response.url()).pathname !== '/api/orbital-browse' || request.method() !== 'POST') return false;
    const input = request.postDataJSON() as OrbitalBrowseInput;
    return input.visibility === 'ALL' && !input.cursor;
  }, { timeout: 8_000 }) : null;
  await control.selectOption('all');
  if (started) expect((await started).status()).toBe(200);
  // A new ALL request rules out the previous mode's completed status. Let the
  // current paged generation finish before checking its actual renderer output.
  await expect(stage.locator('.globe-drawing-status')).toContainText('200 positions / 50 tracks shown;');
  await expect(canvas).toHaveAttribute('data-drawable-ids', /^(?:norad:\d{1,9},){199}norad:\d{1,9}$/);
}

async function describeReal(page: Page, text: string) {
  const input = page.getByLabel('Search satellites and services', { exact: true });
  if (!await input.isVisible()) await page.getByRole('button', { name: 'Discover', exact: true }).click();
  await input.fill(text); await page.getByRole('button', { name: 'Search catalog only', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Search catalog only', exact: true })).toBeEnabled();
  const modal = page.getByRole('dialog', { name: 'Discovery filters', exact: true });
  if (await modal.count()) { await modal.getByRole('button', { name: 'Show discoveries', exact: true }).click(); await expect(modal).toHaveCount(0); }
}

async function chooseTarget(page: Page) {
  await page.getByRole('button', { name: /Review this mission/ }).click();
  const brief = page.getByRole('dialog', { name: 'Your request', exact: true });
  await brief.getByLabel('Centre latitude', { exact: true }).fill('52.6'); await brief.getByLabel('Centre longitude', { exact: true }).fill('-9.7');
  await brief.getByLabel('Radius (km)', { exact: true }).fill('25'); await brief.getByRole('button', { name: 'Use these coordinates', exact: true }).click();
  await brief.getByRole('checkbox', { name: 'I chose this target and checked the area size.', exact: true }).check();
  await brief.getByRole('button', { name: 'Keep brief and close', exact: true }).click(); await expect(brief).toHaveCount(0);
}

for (const width of [390, 768, 1024, 1440]) {
  test(`real paused display uses the full source population and independent point/path limits at ${width}px @slice-08`, async ({ page }, info) => {
    const captured = observeBrowse(page);
    await page.setViewportSize({ width, height: 1000 }); await page.emulateMedia({ reducedMotion: 'reduce' }); await page.goto('/');
    const { stage, canvas } = await readyReal(page);
    await expect(stage.getByRole('button', { name: 'Resume rotation', exact: true })).toBeVisible();
    await expect(stage.getByRole('combobox', { name: 'Show orbits for', exact: true })).toHaveValue(width < 768 ? 'shortlist' : 'matches');
    await setAll(stage, canvas);
    const represented = (await stage.getAttribute('data-represented-utc'))!;
    await expect.poll(() => captured('ALL', represented)?.objects.length).toBe(283);
    const actual = captured('ALL', represented)!;
    expect(actual.state).toBe('COMPLETE'); expect(actual.counts).toMatchObject({ matching: 283, positions: 200, paths: 50, displayLimited: 81, pathsLimited: 231, unavailable: 2, processed: 283, remaining: 0 });
    expect(actual.objects.map(value => value.id)).toContain('norad:123456789');
    expect(actual.objects.find(value => value.id === 'norad:100279')!.positionAvailability).toBe('UNAVAILABLE');
    expect(actual.objects.find(value => value.id === 'norad:100280')!.positionAvailability).toBe('UNAVAILABLE');
    await expect(stage).toHaveAttribute('data-source-version', actual.snapshotVersion);
    await expect(stage.locator('.globe-drawing-status')).toContainText('200 positions / 50 tracks shown; 81 display-limited; 2 missing, stale or unsupported orbit data');
    await expect(stage.locator('.globe-result-summary')).toContainText('283 records processed · 0 unfinished · 231 paths display-limited');
    const positionWithoutPath = actual.objects.find(value => value.positionAvailability === 'AVAILABLE' && value.pathAvailability === 'DISPLAY_LIMITED')!;
    const colors = JSON.parse((await canvas.getAttribute('data-point-colors'))!) as Record<string, string>;
    const paths = JSON.parse((await canvas.getAttribute('data-path-widths'))!) as Record<string, number>;
    expect(Object.keys(colors)).toHaveLength(200); expect(colors[positionWithoutPath.id]).toBe('78aeba'); expect(paths[positionWithoutPath.id]).toBeUndefined(); expect(Object.keys(paths)).toHaveLength(50);
    expect(Object.keys(colors).some(id => id.startsWith('demo-'))).toBe(false);
    await canvas.focus(); await frames(canvas); const pose = (await canvas.getAttribute('data-camera-position'))!;
    await canvas.press('ArrowLeft'); await expect(canvas).not.toHaveAttribute('data-camera-position', pose);
    await canvas.press('Home'); await frames(canvas); await expect(stage).toHaveAttribute('data-represented-utc', represented);
    await expect(stage.getByRole('button', { name: 'Stop following', exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(overlaps((await stage.getByRole('region', { name: 'Real prediction controls', exact: true }).boundingBox())!, (await page.getByRole('region', { name: 'Prepared mission', exact: true }).boundingBox())!), `${width}px controls keep the request action clear`).toBe(false);
    if (width < 768) await expect(stage.locator('.globe-legend')).not.toBeVisible();
    await expect(stage.locator('.globe-time time')).toHaveText(represented);
    await page.screenshot({ path: info.outputPath(`real-prediction-${width}.png`) });
  });
}

test('paused real display avoids redundant GPU draws and renders an actual keyboard camera change @slice-08 @idle-render', async ({ page }) => {
  await page.addInitScript(() => {
    const diagnostic = window as typeof window & { __glDrawCalls?: number }; diagnostic.__glDrawCalls = 0;
    for (const name of ['drawArrays', 'drawElements'] as const) {
      const original = WebGL2RenderingContext.prototype[name];
      // Count the browser's real GPU submissions, without a product test flag.
      Object.defineProperty(WebGL2RenderingContext.prototype, name, { configurable: true, writable: true, value: function (this: WebGL2RenderingContext, ...args: number[]) {
        diagnostic.__glDrawCalls!++;
        return Reflect.apply(original, this, args);
      } });
    }
  });
  await page.emulateMedia({ reducedMotion: 'reduce' }); await page.goto('/');
  const { stage, canvas } = await readyReal(page); await setAll(stage, canvas);
  const settle = () => canvas.evaluate(() => new Promise<void>(resolve => {
    let remaining = 90; const next = () => --remaining ? requestAnimationFrame(next) : resolve(); requestAnimationFrame(next);
  }));
  const submissions = () => page.evaluate(() => (window as typeof window & { __glDrawCalls: number }).__glDrawCalls);
  await settle(); const paused = await submissions(); expect(paused).toBeGreaterThan(0);
  await settle(); expect(await submissions(), 'an unchanged paused scene submits no redundant GPU draws').toBe(paused);
  const pose = (await canvas.getAttribute('data-camera-position'))!;
  await canvas.focus(); await canvas.press('ArrowRight'); await expect(canvas).not.toHaveAttribute('data-camera-position', pose);
  await settle(); const changed = await submissions(); expect(changed, 'the actual keyboard camera change is rendered').toBeGreaterThan(paused);
  await settle(); expect(await submissions(), 'the new paused view settles without continuous GPU work').toBe(changed);
  // App's planning clock ticks every second. Equal shortlist arrays and a
  // confirmed target must remain semantically stable across those parent renders.
  await describeReal(page, 'SAR imagery comparison.'); await chooseTarget(page);
  await setAll(stage, canvas); await expect(canvas).toHaveAttribute('data-applied-target', /"latitude":52\.6/);
  await settle(); const targeted = await submissions(); expect(targeted, 'the deliberately applied target renders').toBeGreaterThan(changed);
  await settle(); expect(await submissions(), 'equal confirmed target and shortlist stay idle across real one-second clock ticks').toBe(targeted);
});

for (const width of [1280, 1024, 768]) {
  test(`short desktop legend retains both color labels clear of view controls, HUD and request dock at ${width}px @slice-08`, async ({ page }, info) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width, height: 720 }); await page.goto('/');
    const { stage, canvas } = await readyReal(page);
    const inspect = async (variant: string) => {
      await frames(canvas); const legend = stage.locator('.globe-legend');
      await expect(legend.getByText('Selected and shortlisted', { exact: true })).toBeVisible();
      await expect(legend.getByText('Matching real identities', { exact: true })).toBeVisible();
      const box = (await legend.boundingBox())!, frame = (await stage.boundingBox())!;
      for (const [label, obstacle] of [['Globe/List controls', page.locator('.stage-topline')], ['prediction HUD', stage.locator('.globe-hud')], ['request dock', page.getByRole('region', { name: 'Prepared mission', exact: true })]] as const) {
        expect(overlaps(box, (await obstacle.boundingBox())!), `${width}px ${variant}: legend stays clear of ${label}`).toBe(false);
      }
      expect(box.x).toBeGreaterThanOrEqual(frame.x); expect(box.x + box.width).toBeLessThanOrEqual(frame.x + frame.width);
      expect(box.y).toBeGreaterThanOrEqual(frame.y); expect(box.y + box.height).toBeLessThanOrEqual(frame.y + frame.height);
      await expect(stage.getByRole('region', { name: 'Real prediction controls', exact: true })).toContainText('not live telemetry');
      await expect(stage.locator('.globe-interaction-help')).toContainText('Orbit prediction does not resolve a place name, confirm imageability, reserve an operator or change your request.');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: info.outputPath(`real-short-legend-${width}-${variant}.png`) });
    };
    await inspect('default-rail');
    if (width === 1024) {
      const separator = page.getByRole('separator', { name: 'Discovery rail width', exact: true });
      await separator.focus(); await separator.press('End'); await expect(separator).toHaveAttribute('aria-valuenow', '520');
      await inspect('expanded-rail');
    }
  });
}

async function unselectedPoint(page: Page, stage: Locator, canvas: Locator, rows: OrbitalBrowseObject[]) {
  for (let turn = 0; turn < 32; turn++) {
    await frames(canvas); const camera = (await canvas.getAttribute('data-camera-position'))!, [x, y, z] = JSON.parse(camera) as number[];
    const rect = (await canvas.boundingBox())!, frame = (await stage.boundingBox())!, hud = (await stage.locator('.globe-hud').boundingBox())!;
    const projected = rows.filter(row => row.positionAvailability === 'AVAILABLE' && row.position).map(row => ({ row, screen: project(row.position!, { x: x!, y: y!, z: z! }, rect) })).filter(value => value.screen);
    // Prefer an identity outside the first100 catalog rows; the globe must not be
    // generated from the page that happened to be loaded by the list.
    const beyondFirstPage = (id: string) => { const number = Number(id.split(':')[1]); return number >= 100100 && number <= 100198; };
    projected.sort((a, b) => Number(beyondFirstPage(b.row.id)) - Number(beyondFirstPage(a.row.id)));
    for (const value of projected) {
      const screen = value.screen!, marker = { x: screen.x - 22, y: screen.y - 22, width: 44, height: 44 };
      if (marker.x < frame.x + 8 || marker.y < frame.y + 8 || marker.x + 44 > frame.x + frame.width - 8 || marker.y + 44 > frame.y + frame.height - 8 || overlaps(marker, hud, 8)) continue;
      const pointer = { x: Math.round(screen.x), y: Math.round(screen.y) };
      if (!await canvas.evaluate((node, at) => document.elementFromPoint(at.x, at.y) === node, pointer)) continue;
      if (projected.some(other => other.row.id !== value.row.id && Math.hypot(other.screen!.x - pointer.x, other.screen!.y - pointer.y) < Math.hypot(screen.x - pointer.x, screen.y - pointer.y) + 1)) continue;
      return { ...value, screen, pointer, camera };
    }
    await canvas.focus(); await canvas.press('ArrowRight');
  }
  throw new Error('No independently projected source point became accessible after one deliberate keyboard camera turn.');
}

test('actual real API point selects the exact identity; shortlist and explicit Follow preserve confirmed AOI and paused UTC @slice-08', async ({ page }, info) => {
  // This complete multi-step WebGL walkthrough needs the same whole-test allowance
  // as the demonstration-globe suite; action and assertion timeouts stay unchanged.
  test.setTimeout(180_000);
  const captured = observeBrowse(page); await page.setViewportSize({ width: 1440, height: 1000 }); await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/'); let { stage, canvas } = await readyReal(page);
  await describeReal(page, 'SAR imagery comparison.'); await chooseTarget(page);
  ({ stage, canvas } = await readyReal(page)); await setAll(stage, canvas); await stage.getByRole('button', { name: 'Reset view', exact: true }).click();
  const represented = (await stage.getAttribute('data-represented-utc'))!;
  await expect.poll(() => captured('ALL', represented)?.objects.length).toBe(283);
  const source = captured('ALL', represented)!, chosen = await unselectedPoint(page, stage, canvas, source.objects);
  await expect(stage.getByRole('button', { name: 'Follow selected', exact: true })).toBeDisabled();
  await page.mouse.move(chosen.pointer.x, chosen.pointer.y); await frames(canvas);
  await expect(stage.locator('.globe-hover-card strong')).toHaveText(chosen.row.name);
  await page.mouse.click(chosen.pointer.x, chosen.pointer.y);
  const detail = page.getByRole('complementary', { name: 'Discovery details', exact: true });
  await expect(detail.getByRole('heading', { name: chosen.row.name, exact: true })).toBeVisible(); await expect(detail.getByText(chosen.row.id, { exact: true })).toBeVisible();
  await detail.getByRole('button', { name: 'Add to shortlist', exact: true }).click(); await detail.getByRole('button', { name: 'Close Discovery details', exact: true }).click();
  await expect(detail).toHaveCount(0); await expect(canvas).toHaveAttribute('data-shortlisted-ids', chosen.row.id); await frames(canvas);
  await expect(canvas).toHaveAttribute('data-camera-position', chosen.camera); await expect(stage).toHaveAttribute('data-represented-utc', represented);
  await expect(stage.getByRole('button', { name: 'Stop following', exact: true })).toHaveCount(0);
  await expect.poll(async () => JSON.parse((await canvas.getAttribute('data-point-colors'))!)[chosen.row.id]).toBe('f5913a');
  await stage.getByRole('button', { name: 'Orbit details', exact: true }).click();
  const orbit = stage.getByRole('region', { name: 'Real orbit details', exact: true });
  await expect(orbit).toContainText(`Source element epoch ${chosen.row.sourceEpoch}`); await expect(orbit).toContainText(`Calculation epoch (UTC, millisecond precision) ${chosen.row.epoch}`);
  await stage.getByRole('button', { name: 'Orbit details', exact: true }).click();
  await stage.getByRole('button', { name: 'Show shortlist only', exact: true }).click();
  await expect(canvas).toHaveAttribute('data-drawable-ids', chosen.row.id); await expect(stage.getByRole('combobox', { name: 'Show orbits for', exact: true })).toHaveValue('shortlist-only');
  await expect(canvas).toHaveAttribute('data-camera-position', chosen.camera); await expect(stage).toHaveAttribute('data-represented-utc', represented);
  await stage.getByRole('button', { name: 'Follow selected', exact: true }).click();
  const stop = stage.getByRole('button', { name: 'Stop following', exact: true }); await expect(stop).toBeVisible(); await frames(canvas);
  await expect(canvas).not.toHaveAttribute('data-camera-position', chosen.camera);
  const reticle = stage.locator('.globe-selected-reticle'); await expect(reticle).toBeVisible();
  const followedPose = (await canvas.getAttribute('data-camera-position'))!, view = (await canvas.getAttribute('data-view-offset'))!;
  const [x, y, z] = JSON.parse(followedPose) as number[], expected = project(chosen.row.position!, { x: x!, y: y!, z: z! }, (await canvas.boundingBox())!, JSON.parse(view) as ViewOffset | null), marker = (await reticle.boundingBox())!;
  expect(expected).not.toBeNull(); expect(Math.abs(marker.x + 22 - expected!.x)).toBeLessThanOrEqual(1); expect(Math.abs(marker.y + 22 - expected!.y)).toBeLessThanOrEqual(1);
  expect(overlaps(marker, (await stage.locator('.globe-hud').boundingBox())!)).toBe(false);
  expect(overlaps(marker, (await page.locator('.stage-topline').boundingBox())!), 'Follow never frames the selected point under Globe/List controls').toBe(false);
  await stop.click(); await frames(canvas); await expectHeldPose(canvas, followedPose); await expect(canvas).toHaveAttribute('data-view-offset', view);
  await describeReal(page, 'Earth observation SAR imagery comparison.');
  await expect(stage.getByRole('combobox', { name: 'Show orbits for', exact: true })).toHaveValue('matches');
  await expect(canvas).toHaveAttribute('data-shortlisted-ids', chosen.row.id); await frames(canvas);
  await expectHeldPose(canvas, followedPose); await expect(stage).toHaveAttribute('data-represented-utc', represented);
  await expect(stage.getByRole('button', { name: 'Stop following', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: /Review this mission/ }).click(); const brief = page.getByRole('dialog', { name: 'Your request', exact: true });
  await expect(brief.getByLabel('Centre latitude', { exact: true })).toHaveValue('52.6'); await expect(brief.getByLabel('Centre longitude', { exact: true })).toHaveValue('-9.7'); await expect(brief.getByLabel('Radius (km)', { exact: true })).toHaveValue('25');
  await expect(brief.getByRole('checkbox', { name: 'I chose this target and checked the area size.', exact: true })).toBeChecked(); await brief.getByRole('button', { name: 'Keep brief and close', exact: true }).click();
  await expect(stage).toHaveAttribute('data-represented-utc', represented); await page.screenshot({ path: info.outputPath('real-pointer-shortlist-follow.png') });
});

test('real WebGL refusal preserves keyboard list identity and source evidence without demonstration substitution @slice-08', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(this: HTMLCanvasElement, kind: string, ...args: unknown[]) { return kind === 'webgl2' ? null : (original as Function).call(this, kind, ...args); } as typeof original;
  });
  await page.setViewportSize({ width: 390, height: 1000 }); await page.goto('/'); await expect(sourceControl(page)).toHaveValue('REAL');
  await expect(stageFor(page).getByRole('heading', { name: '3D globe unavailable', exact: true })).toBeVisible();
  await stageFor(page).getByRole('button', { name: 'List view · continue without WebGL', exact: true }).click();
  const row = page.getByRole('button', { name: 'Open Generated provider-response test object 100001', exact: true }); await row.focus(); await row.press('Enter');
  const detail = page.getByRole('dialog', { name: 'Discovery details', exact: true }); await expect(detail.getByText('norad:100001', { exact: true })).toBeVisible();
  await expect(detail.getByRole('heading', { name: 'Orbital source and versions', exact: true })).toBeVisible();
  await expect(detail).toContainText('Original source epoch'); await expect(detail).toContainText('Calculation epoch (millisecond UTC)');
  await detail.getByRole('button', { name: 'Close Discovery details', exact: true }).click(); await expect(row).toBeFocused();
  await expect(page.getByRole('button', { name: 'Open Estuary SAR 03', exact: true })).toHaveCount(0);
});

test('real browse failure clears points and ends loading with a truthful retry/list route @slice-08', async ({ page }) => {
  await page.route('**/api/orbital-browse', route => route.fulfill({ status: 503, json: { code: 'SERVICE_UNAVAILABLE', message: 'Isolated browse-response double unavailable.', retryable: true, correlationId: 'browser-double' } }));
  await page.goto('/'); const stage = stageFor(page); await expect(stage.locator('.globe-drawing-status')).toHaveText('Predicted display unavailable');
  await expect(stage.locator('.globe-result-summary')).toContainText('Matching display count unavailable');
  await expect(stage).not.toContainText('Loading held D0'); await expect(stage).not.toContainText('Checking matching catalog objects');
  await expect(stage).toHaveAttribute('data-drawable-ids', ''); await expect(stage.getByRole('button', { name: 'Retry predicted display', exact: true })).toBeVisible();
  await expect(stage.getByRole('alert')).toContainText('No demonstration tracks are substituted.');
  await page.getByRole('button', { name: 'List view', exact: true }).click(); await expect(page.getByRole('button', { name: 'Open Generated provider-response test object 100001', exact: true })).toBeVisible();
});

test('failed initial access check ends calculation; explicit retry stays covered on failure and recovers real positions without choosing a persona @slice-08', async ({ page }) => {
  let unavailable = true, checks = 0, browseRequests = 0; const personaActions: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path === '/api/orbital-browse') browseRequests++;
    if (request.method() === 'POST' && ['/api/demo/customer/enter', '/api/demo/staff/enter', '/api/context/workspace', '/api/demo/leave'].includes(path)) personaActions.push(path);
  });
  await page.route('**/api/context', async route => {
    if (route.request().method() !== 'GET') { await route.continue(); return; }
    checks++;
    if (unavailable) await route.fulfill({ status: 503, json: { code: 'SERVICE_UNAVAILABLE', message: 'Original isolated context-check failure.', retryable: true, correlationId: 'context-check-double' } });
    else await route.continue();
  });
  await page.goto('/'); let stage = stageFor(page);
  await expect(stage.locator('.globe-drawing-status')).toHaveText('Predicted display unavailable');
  await expect(stage.getByRole('alert')).toContainText('We could not check your current access.');
  await expect(stage).not.toContainText('Calculating bounded predicted display'); await expect(stage).toHaveAttribute('data-drawable-ids', '');
  expect(checks).toBeGreaterThan(0); expect(browseRequests).toBe(0);
  await page.getByRole('button', { name: 'List view', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open Generated provider-response test object 100001', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Globe view', exact: true }).click(); stage = stageFor(page);
  await expect(stage.locator('.globe-drawing-status')).toHaveText('Predicted display unavailable');
  const previousChecks = checks, failed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/context' && response.status() === 503);
  await stage.getByRole('button', { name: 'Retry predicted display', exact: true }).click(); await (await failed).finished();
  await expect.poll(() => checks).toBeGreaterThan(previousChecks);
  await expect(stage.locator('.globe-drawing-status')).toHaveText('Predicted display unavailable');
  await expect(stage).toHaveAttribute('data-drawable-ids', ''); expect(browseRequests).toBe(0); expect(personaActions).toEqual([]);
  unavailable = false;
  const restored = page.waitForResponse(response => new URL(response.url()).pathname === '/api/context' && response.status() === 200);
  await stage.getByRole('button', { name: 'Retry predicted display', exact: true }).click(); await (await restored).finished();
  const { canvas } = await readyReal(page);
  await expect.poll(async () => ((await canvas.getAttribute('data-drawable-ids')) ?? '').split(',').filter(Boolean).length).toBe(200);
  await expect(stage.locator('.globe-drawing-status')).toContainText('200 positions / 50 tracks shown');
  expect(browseRequests).toBeGreaterThan(0); expect(personaActions).toEqual([]);
  const context = await (await page.request.get('/api/context')).json() as Context;
  expect(context.audience).toBe('PUBLIC'); expect(context.actor).toBeNull(); expect(context.organization).toBeNull();
});

interface HeldContext { ordinal: number; value: Context; release: (at: string) => Promise<void> }
async function holdContextUpdates(page: Page, plannedUpdates: number) {
  const held: HeldContext[] = [], errors: unknown[] = []; let intercepted = 0, disposed = false;
  const marker = `explicit-time-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  // A routine context poll can arrive while Playwright waits for a real click.
  // Mark only the fetch synchronously issued by that button's actual click event;
  // all polling/context checks keep running and production code is untouched.
  await page.evaluate(value => {
    const state = window as Window & { __restoreCoruscantTimeFixture?: () => void };
    state.__restoreCoruscantTimeFixture?.();
    const original = window.fetch; let pending = false, clear: ReturnType<typeof setTimeout> | undefined;
    const capture = (event: MouseEvent) => {
      const button = event.target instanceof Element ? event.target.closest('button') : null;
      if (!button || button.disabled || button.textContent?.trim() !== 'Update predicted time to now' || !button.closest('[aria-label="Real orbital prediction"]')) return;
      pending = true; if (clear !== undefined) clearTimeout(clear);
      clear = setTimeout(() => { pending = false; }, 0);
    };
    document.addEventListener('click', capture, true);
    window.fetch = (input, init) => {
      const request = input instanceof Request ? input : null, url = new URL(request?.url ?? String(input), location.href);
      if (pending && (init?.method ?? request?.method ?? 'GET').toUpperCase() === 'GET' && url.origin === location.origin && url.pathname === '/api/context') {
        pending = false; if (clear !== undefined) clearTimeout(clear);
        const headers = new Headers(init?.headers ?? request?.headers); headers.set('X-Coruscant-Fixture-Time-Update', value);
        return original.call(window, input, { ...init, headers });
      }
      return original.call(window, input, init);
    };
    state.__restoreCoruscantTimeFixture = () => {
      window.fetch = original; document.removeEventListener('click', capture, true);
      if (clear !== undefined) clearTimeout(clear); delete state.__restoreCoruscantTimeFixture;
    };
  }, marker);
  const handler = async (route: Route) => {
    // Only the deliberately issued time updates are delayed. A later ensure()
    // must be free to verify the current context before browsing after re-entry.
    let finished: (() => void) | undefined;
    try {
      const headers = { ...route.request().headers() }, explicit = headers['x-coruscant-fixture-time-update'] === marker;
      if (!explicit || route.request().method() !== 'GET' || intercepted >= plannedUpdates || disposed) { await route.continue(); return; }
      delete headers['x-coruscant-fixture-time-update'];
      const ordinal = intercepted++;
      const response = await route.fetch({ headers }), value = await response.json() as Context;
      if (disposed) { await route.fulfill({ response }); return; }
      let release!: (at: string) => void; const gate = new Promise<string>(resolve => { release = resolve; });
      const done = new Promise<void>(resolve => { finished = resolve; });
      held.push({ ordinal, value, release: async at => { release(at); await done; } }); held.sort((a, b) => a.ordinal - b.ordinal);
      await route.fulfill({ response, json: { ...value, serverNow: await gate } });
    } catch (error) { if (!page.isClosed()) errors.push(error); }
    finally { finished?.(); }
  };
  await page.route('**/api/context', handler);
  return { held, cleanup: async () => {
    disposed = true;
    await Promise.allSettled(held.map(value => value.release(value.value.serverNow)));
    if (!page.isClosed()) {
      await page.evaluate(() => { (window as Window & { __restoreCoruscantTimeFixture?: () => void }).__restoreCoruscantTimeFixture?.(); });
      await page.unroute('**/api/context', handler);
    }
    expect(errors, 'The context-response fixture completes without an unhandled route failure').toEqual([]);
  } };
}

test('a delayed explicit time update from a previous Real entry cannot replace the new paused snapshot @slice-08', async ({ page }) => {
  await page.goto('/'); await readyReal(page); const { held, cleanup } = await holdContextUpdates(page, 1);
  try {
    await stageFor(page).getByRole('button', { name: 'Update predicted time to now', exact: true }).click(); await expect.poll(() => held.length).toBe(1);
    await sourceControl(page).selectOption('DEMONSTRATION'); await expect(stageFor(page)).toHaveCount(0);
    await sourceControl(page).selectOption('REAL'); const { stage, canvas } = await readyReal(page); const captured = (await stage.getAttribute('data-represented-utc'))!;
    const old = new Date(Date.parse(held[0]!.value.serverNow) + 1000).toISOString(); expect(old).not.toBe(captured);
    await held[0]!.release(old); await frames(canvas); await expect(stage).toHaveAttribute('data-represented-utc', captured);
  } finally { await cleanup(); }
});

test('out-of-order explicit time updates adopt only the latest request and remain paused across display filters @slice-08', async ({ page }) => {
  await page.goto('/'); const { stage, canvas } = await readyReal(page); const { held, cleanup } = await holdContextUpdates(page, 2);
  try {
    const update = stage.getByRole('button', { name: 'Update predicted time to now', exact: true }); await update.click(); await update.click(); await expect.poll(() => held.length).toBe(2);
    const old = new Date(Date.parse(held[0]!.value.serverNow) + 1000).toISOString(), latest = new Date(Date.parse(held[1]!.value.serverNow) + 2000).toISOString();
    await held[1]!.release(latest); await expect(stage).toHaveAttribute('data-represented-utc', latest); await held[0]!.release(old); await frames(canvas); await expect(stage).toHaveAttribute('data-represented-utc', latest);
    await stage.getByRole('combobox', { name: 'Show orbits for', exact: true }).selectOption('shortlist-only'); await expect(stage).toHaveAttribute('data-represented-utc', latest);
    await page.getByRole('button', { name: 'List view', exact: true }).click(); await page.getByRole('button', { name: 'Globe view', exact: true }).click();
    await expect(stageFor(page)).toHaveAttribute('data-represented-utc', latest); await expect(stageFor(page).getByText('PAUSED', { exact: true })).toBeVisible();
  } finally { await cleanup(); }
});
