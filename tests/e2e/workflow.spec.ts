import { interpretNeed, makeDiscoveryDictionary } from '../../shared/discovery.js';
import { test, expect, type Page } from '@playwright/test';
import type { RequestProjection } from '../../shared/contracts.js';
import { revisionToInput } from '../../shared/workflow.js';
import { currentContext, enterCustomer, enterStaff, newRequest } from './helpers.js';

test.setTimeout(90_000);
async function read(page: Page, id: string, staff = false): Promise<RequestProjection> {
  const response = await page.request.get(staff ? `/api/staff/requests/${id}` : `/api/customer/org-a/requests/${id}`);
  expect(response.status()).toBe(200);
  return response.json() as Promise<RequestProjection>;
}
async function staffRequest(page: Page, id: string) {
  await enterStaff(page); await page.goto(`/staff/requests/${id}`);
}
async function customerRequest(page: Page, id: string, persona = 'a-owner') {
  await enterCustomer(page, persona); await page.goto(`/workspaces/org-a/service-requests/${id}`);
}
async function fillQuote(page: Page, expiry: string, scope: string, range = false, save = true) {
  await page.getByRole('combobox', { name: 'Price type', exact: true }).selectOption(range ? 'RANGE' : 'FIXED');
  if (range) {
    await page.getByLabel('Range minimum', { exact: true }).fill('2200.00');
    await page.getByLabel('Range maximum', { exact: true }).fill('2800.00');
  } else await page.getByLabel('Fixed amount', { exact: true }).fill('2400.00');
  await expect(page.getByLabel('Currency', { exact: true })).toHaveValue('USD');
  await page.getByLabel('Scope of work', { exact: true }).fill(scope);
  await page.getByLabel('Licence and permitted use', { exact: true }).fill('Original synthetic demonstration material for this organization to inspect. No real collection or third-party rights are implied.');
  await page.getByLabel('Valid until (UTC)', { exact: true }).fill(expiry);
  if (save) {
    await page.getByRole('button', { name: 'Save draft', exact: true }).click();
    await expect(page.getByText(/Saved as draft/).first()).toBeVisible();
  }
}
async function publish(page: Page) {
  await page.getByRole('button', { name: 'Publish quote…', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm publish', exact: true }).click();
  await expect(page.locator('.page-heading').getByText('Quote ready', { exact: true })).toBeVisible();
}

test('clarify and revise → private quote → authorized range acceptance → same recorded schedule @slice-02', async ({ page }, info) => {
  if (info.project.name === 'webkit') await page.setViewportSize({ width: 390, height: 844 });
  const purpose = `Compare the fictional estuary's baseline and recent water pattern (${info.project.name}).`;
  const mission = await newRequest(page, purpose, false);
  await staffRequest(page, mission.id);
  await page.getByRole('button', { name: 'Start review', exact: true }).click();
  const question = 'Please resolve the requested planning window before we can publish a demonstration quote.';
  await page.getByRole('button', { name: 'Ask customer', exact: true }).click();
  await page.getByLabel('Message', { exact: true }).fill(question);
  await page.getByRole('button', { name: 'Preview question', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm question', exact: true }).click();
  await expect.poll(async () => (await read(page, mission.id, true)).status).toBe('Needs information');

  await customerRequest(page, mission.id, 'a-requester');
  await expect(page.getByText(question, { exact: true }).first()).toBeVisible();
  await expect(page.getByText('No quote yet', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Revise brief', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Timing to be discussed', exact: true }).uncheck();
  await page.getByLabel('Window start (local)', { exact: true }).fill(mission.dates.start);
  await page.getByLabel('Window end (local)', { exact: true }).fill(mission.dates.end);
  await page.getByRole('button', { name: 'Review revised brief', exact: true }).click();
  await page.getByRole('button', { name: 'Save revised brief', exact: true }).click();
  await expect.poll(async () => (await read(page, mission.id)).briefRevision).toBe(2);
  const revised = await read(page, mission.id);
  expect(revised.status).toBe('In review');
  expect(revised.brief.contact).toEqual(mission.saved.brief.contact);
  expect(revised.evidence).toEqual(mission.saved.evidence);
  expect(revised.brief.baselineDate).toBe(mission.catalog.demo.baselineDate);
  await page.getByRole('button', { name: 'Reply to the team', exact: true }).click();
  await page.getByLabel('Message', { exact: true }).fill('The proposed window is now recorded in the revised brief.');
  await page.getByRole('button', { name: 'Preview reply', exact: true }).click();
  await page.getByRole('button', { name: 'Edit message', exact: true }).click();
  await page.getByLabel('Message', { exact: true }).fill('The requested planning window is now recorded; synthetic image dates remain separate.');
  await expect(page.getByRole('button', { name: 'Confirm reply', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Preview reply', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm reply', exact: true }).click();

  await staffRequest(page, mission.id);
  await fillQuote(page, mission.dates.expiry, `Demonstration SAR/Imagery comparison for the confirmed circle. Requested Baseline ${mission.catalog.demo.baselineDate}, Recent ${mission.catalog.demo.recentDate}, UTC; supplied material is synthetic. Include two images and a staff finding. No operator booking, real collection or payment.`, true);
  await page.getByRole('heading', { name: 'Prepare a quote', exact: true }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('staff-quote.png') });
  const staffDraft = await read(page, mission.id, true);
  await customerRequest(page, mission.id, 'a-requester');
  const privateHidden = await read(page, mission.id);
  expect(privateHidden).not.toHaveProperty('quoteDrafts');
  expect(JSON.stringify(privateHidden)).not.toContain('2200.00');
  await expect(page.getByText('No quote yet', { exact: true })).toBeVisible();
  await staffRequest(page, mission.id);
  const unsentQuestion = `Earlier unsent question stays a question (${info.project.name}).`;
  await page.getByRole('button', { name: 'Ask customer', exact: true }).click();
  await page.getByLabel('Message', { exact: true }).fill(unsentQuestion);
  await publish(page);
  await expect(page.getByText(unsentQuestion, { exact: true })).toBeVisible();
  expect((await read(page, mission.id, true)).messages.some(item => item.message === unsentQuestion)).toBe(false);
  await customerRequest(page, mission.id, 'a-requester');
  await expect(page.getByText(/Ask your workspace owner/).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Accept quote…', exact: true })).toHaveCount(0);
  const published = await read(page, mission.id);
  expect(published.currentQuote?.terms.minimum).toBe('2200.00');
  expect(published.currentQuote?.terms.maximum).toBe('2800.00');
  expect(staffDraft.reference).toBe(published.reference);

  await customerRequest(page, mission.id);
  await page.getByRole('button', { name: 'Accept quote…', exact: true }).click();
  await expect(page.getByText('This records intent on behalf of your organization. It is not a payment or a tasking command.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Confirm acceptance', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Confirm acceptance', exact: true })).toHaveCount(0);
  await expect(page.locator('.page-heading').getByText('Accepted', { exact: true })).toBeVisible();
  await expect(page.locator('.saved-notice')).toContainText('Quote accepted. Our team will schedule the mission.');
  await expect(page.getByRole('button', { name: 'Revise brief', exact: true })).toHaveCount(0);
  const accepted = await read(page, mission.id);
  expect(accepted.decisions).toHaveLength(1);
  expect(accepted.history.filter(event => event.type === 'acceptQuote')).toHaveLength(1);
  expect(accepted.acceptedQuote?.terms.priceType).toBe('RANGE');
  expect(accepted.acceptedQuote?.terms.minimum).toBe('2200.00');

  await staffRequest(page, mission.id);
  await page.getByLabel('Provider / operator', { exact: true }).fill('Coruscant demonstration planning team');
  await page.getByLabel('Planned start (local)', { exact: true }).fill(mission.dates.planStart);
  await page.getByLabel('Planned end (local)', { exact: true }).fill(mission.dates.planEnd);
  await page.getByLabel('Schedule timezone', { exact: true }).fill('UTC');
  await page.getByLabel('Schedule notes', { exact: true }).fill('This records a demonstration plan; operator agreement and execution are unconfirmed.');
  await page.getByRole('button', { name: 'Review schedule…', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm schedule', exact: true }).click();
  await expect.poll(async () => (await read(page, mission.id, true)).status).toBe('Scheduled');
  const planned = await read(page, mission.id, true);
  expect(planned.schedule?.trackedItemIds).toEqual([]);
  await customerRequest(page, mission.id);
  await page.goto(`/workspaces/org-a/missions/${mission.id}`);
  await expect(page.getByText('Coruscant demonstration planning team', { exact: true })).toBeVisible();
  await expect(page.getByText(/No tracked spacecraft/i).first()).toBeVisible();
  await page.reload();
  const reopened = await read(page, mission.id);
  expect(reopened.schedule?.id).toBe(planned.schedule?.id);
  expect(reopened.acceptedQuote?.id).toBe(accepted.acceptedQuote?.id);
  expect(reopened.reference).toBe(mission.reference);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('scheduled-mission.png') });
});

test('private draft survives permitted navigation and a covered access failure without leaking to another actor @slice-02', async ({ page }, info) => {
  const mission = await newRequest(page, `Review private draft retention for the fictional estuary (${info.project.name}).`);
  await staffRequest(page, mission.id);
  await page.getByRole('button', { name: 'Start review', exact: true }).click();
  const marker = `Unsent staff scope for this request only (${info.project.name}).`;
  await page.getByLabel('Scope of work', { exact: true }).fill(marker);
  await page.getByRole('link', { name: 'StarSearch', exact: true }).click();
  const prompt = page.getByRole('dialog', { name: 'Keep your private draft?', exact: true });
  await prompt.getByRole('button', { name: 'Stay here', exact: true }).click();
  await expect(page.getByLabel('Scope of work', { exact: true })).toHaveValue(marker);
  await page.getByRole('link', { name: 'StarSearch', exact: true }).click();
  await prompt.getByRole('button', { name: 'Keep draft and continue', exact: true }).click();
  await page.goBack();
  await expect(page.getByLabel('Scope of work', { exact: true })).toHaveValue(marker);
  let fail = true;
  await page.route('**/api/context', async route => {
    if (fail) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'TEST_CHECK_FAILURE', message: 'Test-only temporary access-check failure.' }) });
    else await route.continue();
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('heading', { name: 'Check account', exact: true })).toBeVisible();
  await expect(page.getByLabel('Scope of work', { exact: true })).toHaveCount(0);
  await expect(page.getByText(marker, { exact: true })).toHaveCount(0);
  fail = false;
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByLabel('Scope of work', { exact: true })).toHaveValue(marker);
  await page.unroute('**/api/context');
  // Leave through the app's guarded navigation so its same-tab memory stays in its original scope.
  await page.getByRole('link', { name: 'StarSearch', exact: true }).click();
  await prompt.getByRole('button', { name: 'Keep draft and continue', exact: true }).click();
  await page.getByRole('link', { name: /Staff Admin/ }).click();
  await page.getByRole('link', { name: 'Customer access', exact: true }).click();
  await page.getByRole('combobox', { name: 'Demonstration customer', exact: true }).selectOption('a-owner');
  await page.getByRole('button', { name: 'Continue to workspace', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Requests', exact: true })).toBeVisible();
  await page.getByRole('link').filter({ hasText: mission.reference }).first().click();
  await expect(page.getByText(marker, { exact: true })).toHaveCount(0);
  expect(JSON.stringify(await read(page, mission.id))).not.toContain(marker);
});

test('a lost private-draft response survives covered refresh and reuses the original action once @slice-02', async ({ page }, info) => {
  const mission = await newRequest(page, `Recover one private quote save after a connection loss (${info.project.name}).`);
  await staffRequest(page, mission.id);
  await page.getByRole('button', { name: 'Start review', exact: true }).click();
  const scope = 'Synthetic comparison only. Keep this exact unsent scope and its logical action through the access cover.';
  await fillQuote(page, mission.dates.expiry, scope, false, false);
  const attempts: { commandId: string; target: unknown; expected: unknown; payload: unknown }[] = [];
  let lost = false;
  await page.route('**/api/commands/saveQuoteDraft', async route => {
    attempts.push(route.request().postDataJSON());
    if (lost) { await route.continue(); return; }
    lost = true;
    const committed = await route.fetch();
    expect(committed.ok()).toBe(true);
    await route.abort('failed');
  });
  await page.getByRole('button', { name: 'Save draft', exact: true }).click();
  await expect(page.getByText('Outcome uncertain', { exact: true }).first()).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const retry = page.getByRole('region', { name: 'Quote authoring', exact: true }).getByRole('button', { name: 'Retry same draft save', exact: true });
  await expect(retry).toBeVisible();
  await expect(page.getByLabel('Scope of work', { exact: true })).toHaveValue(scope);
  await retry.click();
  await expect(page.getByText(/Saved as draft/).first()).toBeVisible();
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  const projected = await (await page.request.get(`/api/staff/requests/${mission.id}`)).json();
  expect(projected.quoteDrafts).toHaveLength(1);
  expect(projected.quoteDrafts[0].terms.scope).toBe(scope);
  expect(projected.status).toBe('In review');
});

test('a reasoned decline returns the same request for review without scheduling @slice-02', async ({ page }, info) => {
  const mission = await newRequest(page, `Review a declined synthetic estuary quotation (${info.project.name}).`);
  await staffRequest(page, mission.id);
  await page.getByRole('button', { name: 'Start review', exact: true }).click();
  await fillQuote(page, mission.dates.expiry, 'Demonstration-only supplied comparison; no new acquisition or operator agreement.');
  await publish(page);
  await customerRequest(page, mission.id);
  await page.getByRole('button', { name: 'Decline…', exact: true }).click();
  const reason = 'Please review this demonstration offer; the proposed price does not meet this example budget.';
  await page.getByLabel('Decline reason', { exact: true }).fill(reason);
  await page.getByRole('button', { name: 'Confirm decline', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Decline this quote?', exact: true })).toHaveCount(0);
  await expect(page.locator('.page-heading').getByText('In review', { exact: true })).toBeVisible();
  await expect(page.locator('.saved-notice')).toContainText('Quote declined. Our team can review your request and prepare another quote.');
  const declined = await read(page, mission.id);
  expect(declined.decisions).toHaveLength(1);
  expect(declined.history.filter(event => event.type === 'declineQuote')).toHaveLength(1);
  expect(declined.decisions).toEqual(expect.arrayContaining([expect.objectContaining({ decision: 'DECLINE', reason })]));
  expect(declined.schedule).toBeNull();
  expect(declined.acceptedQuote).toBeNull();
  await staffRequest(page, mission.id);
  await page.getByText('Earlier quotes', { exact: true }).click();
  await expect(page.getByText(reason, { exact: false }).first()).toBeVisible();
});

test('unsaved quote terms stay with their original brief when a customer revises it @slice-02', async ({ page, browser }, info) => {
  const mission = await newRequest(page, `Keep earlier quote preparation with its own brief (${info.project.name}).`);
  await staffRequest(page, mission.id);
  await page.getByRole('button', { name: 'Start review', exact: true }).click();
  const marker = `Unsent revision-one scope only (${info.project.name}).`;
  await page.getByLabel('Scope of work', { exact: true }).fill(marker);
  const otherContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  try {
    const customer = await otherContext.newPage();
    await enterCustomer(customer);
    const context = await currentContext(customer);
    const row = await read(customer, mission.id);
    const brief = revisionToInput(row.brief);
    brief.purpose = `${row.brief.purpose} Revised comparison question.`;
    // This actor deliberately keeps the same area for the revised question.
    brief.areaReviewedPurpose = brief.purpose;
    const catalog = await (await customer.request.get('/api/public/catalog')).json();
    if (brief.discovery) brief.discovery = interpretNeed({ text: brief.purpose, generation: brief.discovery.generation + 1, manual: brief.discovery.manual, dictionary: makeDiscoveryDictionary(catalog.items) });
    const envelope = { commandId: crypto.randomUUID(), contextGeneration: context.contextGeneration, contextToken: context.contextToken,
      target: { requestId: row.id }, expected: { requestVersion: row.requestVersion, briefRevision: row.briefRevision }, payload: { brief } };
    const headers = { 'x-coruscant-csrf': context.csrfToken!, origin: new URL(customer.url()).origin };
    const preview = await customer.request.post('/api/command-reviews/reviseBrief', { headers, data: envelope });
    expect(preview.status(), await preview.text()).toBe(200);
    const confirmation = await preview.json();
    const saved = await customer.request.post('/api/commands/reviseBrief', { headers, data: { ...envelope, reviewToken: confirmation.reviewToken } });
    expect(saved.status()).toBe(200);
    await page.getByRole('button', { name: 'Refresh request', exact: true }).click();
    await expect(page.getByText('Your unsent preparation belongs to an earlier brief.', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Scope of work', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Review current brief and start fresh draft', exact: true }).click();
    await expect(page.getByLabel('Scope of work', { exact: true })).toHaveValue('');
    await page.getByText('Earlier private drafts · staff only', { exact: true }).click();
    await expect(page.getByText(marker, { exact: true })).toBeVisible();
    await expect(page.getByText('Unsent prior preparation', { exact: true })).toBeVisible();
    const staff = await (await page.request.get(`/api/staff/requests/${mission.id}`)).json();
    expect(staff.quoteDrafts).toHaveLength(0);
    expect(staff.briefRevision).toBe(2);
  } finally { await otherContext.close(); }
});
