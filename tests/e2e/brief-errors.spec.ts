import { test, expect } from '@playwright/test';

// Public, unsaved browser input only: no provider lookup, persona or workflow record.
test('invalid numeric area fields announce the visible error and correction clears that association @slice-09 @r022', async ({ page }) => {
  await page.goto('/?brief=edit');
  const brief = page.getByRole('dialog', { name: 'Your request', exact: true });
  await expect(brief).toBeVisible();
  await brief.getByLabel('Mission purpose', { exact: true }).fill('Review coordinate validation for a deliberately chosen coastal area.');
  const use = brief.getByRole('button', { name: 'Use these coordinates', exact: true });
  const confirmation = brief.getByRole('checkbox', { name: 'I chose this target and checked the area size.', exact: true });
  await use.click(); await confirmation.check();
  const cases = [
    { name: 'latitude', label: 'Centre latitude', invalid: '91', corrected: '45.123', error: 'Enter a latitude from −90 to 90; blank is not zero.' },
    { name: 'longitude', label: 'Centre longitude', invalid: '-181', corrected: '-9.7', error: 'Enter a longitude from −180 to 180; blank is not zero.' },
    { name: 'radiusKm', label: 'Radius (km)', invalid: '0', corrected: '0.5', error: 'Enter a finite radius of at least 0.001 km.' },
  ];
  for (const value of cases) {
    const field = brief.getByLabel(value.label, { exact: true }), error = brief.locator(`#error-${value.name}`);
    await field.fill(value.invalid); await use.click();
    await expect(field).toHaveValue(value.invalid);
    await expect(error).toBeVisible(); await expect(error).toHaveText(value.error);
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await expect(field).toHaveAttribute('aria-describedby', `error-${value.name}`);
    await expect(field).toHaveAccessibleDescription(value.error);
    // Invalid preparation never replaces or unconfirms the already applied target.
    await expect(confirmation).toBeChecked();
    await field.fill(value.corrected); await use.click();
    await expect(field).toHaveValue(value.corrected);
    await expect(error).toHaveCount(0);
    await expect(field).toHaveAttribute('aria-invalid', 'false');
    await expect(field).not.toHaveAttribute('aria-describedby', /\S/);
    await expect(field).toHaveAccessibleDescription('');
    // Valid application is deliberate and still needs a separate size confirmation.
    await expect(confirmation).not.toBeChecked(); await confirmation.check();
  }
});
