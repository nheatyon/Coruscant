import { test, expect, type Page } from '@playwright/test';
import { extractPlacePhrase } from '../../shared/place-phrase.js';
import { chooseDemonstrationCatalog } from './helpers.js';

async function localQuestionControls(page: Page) {
  const lookupAttempts: string[] = [];
  // An extraction regression must not become a geocoding/provider request.
  await page.route('**/api/place-lookups', async route => { lookupAttempts.push(route.request().url()); await route.abort('blockedbyclient'); });
  await page.goto('/'); await chooseDemonstrationCatalog(page);
  const question = page.getByLabel('Search satellites and services', { exact: true });
  if (!await question.isVisible()) await page.getByRole('button', { name: 'Discover', exact: true }).click();
  await expect(question).toBeVisible();
  return { question, phrase: page.getByLabel('Place phrase', { exact: true }), lookupAttempts };
}

test('local place extraction keeps abbreviations and exact source fragments before requirements or timing without lookup @slice-09 @place-extraction @r022', async ({ page }) => {
  const { question, phrase, lookupAttempts } = await localQuestionControls(page);
  const cases: [string, string][] = [
    ['Visible imagery of Dublin, 1 m resolution', 'Dublin'],
    ['Visible imagery of St. Louis, 1 m resolution', 'St. Louis'],
    ['Visible imagery of Washington, D.C., 1 m resolution', 'Washington, D.C.'],
    ['Visible imagery of Dublin next week', 'Dublin'],
    ['Visible imagery near “Cork”.', 'Cork'],
    ['Observe "St. Louis, Missouri" with a requested window.', 'St. Louis, Missouri'],
    ['Thermal imagery near St. Louis, Missouri next month.', 'St. Louis, Missouri'],
    ['SAR imagery near Mt. Cook, New Zealand during the requested window.', 'Mt. Cook, New Zealand'],
    ['SWIR imagery over lower hutt, new zealand with 20 m resolution.', 'lower hutt, new zealand'],
  ];
  for (const [text, expected] of cases) {
    await question.fill(text); await expect(phrase).toHaveValue(expected); await expect(question).toHaveValue(text);
    const extracted = extractPlacePhrase(text);
    expect(extracted.state).toBe('ready'); expect(extracted.phrase).toBe(expected);
    expect(extracted.span).toEqual({ start: text.indexOf(expected), end: text.indexOf(expected) + expected.length });
    expect(text.slice(extracted.span!.start, extracted.span!.end)).toBe(expected);
    await expect(page.getByText('Exact locally extracted fragment, separate from your mission question.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Find place', exact: true })).toBeEnabled();
  }
  expect(lookupAttempts).toHaveLength(0);
  await expect(page.getByRole('button', { name: 'Apply proposed location', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Current area and place names', exact: true }).first()).toContainText('No area applied');
});

test('ambiguous or negated local clauses need a deliberate phrase correction and editing still sends nothing @slice-09 @place-extraction @r022', async ({ page }) => {
  const { question, phrase, lookupAttempts } = await localQuestionControls(page);
  for (const [text, corrected] of [
    ['Visible imagery of Dublin / Cork, 1 m resolution.', 'Dublin'],
    ['Do not image near St. Louis, 1 m resolution.', 'St. Louis'],
    ['Do not image near “Cork”.', 'Cork'],
    ['No observations over “Nuuk”.', 'Nuuk'],
    ['Visible imagery of St. Louis and near Washington, D.C. next week.', 'Washington, D.C.'],
  ]) {
    await question.fill(text!); await expect(phrase).toHaveValue('');
    expect(extractPlacePhrase(text!).state).toBe('review');
    await expect(page.getByRole('button', { name: 'Find place', exact: true })).toBeDisabled();
    await phrase.fill(corrected!); await expect(phrase).toHaveValue(corrected!); await expect(question).toHaveValue(text!);
    await expect(page.getByRole('button', { name: 'Find place', exact: true })).toBeEnabled();
  }
  expect(lookupAttempts).toHaveLength(0);
  await expect(page.getByRole('button', { name: 'Apply proposed location', exact: true })).toHaveCount(0);
});
