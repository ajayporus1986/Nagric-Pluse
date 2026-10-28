/**
 * Admin console end-to-end: first sign-in, quorum role grant, module switch,
 * protected modules, kill switch, language, audit verification and error codes.
 * Each staff user gets its own browser context (separate cookies).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { totpAt } from '../../api/dist/security/totp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const state = JSON.parse(readFileSync(path.join(here, '.tmp/state.json'), 'utf8')) as { otps: Record<string, string> };
const NEW_PASSWORD = 'नागरिक pulse e2e 2026 strong';

test.describe.configure({ mode: 'serial' });

/** Pages per user, opened once so each user signs in only once (codes cannot be replayed). */
const pages: Record<string, Page> = {};

/** First sign-in: one-time password → new password → authenticator enrolment. */
async function firstSignIn(browser: Browser, user: string, wrongCodeFirst = false): Promise<Page> {
  const page = await (await browser.newContext({ locale: 'hi-IN' })).newPage();
  await page.goto('/');
  await page.fill('input[name=username]', user);
  await page.fill('input[name=password]', state.otps[user]!);
  await page.click('button[type=submit]');
  await page.fill('input[name=currentPassword]', state.otps[user]!);
  await page.fill('input[name=newPassword]', NEW_PASSWORD);
  await page.fill('input[name=confirmPassword]', NEW_PASSWORD);
  await page.click('button[type=submit]');
  await page.getByTestId('start-mfa').click();
  const secret = (await page.getByTestId('totp-secret').textContent())!.trim();
  if (wrongCodeFirst) {
    await page.fill('input[name=code]', '000000');
    await page.click('button[type=submit]');
    // Errors show the catalogue code and a reference id.
    await expect(page.locator('.error[data-code="NP-MFA-0003"]')).toBeVisible();
    await expect(page.locator('.error-ref')).toContainText('NP-MFA-0003');
  }
  await page.fill('input[name=code]', totpAt(secret, Date.now()));
  await page.click('button[type=submit]');
  await expect(page.getByTestId('whoami')).toBeVisible();
  return page;
}

/** Fills the reason in the proposal dialog, submits, and closes it. */
async function submitProposal(page: Page, reason: string) {
  await page.fill('dialog[open] textarea[name=reason]', reason);
  await page.click('dialog[open] button[type=submit]');
  await expect(page.locator('dialog[open] .ok')).toBeVisible();
  await page.locator('dialog[open] button').last().click();
}

/** Second governor approves the newest pending request of a kind. */
async function approve(page: Page, kind: string) {
  await page.goto('/#/changes');
  await page.reload();
  const card = page.locator(`article[data-kind="${kind}"]`).first();
  await card.getByTestId('approve').click();
  await expect(page.locator('p.ok[role=status]')).toBeVisible();
}

test('first sign-in walks through password change and authenticator enrolment (Hindi by default)', async ({ browser }) => {
  pages.gov1 = await firstSignIn(browser, 'gov1', true);
  await expect(pages.gov1.locator('html')).toHaveAttribute('lang', 'hi');
  pages.gov2 = await firstSignIn(browser, 'gov2');
});

test('a new account gets a role only after a second governor approves', async () => {
  const g1 = pages.gov1!;
  await g1.goto('/#/users');
  await g1.getByTestId('create-user').click();
  await g1.fill('dialog[open] input[name=username]', 'officer1');
  await g1.fill('dialog[open] input[name=displayName]', 'प्रिया शर्मा');
  await g1.click('dialog[open] button[type=submit]');
  await expect(g1.getByTestId('otp')).toHaveText(/^\S{20}$/);
  await g1.locator('tr[data-user="officer1"]').getByTestId('grant-role').click();
  await g1.selectOption('dialog[open] select[name=role]', 'OBSERVER');
  await g1.click('dialog[open] button[type=submit]');
  await submitProposal(g1, 'District observer for the pilot');

  await approve(pages.gov2!, 'ROLE_GRANT');
  await g1.reload();
  await expect(g1.locator('tr[data-user="officer1"]')).toContainText('@ D144');
});

test('a module is switched off in the district only after quorum', async () => {
  const g1 = pages.gov1!;
  await g1.goto('/#/modules');
  await expect(g1.locator('tr[data-feature="demo.items"] .pill-ok')).toBeVisible();
  await g1.locator('article[data-module="demo"]').getByTestId('set-DISABLED').click();
  await submitProposal(g1, 'Pausing demo services for the pilot');
  // Still on until approved.
  await g1.reload();
  await expect(g1.locator('tr[data-feature="demo.items"] .pill-ok')).toBeVisible();

  await approve(pages.gov2!, 'MODULE_SETTING');
  await g1.reload();
  await expect(g1.locator('tr[data-feature="demo.items"] .pill-off')).toBeVisible();
  // The resolver explains why.
  await g1.locator('tr[data-feature="demo.items"] button.link').click();
  await expect(g1.locator('tr[data-feature="demo.items"] .trace')).toContainText('disabled at D144');
  // Screenshot kept with the run's temporary files for visual review.
  await g1.screenshot({ path: path.join(here, '.tmp/modules.png'), fullPage: true });
});

test('protected governance modules offer no switch-off controls', async () => {
  const g1 = pages.gov1!;
  await g1.goto('/#/modules');
  for (const m of ['platform', 'iam', 'audit']) {
    await expect(g1.locator(`article[data-module="${m}"] [data-testid^="set-"]`)).toHaveCount(0);
  }
});

test('a platform operator can stop and lift a module; protected modules are not offered', async ({ browser }) => {
  const sre = await firstSignIn(browser, 'sre1');
  await sre.goto('/#/kill');
  const options = await sre.locator('select[name=moduleId] option').allTextContents();
  expect(options.join('|')).not.toMatch(/ऑडिट|Audit/);
  await sre.selectOption('select[name=moduleId]', 'demo');
  await sre.fill('textarea[name=reason]', 'Demo module overloading the database');
  await sre.click('form button[type=submit]');
  await expect(sre.locator('tr[data-kill="demo"] .pill-warn')).toBeVisible();
  await sre.locator('tr[data-kill="demo"]').getByTestId('clear-kill').click();
  await expect(sre.locator('tr[data-kill="demo"] .pill-info')).toBeVisible();
});

test('language switches to English and back', async () => {
  const g1 = pages.gov1!;
  await g1.goto('/#/modules');
  await g1.getByTestId('lang-toggle').click();
  await expect(g1.locator('html')).toHaveAttribute('lang', 'en');
  await expect(g1.locator('nav.tabs')).toContainText('Change requests');
  await g1.getByTestId('lang-toggle').click();
  await expect(g1.locator('nav.tabs')).toContainText('परिवर्तन अनुरोध');
});

test('errors show the specific code and a reference', async () => {
  const g1 = pages.gov1!;
  await g1.goto('/#/users');
  await g1.getByTestId('create-user').click();
  await g1.fill('dialog[open] input[name=username]', 'gov2');
  await g1.fill('dialog[open] input[name=displayName]', 'Duplicate');
  await g1.click('dialog[open] button[type=submit]');
  await expect(g1.locator('dialog[open] .error[data-code="NP-USER-0001"]')).toBeVisible();
  await expect(g1.locator('dialog[open] .error-ref')).toContainText(/NP-USER-0001 · .+ [0-9a-f-]{36}/);
  await g1.screenshot({ path: path.join(here, '.tmp/error.png') });
  await g1.keyboard.press('Escape');
});

test('audit log shows the actions and verifies with a signed checkpoint', async () => {
  const g1 = pages.gov1!;
  await g1.goto('/#/audit');
  // The worker relays every 300 ms and signs a checkpoint at least every 10 s.
  await expect(async () => {
    await g1.reload();
    await expect(g1.locator('tr[data-action="platform.change_request.applied"]').first()).toBeVisible();
  }).toPass({ timeout: 15_000 });
  await expect(g1.locator('tr[data-action="iam.mfa.enrolled"]').first()).toBeVisible();
  await expect(async () => {
    await g1.getByTestId('verify-ledger').click();
    await expect(g1.locator('[data-verify="ok"]')).toContainText(/[1-9]\d* (signed checkpoints|हस्ताक्षरित)/);
  }).toPass({ timeout: 20_000 });
});
