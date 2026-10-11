/**
 * Playwright E2E: Operations page (Slice 6)
 *
 * Exercises the observable operations contract in a real browser: a job appears
 * with its state and retry count, running the worker moves it to completed, and
 * activity records the transition.
 */

import { expect, test } from '@playwright/test';
import sharp from 'sharp';
import { writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

test.describe('Operations page', () => {
  test('shows job state and activity, and completes a worker pass', async ({ page }) => {
    await page.goto('/');
    await page.click('text=Continue as Guest');
    await expect(page.locator('[data-testid="app-nav"]')).toBeVisible();

    // Seed one real image so a thumbnail job has work to do.
    const photo = join(tmpdir(), 'ops-e2e-photo.png');
    writeFileSync(
      photo,
      await sharp({
        create: { width: 800, height: 600, channels: 3, background: { r: 90, g: 60, b: 160 } },
      })
        .png()
        .toBuffer()
    );
    await page.locator('[data-testid="file-upload"]').setInputFiles(photo);
    await expect(page.getByText('ops-e2e-photo.png').first()).toBeVisible();
    await page
      .locator('[data-testid="app-nav"]')
      .getByRole('button', { name: 'Operations', exact: true })
      .click();

    // The operations section is present with its counters.
    await expect(page.getByRole('heading', { name: 'Jobs', exact: true })).toBeVisible();
    await expect(page.getByText('Queued', { exact: true })).toBeVisible();
    await expect(page.getByText('Failed', { exact: true })).toBeVisible();

    // Enqueue a thumbnail job for the uploaded file via the API surface the UI uses.
    const enqueued = await page.evaluate(async () => {
      const token = localStorage.getItem('octo_token');
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

      const workspaces = await (await fetch('/api/workspaces', { headers })).json();
      const workspaceId = workspaces[0].id;
      const files = await (await fetch(`/api/files?workspaceId=${workspaceId}`, { headers })).json();
      const file = files.find((f: { name: string }) => f.name === 'ops-e2e-photo.png');

      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          workspaceId,
          jobType: 'thumbnail',
          idempotencyKey: `e2e-thumb-${file.id}`,
          payload: { fileId: file.id, storageKey: file.storageKey, mimeType: file.mimeType },
        }),
      });
      return { status: res.status, body: await res.json(), workspaceId };
    });

    expect(enqueued.status).toBe(201);
    expect(enqueued.body.job.state).toBe('queued');

    // A duplicate enqueue with the same key must not create a second job.
    const duplicate = await page.evaluate(async (workspaceId: string) => {
      const token = localStorage.getItem('octo_token');
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
      const files = await (await fetch(`/api/files?workspaceId=${workspaceId}`, { headers })).json();
      const file = files.find((f: { name: string }) => f.name === 'ops-e2e-photo.png');

      const res = await fetch('/api/jobs', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          workspaceId,
          jobType: 'thumbnail',
          idempotencyKey: `e2e-thumb-${file.id}`,
          payload: { fileId: file.id, storageKey: file.storageKey, mimeType: file.mimeType },
        }),
      });
      const body = await res.json();
      const jobs = await (await fetch(`/api/jobs?workspaceId=${workspaceId}`, { headers })).json();
      return { created: body.created, jobCount: jobs.length };
    }, enqueued.workspaceId);

    expect(duplicate.created).toBe(false);
    expect(duplicate.jobCount).toBe(1);

    // The worker pass button refreshes job state after running, so no reload is
    // needed to observe the transition.
    await page.click('button:has-text("Run worker pass")');

    // The job completes and activity records the transition.
    await expect(page.getByText('completed').first()).toBeVisible({ timeout: 30000 });
    await expect(page.getByText(/Job thumbnail completed/)).toBeVisible({ timeout: 30000 });
  });

  test('operations data is not reachable anonymously', async ({ page }) => {
    const jobs = await page.request.get('/api/jobs?workspaceId=any');
    expect(jobs.status()).toBe(401);

    const activity = await page.request.get('/api/activity?workspaceId=any');
    expect(activity.status()).toBe(401);
  });
});
