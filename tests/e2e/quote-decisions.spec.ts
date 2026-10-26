import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { RequestProjection } from '../../shared/contracts.js';
import { createEmptyQuoteDraft } from '../../shared/workflow.js';
import { enterCustomer, enterStaff, newRequest, workflowAction } from './helpers.js';

test.setTimeout(90_000);
type Decision = 'ACCEPT' | 'DECLINE';
const reason = 'Please review this demonstration offer; its proposed price does not meet the example budget.';
const details = (decision: Decision) => decision === 'ACCEPT'
  ? { command: 'acceptQuote', opener: 'Accept quote…', title: 'Confirm acceptance', confirm: 'Confirm acceptance', retry: 'Retry same acceptance', status: 'Accepted', message: 'Quote accepted. Our team will schedule the mission.' }
  : { command: 'declineQuote', opener: 'Decline…', title: 'Decline this quote?', confirm: 'Confirm decline', retry: 'Retry same decline', status: 'In review', message: 'Quote declined. Our team can review your request and prepare another quote.' };
async function read(page: Page, id: string) {
  const response = await page.request.get(`/api/customer/org-a/requests/${id}`);
  expect(response.status(), await response.text()).toBe(200);
  return response.json() as Promise<RequestProjection>;
}
async function offer(page: Page, label: string) {
  const mission = await newRequest(page, label);
  await enterStaff(page);
  await workflowAction(page, mission.id, 'startReview', {}, undefined, false);
  const quote = { ...createEmptyQuoteDraft(), priceType: 'FIXED', amount: '2400.00', validUntil: mission.dates.expiry,
    scope: 'Synthetic demonstration comparison of the saved area and requested dates; supplied original scenes and a reviewed finding, with no operator booking or new collection.',
    licence: 'Original Coruscant synthetic material for the intended organization to inspect in this local demonstration.' };
  const draft = await workflowAction(page, mission.id, 'saveQuoteDraft', { quote }, undefined, false);
  await workflowAction(page, mission.id, 'publishQuote', { replacesQuoteId: null }, { id: draft.quoteId, contentVersion: draft.quoteContentVersion });
  await enterCustomer(page); await page.goto(`/workspaces/org-a/service-requests/${mission.id}`);
  await expect(page.locator('.page-heading').getByText('Quote ready', { exact: true })).toBeVisible();
  return { ...mission, quote, quoteId: draft.quoteId as string };
}
async function openDecision(page: Page, decision: Decision) {
  const selected = details(decision);
  await page.getByRole('button', { name: selected.opener, exact: true }).click();
  const panel = page.getByRole('dialog', { name: selected.title, exact: true });
  if (decision === 'DECLINE') await panel.getByLabel('Decline reason', { exact: true }).fill(reason);
  await expect(panel.getByRole('button', { name: selected.confirm, exact: true })).toBeEnabled();
  return panel;
}
async function assertSaved(page: Page, info: TestInfo, id: string, decision: Decision) {
  const selected = details(decision);
  await expect(page.getByRole('dialog', { name: selected.title, exact: true })).toHaveCount(0);
  await expect(page.locator('.saved-notice')).toContainText(selected.message);
  await expect(page.locator('.page-heading').getByText(selected.status, { exact: true })).toBeVisible();
  const row = await read(page, id);
  expect(row.decisions).toHaveLength(1);
  expect(row.decisions[0]!.decision).toBe(decision);
  expect(row.decisions[0]!.reason).toBe(decision === 'DECLINE' ? reason : null);
  expect(row.history.filter(item => item.type === selected.command)).toHaveLength(1);
  if (decision === 'ACCEPT') expect(row.acceptedQuote?.state).toBe('ACCEPTED');
  else { expect(row.acceptedQuote).toBeNull(); expect(row.schedule).toBeNull(); }
  // Read only the isolated browser-test database, never the coordinator's saved records.
  const root = info.config.metadata.dataRoot as string; expect(root).toContain('coruscant-e2e-');
  const db = new DatabaseSync(join(root, 'coruscant.sqlite'), { readOnly: true });
  try {
    expect(db.prepare('SELECT count(*) AS n FROM quote_decisions WHERE request_id=?').get(id)?.n).toBe(1);
    expect(db.prepare('SELECT count(*) AS n FROM request_events WHERE request_id=? AND type=?').get(id, selected.command)?.n).toBe(1);
    expect(db.prepare("SELECT count(*) AS n FROM action_receipts WHERE command_name=? AND json_extract(outcome_json,'$.requestId')=?").get(selected.command, id)?.n).toBe(1);
  } finally { db.close(); }
}

for (const decision of ['ACCEPT', 'DECLINE'] as const) {
  test(`${decision}: confirmed success closes the decision panel before details refresh and records once @quote-decision @slice-04`, async ({ page }, info) => {
    const mission = await offer(page, `Check confirmed ${decision.toLowerCase()} panel completion (${info.project.name}).`), selected = details(decision);
    const panel = await openDecision(page, decision);
    let release!: () => void, committed!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), saved = new Promise<void>(resolve => { committed = resolve; });
    const attempts: unknown[] = [];
    let refreshRelease!: () => void, refreshHeld!: () => void;
    const refreshGate = new Promise<void>(resolve => { refreshRelease = resolve; }), refreshing = new Promise<void>(resolve => { refreshHeld = resolve; });
    let holdRefresh = false;
    const path = `**/api/customer/org-a/requests/${mission.id}`;
    await page.route(path, async route => {
      const response = await route.fetch();
      if (holdRefresh) { refreshHeld(); await refreshGate; }
      try { await route.fulfill({ response }); } catch { /* A covered obsolete read may be aborted. */ }
    });
    await page.route(`**/api/commands/${selected.command}`, async route => {
      attempts.push(route.request().postDataJSON()); const response = await route.fetch();
      expect(response.status(), await response.text()).toBe(200); committed(); await gate;
      await route.fulfill({ response });
    });
    try {
      await panel.getByRole('button', { name: selected.confirm, exact: true }).click();
      await saved;
      // A database commit alone is not a confirmed response in this browser.
      await expect(panel).toBeVisible();
      await expect(panel.getByRole('button', { name: 'Saving decision…', exact: true })).toBeDisabled();
      await expect(page.locator('.saved-notice')).toHaveCount(0);
      holdRefresh = true; release(); await refreshing;
      // Success closes the actual modal and removes inert background even while GET is pending.
      await expect(panel).toHaveCount(0);
      await expect(page.locator('#root')).toHaveJSProperty('inert', false);
      await expect(page.locator('.saved-notice')).toContainText(selected.message);
      expect(attempts).toHaveLength(1);
      refreshRelease(); await page.unroute(path);
      await assertSaved(page, info, mission.id, decision);
      await page.screenshot({ path: info.outputPath(`confirmed-${decision.toLowerCase()}.png`) });
    } finally { release(); refreshRelease(); await page.unroute(`**/api/commands/${selected.command}`); await page.unroute(path); }
  });

  test(`${decision}: lost committed response retains recovery; unchanged receipt closes the panel without a second decision @quote-decision @slice-04`, async ({ page }, info) => {
    const mission = await offer(page, `Recover confirmed ${decision.toLowerCase()} panel completion (${info.project.name}).`), selected = details(decision);
    const panel = await openDecision(page, decision), attempts: unknown[] = [];
    const returned: { outcome: string }[] = [];
    await page.route(`**/api/commands/${selected.command}`, async route => {
      attempts.push(route.request().postDataJSON()); const response = await route.fetch();
      expect(response.status(), await response.text()).toBe(200); returned.push(await response.json());
      if (attempts.length === 1) await route.abort('failed');
      else await route.fulfill({ response });
    });
    try {
      await panel.getByRole('button', { name: selected.confirm, exact: true }).click();
      const retry = panel.getByRole('button', { name: selected.retry, exact: true });
      await expect(retry).toBeEnabled();
      await expect(panel.getByText('Outcome uncertain', { exact: true })).toBeVisible();
      if (decision === 'DECLINE') await expect(panel.getByLabel('Decline reason', { exact: true })).toHaveValue(reason);
      await expect(page.locator('.saved-notice')).toHaveCount(0);
      expect((await read(page, mission.id)).decisions).toHaveLength(1);
      await retry.click();
      await assertSaved(page, info, mission.id, decision);
      expect(attempts).toHaveLength(2); expect(attempts[1]).toEqual(attempts[0]);
      expect(returned.map(item => item.outcome)).toEqual(['saved', 'replayed']);
    } finally { await page.unroute(`**/api/commands/${selected.command}`); }
  });
}

test('superseded decline is refused with its reason retained and no automatic success closure @quote-decision @slice-04', async ({ page, browser }, info) => {
  const mission = await offer(page, `Keep an obsolete declined-offer preparation (${info.project.name}).`);
  const panel = await openDecision(page, 'DECLINE');
  const other = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const staff = await other.newPage(); await enterStaff(staff);
    const draft = await workflowAction(staff, mission.id, 'saveQuoteDraft', { quote: { ...mission.quote, amount: '2600.00' } }, undefined, false);
    await workflowAction(staff, mission.id, 'publishQuote', { replacesQuoteId: mission.quoteId }, { id: draft.quoteId, contentVersion: draft.quoteContentVersion });
    await panel.getByRole('button', { name: 'Confirm decline', exact: true }).click();
    await expect(panel.getByText('Action needs attention', { exact: true })).toBeVisible();
    await expect(panel.getByLabel('Decline reason', { exact: true })).toHaveValue(reason);
    await expect(panel.getByRole('button', { name: 'Confirm decline', exact: true })).toBeDisabled();
    await expect(page.locator('.saved-notice')).toHaveCount(0);
    const current = await read(page, mission.id);
    expect(current.status).toBe('Quote ready'); expect(current.currentQuote!.id).toBe(draft.quoteId);
    expect(current.decisions).toHaveLength(0);
    expect(current.history.filter(item => item.type === 'declineQuote')).toHaveLength(0);
  } finally { await other.close(); }
});
