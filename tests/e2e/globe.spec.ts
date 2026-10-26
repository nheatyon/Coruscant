import { chooseDemonstrationCatalog } from './helpers.js';
import { test, expect, type Page } from '@playwright/test';
import { PerspectiveCamera, Vector3 } from 'three';
import type { PublicCatalog, RequestProjection } from '../../shared/contracts.js';
import type { DemoGeometry } from '../../shared/globe.js';
import { acknowledgeReviewedFilters, interpretNeed, makeDiscoveryDictionary, setManualChoice } from '../../shared/discovery.js';
import { createEmptyQuoteDraft, revisionToInput, type StaffRequestProjection } from '../../shared/workflow.js';
import { enterCustomer, enterStaff, newRequest, prepareDiscovery, scheduledRequest, workflowAction } from './helpers.js';
import { approveAndPublishImages, grant, prepareResult, publishFinding } from './material-helpers.js';

test.setTimeout(180_000);
const publicStage = (page: Page) => page.getByRole('region', { name: 'Public demonstration geometry', exact: true });
const missionStage = (page: Page) => page.getByRole('region', { name: 'Recorded mission demonstration geometry', exact: true });
async function rendered(page: Page, mission = false) {
  const stage = mission ? missionStage(page) : publicStage(page);
  const canvas = stage.locator('canvas[aria-label="Demonstration Earth globe"]');
  await expect(canvas).toBeVisible();
  await expect(canvas).toHaveAttribute('data-texture', 'ready');
  await expect(stage.getByRole('button', { name: 'Reset view', exact: true })).toBeEnabled();
  return { stage, canvas };
}
async function stillCamera(stage: ReturnType<typeof publicStage>) {
  const pause = stage.getByRole('button', { name: 'Pause rotation', exact: true });
  if (await pause.isVisible()) await pause.click();
  await stage.getByRole('button', { name: 'Reset view', exact: true }).click();
}
function project(latitude: number, longitude: number, rect: { x: number; y: number; width: number; height: number }) {
  const degrees = Math.PI / 180;
  const camera = new PerspectiveCamera(45, rect.width / rect.height, .02, 40);
  camera.position.set(3.3 * Math.cos(18 * degrees) * Math.cos(35 * degrees), 3.3 * Math.sin(18 * degrees), -3.3 * Math.cos(18 * degrees) * Math.sin(35 * degrees));
  camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
  const position = new Vector3(Math.cos(latitude * degrees) * Math.cos(longitude * degrees), Math.sin(latitude * degrees), -Math.cos(latitude * degrees) * Math.sin(longitude * degrees)).project(camera);
  return { x: rect.x + (position.x + 1) * rect.width / 2, y: rect.y + (1 - position.y) * rect.height / 2 };
}
async function signAndSubmit(page: Page) {
  await page.getByRole('button', { name: 'Review request', exact: true }).click();
  await page.getByRole('link', { name: 'Open customer workspace', exact: true }).click();
  await page.getByRole('combobox', { name: 'Demonstration customer', exact: true }).selectOption('a-owner');
  await page.getByRole('button', { name: 'Continue to workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Review request in this workspace', exact: true }).click();
  await page.getByRole('checkbox', { name: 'I confirm this planning brief and destination. This does not request staff review.', exact: true }).check();
  await page.getByRole('button', { name: 'Save planning request', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Request saved', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Open request in Demo Estuary Research', exact: true }).click();
  const id = new URL(page.url()).pathname.split('/').at(-1)!;
  const planning = await (await page.request.get(`/api/customer/org-a/requests/${id}`)).json() as RequestProjection;
  expect(planning.status).toBe('Planning');
  await page.getByRole('button', { name: 'Submit request for review…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Submit Planning request for review', exact: true });
  await dialog.getByRole('checkbox', { name: 'I request staff feasibility review for this brief and workspace. This is not a booking or collection.', exact: true }).check();
  await dialog.getByRole('button', { name: 'Review submission', exact: true }).click();
  await dialog.getByRole('button', { name: 'Submit request for review', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const submitted = await (await page.request.get(`/api/customer/org-a/requests/${id}`)).json() as RequestProjection;
  expect(submitted.status).toBe('Submitted'); expect(submitted.reference).toBe(planning.reference);
  return submitted;
}
async function trackedPlan(page: Page, purpose: string, ids: string[], offset = 0) {
  const mission = await newRequest(page, purpose);
  if (offset) {
    const brief = revisionToInput(mission.saved.brief);
    const advance = (value: string) => new Date(Date.parse(`${value}Z`) + offset * 86400_000).toISOString().slice(0, 16);
    for (const field of ['start', 'end', 'planStart', 'planEnd'] as const) mission.dates[field] = advance(mission.dates[field]);
    brief.windowStart = mission.dates.start; brief.windowEnd = mission.dates.end;
    if (brief.discovery) {
      const manual = setManualChoice(brief.discovery.manual, 'window', { startUtc: `${brief.windowStart}:00.000Z`, endUtc: `${brief.windowEnd}:00.000Z` }, 'Explicit isolated future planning window');
      brief.discovery = acknowledgeReviewedFilters(interpretNeed({ text: brief.purpose, generation: brief.discovery.generation + 1, manual, dictionary: makeDiscoveryDictionary(mission.catalog.items) }), makeDiscoveryDictionary(mission.catalog.items));
    }
    await workflowAction(page, mission.id, 'reviseBrief', { brief });
  }
  await enterStaff(page); await workflowAction(page, mission.id, 'startReview', {}, undefined, false);
  const quote = { ...createEmptyQuoteDraft(), priceType: 'FIXED', amount: '2200.00', scope: 'Synthetic local EO comparison only; no tasking or actual collection.', licence: 'Original synthetic material permitted for local demonstration.', validUntil: mission.dates.expiry };
  const saved = await workflowAction(page, mission.id, 'saveQuoteDraft', { quote }, undefined, false);
  const row = await (await page.request.get(`/api/staff/requests/${mission.id}`)).json() as StaffRequestProjection;
  await workflowAction(page, mission.id, 'publishQuote', { replacesQuoteId: null }, row.quoteDrafts.find(value => value.id === saved.quoteId)!);
  await enterCustomer(page);
  const offered = await (await page.request.get(`/api/customer/org-a/requests/${mission.id}`)).json() as RequestProjection;
  await workflowAction(page, mission.id, 'acceptQuote', {}, offered.currentQuote!);
  await enterStaff(page);
  await workflowAction(page, mission.id, 'recordInitialSchedule', { acceptedQuoteId: offered.currentQuote!.id, schedule: { provider: 'Demonstration planning team', timezone: 'UTC', start: mission.dates.planStart, end: mission.dates.planEnd, trackedItemIds: ids, notes: 'Synthetic display context only; no operator execution.' } });
  return mission;
}

test('actual oriented Earth picking → independent date confirmation → same persisted globe-choice brief @slice-06', async ({ page }, info) => {
  await page.goto('/'); await chooseDemonstrationCatalog(page); await prepareDiscovery(page, `SAR imagery for a coastal comparison (${info.project.name}).`);
  await page.getByRole('button', { name: 'Globe view', exact: true }).click();
  const { stage, canvas } = await rendered(page); await stillCamera(stage);
  const catalog = await (await page.request.get('/api/public/catalog')).json() as PublicCatalog;
  await expect(stage).toHaveAttribute('data-represented-utc', catalog.demo.d0);
  const rect = (await canvas.boundingBox())!;
  const place = project(52.6, -9.7, rect);
  // Use the same whole CSS pixel in both engines: WebKit quantizes fractional mouse input.
  const pointer = { x: Math.round(place.x), y: Math.round(place.y) };
  await page.mouse.move(pointer.x, pointer.y);
  await expect(stage.getByText('Choose Select area to draw, or edit coordinates', { exact: true })).toBeVisible();
  const hoverCoordinates = await stage.locator('.globe-ground-card .mono').innerText();
  const edge = project(52.6, -7.7, rect), edgePointer = { x: Math.round(edge.x), y: Math.round(edge.y) };
  await page.mouse.move(edgePointer.x, edgePointer.y);
  await expect(stage.locator('.globe-ground-card')).toBeVisible();
  const edgeCoordinates = await stage.locator('.globe-ground-card .mono').innerText();
  await stage.getByRole('button', { name: 'Select area', exact: true }).click();
  await expect(canvas).toHaveAttribute('data-area-mode', 'select');
  await page.mouse.move(pointer.x, pointer.y); await page.mouse.down(); await page.mouse.move(edgePointer.x, edgePointer.y, { steps: 4 }); await page.mouse.up();
  await expect(stage.getByRole('region', { name: 'Proposed area', exact: true })).toBeVisible();
  const proposed = JSON.parse((await canvas.getAttribute('data-area-preview'))!) as { latitude: number; longitude: number; radiusKm: number };
  const [edgeLat, edgeLon] = edgeCoordinates.match(/-?\d+\.\d+/g)!.map(Number), d = Math.PI / 180;
  const a = (edgeLat! - proposed.latitude) * d, b = (edgeLon! - proposed.longitude) * d;
  const haversine = Math.sin(a / 2) ** 2 + Math.cos(proposed.latitude * d) * Math.cos(edgeLat! * d) * Math.sin(b / 2) ** 2;
  expect(Math.abs(proposed.radiusKm - 2 * 6371.0088 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine)))).toBeLessThan(.02);
  await stage.getByRole('button', { name: 'Use this circle', exact: true }).click();
  await page.getByRole('button', { name: /Review this mission/ }).click();
  const brief = page.getByRole('dialog', { name: 'Your request', exact: true });
  const latitude = Number(await brief.getByLabel('Centre latitude', { exact: true }).inputValue());
  const longitude = Number(await brief.getByLabel('Centre longitude', { exact: true }).inputValue());
  // The actual whole-CSS-pixel click differs from the unrounded projected coordinate.
  // Verify its ray in screen space rather than a fixed degree error that depends on globe height.
  const picked = project(latitude, longitude, rect);
  expect(Math.abs(picked.x - pointer.x)).toBeLessThanOrEqual(.5);
  expect(Math.abs(picked.y - pointer.y)).toBeLessThanOrEqual(.5);
  expect(hoverCoordinates).toBe(`${latitude.toFixed(4)}°, ${longitude.toFixed(4)}°`);
  expect(Number(await brief.getByLabel('Radius (km)', { exact: true }).inputValue())).toBe(proposed.radiusKm);
  await brief.getByRole('radio', { name: 'Baseline–recent comparison', exact: true }).check();
  await expect(brief.getByLabel('Baseline reference date', { exact: true })).toHaveValue('');
  await expect(brief.getByLabel('Recent reference date', { exact: true })).toHaveValue('');
  const confirmation = brief.getByRole('checkbox', { name: 'I chose this target and checked the area size.', exact: true });
  await expect(confirmation).not.toBeChecked(); await confirmation.check();
  await brief.getByLabel('Baseline reference date', { exact: true }).fill(catalog.demo.baselineDate);
  await brief.getByLabel('Recent reference date', { exact: true }).fill(catalog.demo.recentDate);
  await brief.getByLabel('Contact name', { exact: true }).fill('Demonstration globe research contact');
  await brief.getByLabel('Contact email', { exact: true }).fill('globe@coastal.example');
  await brief.getByLabel('Organisation name', { exact: true }).fill('Demonstration coastal researchers');
  const row = await signAndSubmit(page);
  expect(row.brief.area.method).toBe('globe');
  expect(row.brief.area.latitude).toBe(latitude); expect(row.brief.area.longitude).toBe(longitude);
  expect(row.brief.baselineDate).toBe(catalog.demo.baselineDate); expect(row.evidence).toHaveLength(0);
  await page.reload(); await expect(page.getByText(row.reference, { exact: true }).first()).toBeVisible();
});

test('plain track counts and visible interaction guidance keep the Earth proposal callout clear of controls @slice-07', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/'); await chooseDemonstrationCatalog(page); await prepareDiscovery(page, 'SAR imagery with maximum ground resolution 10 m.');
  await page.getByRole('button', { name: 'Globe view', exact: true }).click();
  const { stage, canvas } = await rendered(page); await stillCamera(stage);
  const guide = stage.locator('.globe-interaction-help');
  await expect(guide.getByText('Camera: Drag to rotate; scroll to zoom. Use Follow selected to follow a satellite.', { exact: true })).toBeVisible();
  await expect(guide.getByText('Satellites: Click for details; shortlist to keep evidence. Neither changes the camera or Earth target.', { exact: true })).toBeVisible();
  await expect(guide.getByText('Earth target: Use Select area to stage a circle, then Use this circle and confirm the size separately. Numeric editing remains in the request brief.', { exact: true })).toBeVisible();
  await expect(stage.locator('.globe-drawing-status')).toContainText('satellite tracks shown');
  await expect(stage).not.toContainText(/drawable/i);
  await expect(stage.getByText('Search filters a fixed set of authored demonstration tracks. It does not fetch new orbit data.', { exact: true })).toBeVisible();
  const controls = (await stage.locator('.globe-hud').boundingBox())!;
  let inspected = false;
  // Hover immediately beside the HUD where the old pointer-only placement extended over its controls.
  for (let y = controls.y + 20; y < controls.y + controls.height - 20; y += 40) {
    await page.mouse.move(controls.x - 16, y);
    await canvas.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    // Read visibility, copy and all rectangles in one DOM turn: an account poll
    // or layout update cannot invalidate a later nullable boundingBox lookup.
    const measurement = await stage.evaluate(node => {
      const card = node.querySelector<HTMLElement>('.globe-ground-card'), hud = node.querySelector<HTMLElement>('.globe-hud');
      if (!card || !hud || getComputedStyle(card).visibility !== 'visible' || !card.getClientRects().length) return null;
      const rectangle = (element: Element) => { const value = element.getBoundingClientRect(); return { x: value.x, y: value.y, width: value.width, height: value.height }; };
      return { box: rectangle(card), controls: rectangle(hud), frame: rectangle(node), text: card.textContent };
    });
    if (!measurement) continue;
    expect(measurement.text).toContain('Choose Select area to draw, or edit coordinates');
    const { box, controls: currentControls, frame: currentFrame } = measurement;
    const overlaps = Math.min(box.x + box.width, currentControls.x + currentControls.width) > Math.max(box.x, currentControls.x) && Math.min(box.y + box.height, currentControls.y + currentControls.height) > Math.max(box.y, currentControls.y);
    expect(overlaps, 'The target proposal must not cover the globe controls').toBe(false);
    expect(box.x).toBeGreaterThanOrEqual(currentFrame.x); expect(box.x + box.width).toBeLessThanOrEqual(currentFrame.x + currentFrame.width);
    expect(box.y).toBeGreaterThanOrEqual(currentFrame.y); expect(box.y + box.height).toBeLessThanOrEqual(currentFrame.y + currentFrame.height);
    inspected = true; break;
  }
  expect(inspected, 'A visible Earth point next to the HUD exposes the proposal callout').toBe(true);
});

test('list/globe selection and drawing modes share IDs; actual line widths, camera-only controls and held D0 agree @slice-06', async ({ page }, info) => {
  await page.goto('/'); await chooseDemonstrationCatalog(page); await prepareDiscovery(page, 'SAR imagery with maximum resolution 10 m.');
  await page.getByRole('button', { name: 'Add Coast SAR 08 to shortlist', exact: true }).click();
  await page.getByRole('button', { name: 'Open Estuary SAR 03', exact: true }).click();
  await page.getByRole('complementary', { name: 'Discovery details', exact: true }).getByRole('button', { name: 'Close Discovery details', exact: true }).click();
  await page.getByRole('button', { name: 'Globe view', exact: true }).click();
  const { stage, canvas } = await rendered(page); await stillCamera(stage);
  const at = await stage.getAttribute('data-represented-utc');
  await expect(canvas).toHaveAttribute('data-drawable-ids', 'demo-sar-03,demo-sar-08,demo-sar-country');
  const initialWidths = JSON.parse((await canvas.getAttribute('data-path-widths'))!);
  expect(initialWidths['demo-sar-03']).toBe(2); expect(initialWidths['demo-sar-08']).toBe(2); expect(initialWidths['demo-sar-country']).toBe(1.5);
  await expect(page.locator('.globe-selected-reticle')).toHaveCSS('width', '44px');
  await stage.getByRole('button', { name: 'Orbit details', exact: true }).click();
  await expect(stage.getByRole('region', { name: 'Orbit details', exact: true }).getByText('Estuary SAR 03', { exact: true }).first()).toBeVisible();
  await stage.getByRole('button', { name: 'Orbit details', exact: true }).click();
  const before = await canvas.getAttribute('data-camera-position');
  await canvas.focus(); await canvas.press('ArrowRight');
  await expect(canvas).not.toHaveAttribute('data-camera-position', before!);
  await expect(stage).toHaveAttribute('data-represented-utc', at!);
  await stage.getByRole('button', { name: 'Follow selected', exact: true }).click();
  await expect(stage.getByRole('button', { name: 'Stop following', exact: true })).toBeVisible();
  await stage.getByRole('button', { name: 'Reset view', exact: true }).click();
  await expect(stage.getByRole('button', { name: 'Follow selected', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Max resolution', exact: true }).selectOption('3');
  const review = page.getByRole('button', { name: 'Use reviewed filters', exact: true }); if (await review.isVisible()) await review.click();
  await stage.getByRole('combobox', { name: 'Show orbits for', exact: true }).selectOption('matches');
  await expect(canvas).toHaveAttribute('data-drawable-ids', 'demo-sar-03,demo-sar-08');
  const widths = JSON.parse((await canvas.getAttribute('data-path-widths'))!);
  expect(widths['demo-sar-03']).toBe(2); expect(widths['demo-sar-08']).toBe(2); expect(Object.keys(widths)).toEqual(['demo-sar-03', 'demo-sar-08']);
  await page.screenshot({ path: info.outputPath('desktop-demonstration-globe.png') });
});

test('completed supported criteria reveal matching geometry; exact orange shortlist-only drawing preserves camera, selection and confirmed area @slice-07', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto('/'); await chooseDemonstrationCatalog(page);
  await prepareDiscovery(page, 'SAR imagery with maximum ground resolution 10 m.');
  await page.getByRole('button', { name: 'Add Coast SAR 08 to shortlist', exact: true }).click();
  await page.getByRole('button', { name: 'Add Survey Candidate to shortlist', exact: true }).click();
  await page.getByRole('button', { name: 'Open Delta SAR 05', exact: true }).click();
  await page.getByRole('complementary', { name: 'Discovery details', exact: true }).getByRole('button', { name: 'Close Discovery details', exact: true }).click();
  await page.getByRole('button', { name: /Review this mission/ }).click();
  const brief = page.getByRole('dialog', { name: 'Your request', exact: true });
  await brief.getByLabel('Centre latitude', { exact: true }).fill('52.6'); await brief.getByLabel('Centre longitude', { exact: true }).fill('-9.7');
  await brief.getByLabel('Radius (km)', { exact: true }).fill('25'); await brief.getByRole('button', { name: 'Use these coordinates', exact: true }).click();
  await brief.getByRole('checkbox', { name: 'I chose this target and checked the area size.', exact: true }).check();
  await brief.getByRole('button', { name: 'Keep brief and close', exact: true }).click();
  await page.getByRole('button', { name: 'Globe view', exact: true }).click();
  const { stage, canvas } = await rendered(page); await stillCamera(stage);
  await expect(stage.getByRole('button', { name: 'Resume rotation', exact: true })).toBeVisible();
  // Reset mutates the camera synchronously; its diagnostic attribute is published
  // by the next renderer frame. Capture that rendered pose, not the prior rotation frame.
  await canvas.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const camera = await canvas.getAttribute('data-camera-position'), represented = await stage.getAttribute('data-represented-utc');
  const pose = JSON.parse(camera!) as number[], radians = Math.PI / 180;
  const reset = [3.3 * Math.cos(18 * radians) * Math.cos(35 * radians), 3.3 * Math.sin(18 * radians), -3.3 * Math.cos(18 * radians) * Math.sin(35 * radians)];
  reset.forEach((value, index) => expect(pose[index]).toBeCloseTo(value, 12));
  await stage.getByRole('button', { name: 'Show shortlist only', exact: true }).click();
  await expect(stage.getByRole('combobox', { name: 'Show orbits for', exact: true })).toHaveValue('shortlist-only');
  await expect(canvas).toHaveAttribute('data-drawable-ids', 'demo-sar-08');
  await page.getByRole('combobox', { name: 'Max resolution', exact: true }).selectOption('3');
  const review = page.getByRole('button', { name: 'Use reviewed filters', exact: true }); if (await review.isVisible()) await review.click();
  // The completed supported reading changes drawing eligibility, without a camera flight or new selection.
  await expect(stage.getByRole('combobox', { name: 'Show orbits for', exact: true })).toHaveValue('matches');
  await expect(canvas).toHaveAttribute('data-drawable-ids', 'demo-sar-03,demo-sar-08');
  await expect(stage.locator('.globe-match-summary')).toHaveText('2 current matches · 1 satellite track available · 1 without orbit data');
  await expect(stage.locator('.globe-shortlist-summary')).toHaveText('2 shortlisted · 1 satellite track available · 1 without orbit data');
  await expect.poll(async () => JSON.parse((await canvas.getAttribute('data-point-colors'))!)).toEqual({ 'demo-sar-03': '78aeba', 'demo-sar-08': 'f5913a' });
  await expect(canvas).toHaveAttribute('data-camera-position', camera!); await expect(stage).toHaveAttribute('data-represented-utc', represented!);
  await expect(stage.getByRole('button', { name: 'Stop following', exact: true })).toHaveCount(0);
  await stage.getByRole('button', { name: 'Show shortlist only', exact: true }).click();
  await expect(canvas).toHaveAttribute('data-drawable-ids', 'demo-sar-08'); await expect(canvas).toHaveAttribute('data-shortlisted-ids', 'demo-sar-08');
  await expect(stage.getByRole('button', { name: 'Show shortlist only', exact: true })).toHaveAttribute('aria-pressed', 'true');
  // The older combined mode remains available, and includes the deliberate selected identity.
  await stage.getByRole('combobox', { name: 'Show orbits for', exact: true }).selectOption('shortlist');
  await expect(canvas).toHaveAttribute('data-drawable-ids', 'demo-sar-08,demo-sar-country');
  await expect(canvas).toHaveAttribute('data-camera-position', camera!);
  await stage.getByRole('button', { name: 'Orbit details', exact: true }).click();
  await expect(stage.getByRole('region', { name: 'Orbit details', exact: true }).getByText('Delta SAR 05', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: /Review this mission/ }).click();
  await expect(brief.getByLabel('Centre latitude', { exact: true })).toHaveValue('52.6'); await expect(brief.getByLabel('Centre longitude', { exact: true })).toHaveValue('-9.7');
  await expect(brief.getByLabel('Radius (km)', { exact: true })).toHaveValue('25'); await expect(brief.getByRole('checkbox', { name: 'I chose this target and checked the area size.', exact: true })).toBeChecked();
});

test('failed geometry stops claiming a loading held D0 and retains truthful match counts through a real retry @slice-07', async ({ page }) => {
  await page.route('**/api/public/geometry', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'GEOMETRY_UNAVAILABLE', message: 'The demonstration geometry source is unavailable.', retryable: true, correlationId: 'isolated-geometry-failure' }) }));
  await page.goto('/'); await chooseDemonstrationCatalog(page); await prepareDiscovery(page, 'SAR imagery with maximum ground resolution 10 m.');
  await page.getByRole('button', { name: 'Globe view', exact: true }).click();
  const { stage, canvas } = await rendered(page);
  await expect(stage.getByText(/Demonstration orbit data unavailable\. Earth and the list remain usable/)).toBeVisible();
  await expect(stage.getByText('Held D0 unavailable', { exact: true })).toBeVisible(); await expect(stage.getByText('Loading held D0…', { exact: true })).toHaveCount(0);
  await expect(stage).toHaveAttribute('data-represented-utc', ''); await expect(canvas).toHaveAttribute('data-drawable-ids', '');
  await expect(stage.locator('.globe-match-summary')).toHaveText('4 current matches · 0 satellite tracks available · 4 without orbit data');
  await page.unroute('**/api/public/geometry'); await stage.getByRole('button', { name: 'Retry geometry', exact: true }).click();
  const catalog = await (await page.request.get('/api/public/catalog')).json() as PublicCatalog;
  await expect(stage).toHaveAttribute('data-represented-utc', catalog.demo.d0); await expect(stage.getByText('Held D0 unavailable', { exact: true })).toHaveCount(0);
  await expect(canvas).toHaveAttribute('data-drawable-ids', 'demo-sar-03,demo-sar-08,demo-sar-country');
  await expect(stage.locator('.globe-match-summary')).toHaveText('4 current matches · 3 satellite tracks available · 1 without orbit data');
});

test('mission stage uses only actual tracked identities, paused saved start and honest unavailable spans @slice-06', async ({ page }, info) => {
  const tracked = await trackedPlan(page, `Tracked synthetic mission (${info.project.name}).`, ['demo-sar-03', 'demo-eo-unknown']);
  await enterCustomer(page); await page.goto(`/workspaces/org-a/missions/${tracked.id}`);
  const first = await rendered(page, true);
  await expect(first.stage).toHaveAttribute('data-tracked-ids', 'demo-sar-03,demo-eo-unknown');
  await expect(first.stage).toHaveAttribute('data-represented-utc', `${tracked.dates.planStart}:00.000Z`);
  await expect(first.canvas).toHaveAttribute('data-drawable-ids', 'demo-sar-03');
  await expect(first.stage.getByRole('button', { name: 'Resume rotation', exact: true })).toBeVisible();
  await first.stage.getByRole('button', { name: 'Orbit details', exact: true }).click();
  await first.stage.getByText('Missing orbit data · 1', { exact: true }).click();
  await expect(first.stage.getByText('Survey Candidate', { exact: true })).toBeVisible();
  const empty = await scheduledRequest(page, `No-tracked synthetic mission (${info.project.name}).`);
  await enterCustomer(page); await page.goto(`/workspaces/org-a/missions/${empty.id}`);
  const none = await rendered(page, true);
  await expect(none.canvas).toHaveAttribute('data-drawable-ids', '');
  await expect(none.stage).toHaveAttribute('data-tracked-ids', '');
  await expect(none.stage.getByText(/No tracked spacecraft recorded for this plan/)).toBeVisible();
  const later = await trackedPlan(page, `Out-of-span synthetic mission (${info.project.name}).`, ['demo-sar-03'], 20);
  await enterCustomer(page); await page.goto(`/workspaces/org-a/missions/${later.id}`);
  const outside = await rendered(page, true);
  await expect(outside.canvas).toHaveAttribute('data-drawable-ids', '');
  await outside.stage.getByRole('button', { name: 'Orbit details', exact: true }).click();
  await outside.stage.getByText('Missing orbit data · 1', { exact: true }).click();
  await expect(outside.stage.getByText(/outside the valid supplied span/).first()).toBeVisible();
  const record = await (await page.request.get(`/api/customer/org-a/requests/${later.id}`)).json() as RequestProjection;
  expect(record.status).toBe('Scheduled'); expect(record.schedule!.trackedItemIds).toEqual(['demo-sar-03']);
});

test('real WebGL refusal retains list → saved request → mission and exact entitled result navigation @slice-06', async ({ page }, info) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(this: HTMLCanvasElement, kind: string, ...args: unknown[]) { return kind === 'webgl2' ? null : (original as Function).call(this, kind, ...args); } as typeof original;
  });
  await page.setViewportSize({ width: 390, height: 900 }); await page.goto('/'); await chooseDemonstrationCatalog(page);
  await expect(page.getByRole('heading', { name: '3D globe unavailable', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'List view · continue without WebGL', exact: true }).click();
  const mission = await scheduledRequest(page, `Usable renderer fallback comparison (${info.project.name}).`);
  const resultId = await prepareResult(page, mission.id, `Fallback supplied comparison (${info.project.name})`);
  await approveAndPublishImages(page, mission.id); await publishFinding(page, mission.id); await grant(page, mission.id);
  await enterCustomer(page); await page.goto(`/workspaces/org-a/missions/${mission.id}`);
  await expect(page.getByRole('heading', { name: '3D globe unavailable', exact: true })).toBeVisible();
  await page.getByRole('link', { name: `Fallback supplied comparison (${info.project.name})`, exact: true }).click();
  expect(page.url()).toContain(`/results/${resultId}`);
  await expect(page.getByRole('tab', { name: 'Staff finding', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('img', { name: /Baseline/ }).first()).toBeVisible();
  await page.screenshot({ path: info.outputPath('phone-without-webgl-result.png') });
});

test('texture, malformed geometry and context-loss failures are truthful and retain current evidence/target @slice-06', async ({ page }) => {
  await page.route('**/earth/world.200407.3x5400x2700.jpg', route => route.abort('failed'));
  await page.goto('/'); await chooseDemonstrationCatalog(page);
  await expect(publicStage(page).getByText(/Static Earth imagery unavailable/)).toBeVisible();
  await expect(publicStage(page).locator('canvas')).toHaveAttribute('data-texture', 'unavailable');
  await page.unrouteAll();
  await page.route('**/api/public/geometry', async route => {
    const response = await route.fetch(), value = await response.json() as DemoGeometry;
    value.tracks[0]!.knots.splice(40, 1);
    await route.fulfill({ response, json: value });
  });
  await page.goto('/'); await chooseDemonstrationCatalog(page); const { stage, canvas } = await rendered(page);
  await expect(canvas).toHaveAttribute('data-drawable-ids', 'demo-sar-08,demo-sar-country');
  await stage.getByRole('button', { name: 'Orbit details', exact: true }).click();
  await stage.getByText('Missing orbit data · 4', { exact: true }).click();
  await expect(stage.getByText(/keyframe sequence is incomplete/)).toBeVisible();
  await canvas.dispatchEvent('webglcontextlost', { cancelable: true });
  await expect(stage.getByRole('heading', { name: '3D globe unavailable', exact: true })).toBeVisible();
  await expect(canvas).toHaveCount(0);
  await stage.getByRole('button', { name: 'List view · continue without WebGL', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open Estuary SAR 03', exact: true })).toBeVisible();
});

test('phone defaults, responsive HUD clearance, keyboard controls and reduced motion remain usable @slice-06', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 }); await page.goto('/'); await chooseDemonstrationCatalog(page);
    const { stage, canvas } = await rendered(page);
    await expect(stage.getByRole('button', { name: 'Resume rotation', exact: true })).toBeVisible();
    await expect(stage.getByRole('combobox', { name: 'Show orbits for', exact: true })).toHaveValue(width < 768 ? 'shortlist' : 'all');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const dock = (await page.getByRole('region', { name: 'Prepared mission', exact: true }).boundingBox())!;
    const hud = (await stage.getByRole('region', { name: 'Demonstration geometry controls', exact: true }).boundingBox())!;
    const intersects = Math.min(dock.x + dock.width, hud.x + hud.width) > Math.max(dock.x, hud.x) && Math.min(dock.y + dock.height, hud.y + hud.height) > Math.max(dock.y, hud.y);
    expect(intersects, `${width}px controls must not cover the mission action`).toBe(false);
    await canvas.focus(); await canvas.press('ArrowLeft'); await canvas.press('Home');
    await page.screenshot({ path: info.outputPath(`globe-${width}.png`) });
  }
});

test('source epoch/span identity and malformed entries never invent held-D0 tracks or crash the list @slice-06', async ({ page }) => {
  let corruption: 'identity' | 'association' | 'null' = 'identity';
  await page.route('**/api/public/geometry', async route => {
    const response = await route.fetch(), value = await response.json() as DemoGeometry;
    if (corruption === 'identity') value.epoch = new Date(Date.parse(value.epoch) + 86400_000).toISOString();
    if (corruption === 'association') {
      const track = value.tracks[0]!, shift = (at: string) => new Date(Date.parse(at) + 86400_000).toISOString();
      track.epoch = shift(track.epoch); track.spanStart = shift(track.spanStart); track.spanEnd = shift(track.spanEnd);
      for (const knot of track.knots) knot.at = shift(knot.at);
    }
    if (corruption === 'null') (value.tracks as unknown[])[0] = null;
    await route.fulfill({ response, json: value });
  });
  await page.goto('/'); await chooseDemonstrationCatalog(page);
  let view = await rendered(page);
  await expect(view.stage.getByText(/Demonstration orbit data unavailable\. Earth and the list remain usable/)).toBeVisible();
  await expect(view.canvas).toHaveAttribute('data-drawable-ids', '');
  await expect(view.stage).toHaveAttribute('data-represented-utc', '');
  await expect(view.stage.getByText('Held D0 unavailable', { exact: true })).toBeVisible();
  await expect(view.stage.getByText('Loading held D0…', { exact: true })).toHaveCount(0);
  for (const mode of ['association', 'null'] as const) {
    corruption = mode; await page.goto('/'); await chooseDemonstrationCatalog(page); view = await rendered(page);
    await expect(view.canvas).toHaveAttribute('data-drawable-ids', 'demo-sar-08,demo-sar-country');
    await page.getByRole('button', { name: 'List view', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Open Estuary SAR 03', exact: true })).toBeVisible();
  }
});
