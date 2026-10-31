import { readFileSync } from 'node:fs';

import { expect, type APIRequestContext, test } from '@playwright/test';

/** The Google Drive connect flow as the user's browser sees it (SPEC §11, §16). */

const { key } = JSON.parse(readFileSync('/tmp/media-e2e.json', 'utf8')) as { key: string };

/** A fresh consent link; the browser then plays Google's redirect back with its state. */
async function consent(request: APIRequestContext, user: string) {
  const response = await request.post('/v1/drive/connect', {
    headers: { authorization: `Bearer ${key}`, 'x-user-id': user },
  });
  expect(response.status()).toBe(200);
  return new URL(((await response.json()) as { consent_url: string }).consent_url);
}

test('the consent link goes to Google with drive.file and offline access', async ({ request }) => {
  const url = await consent(request, 'link-check');
  expect(url.origin).toBe('https://accounts.google.com');
  expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:4310/oauth/google/callback');
  expect(url.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/drive.file');
  expect(url.searchParams.get('access_type')).toBe('offline');
});

test('the callback page confirms the connection, and the link works once', async ({
  page,
  request,
}, info) => {
  const url = await consent(request, `user-${info.project.name}`);
  const callback = `/oauth/google/callback?state=${url.searchParams.get('state') ?? ''}&code=4%2Fgranted`;
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  const response = await page.goto(callback);
  expect(response?.status()).toBe(200);
  expect(response?.headers()['content-security-policy']).toContain("default-src 'none'");
  await expect(page).toHaveTitle('Google Drive connected');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Google Drive connected');
  await expect(
    page.getByText('Connected as e2e@example.com. You can close this window.'),
  ).toBeVisible();
  // Fits the screen: no horizontal scrolling on a phone.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(errors).toEqual([]);

  const again = await page.goto(callback);
  expect(again?.status()).toBe(400);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Google Drive not connected');
  await expect(page.getByText(/expired or was already used/)).toBeVisible();

  const status = await request.get('/v1/drive/status', {
    headers: { authorization: `Bearer ${key}`, 'x-user-id': `user-${info.project.name}` },
  });
  expect(await status.json()).toMatchObject({ connected: true, google_email: 'e2e@example.com' });
});

test('a declined consent says so, in light and dark mode', async ({ page, request }, info) => {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    const url = await consent(request, `declined-${info.project.name}-${scheme}`);
    await page.goto(
      `/oauth/google/callback?state=${url.searchParams.get('state') ?? ''}&error=access_denied`,
    );
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Google Drive not connected');
    await expect(page.getByText('Google Drive access was not granted.')).toBeVisible();
    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(background).toBe(scheme === 'dark' ? 'rgb(18, 21, 27)' : 'rgb(246, 247, 249)');
  }
});
