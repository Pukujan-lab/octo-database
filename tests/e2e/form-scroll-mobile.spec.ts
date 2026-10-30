import { expect, test, type Locator } from '@playwright/test';

test.use({ viewport: { width: 390, height: 640 }, hasTouch: true });

test('a phone can swipe a tall form inside the dialog', async ({ page }) => {
  const viewportHeight = 640;
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue as Guest' }).click();
  await page.getByRole('button', { name: /new workspace/i }).first().click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const scroller = dialog.locator('[data-dialog-scroll]');
  const title = dialog.getByRole('heading', { name: 'New workspace' });
  const submit = dialog.getByRole('button', { name: 'Create workspace' });
  const description = dialog.locator('#ws-description');
  await expect(title).toBeVisible();
  await expect(submit).toBeVisible();

  const metrics = await scroller.evaluate((node) => {
    const style = getComputedStyle(node);
    const shell = getComputedStyle(node.parentElement!);
    return {
      overflowY: style.overflowY,
      transform: style.transform,
      touchAction: style.touchAction,
      position: style.position,
      shellOverflow: shell.overflowY,
      shellPosition: shell.position,
      clientHeight: node.clientHeight,
      scrollHeight: node.scrollHeight,
      fontSize: parseFloat(getComputedStyle(node.ownerDocument.querySelector('#ws-description')!).fontSize),
    };
  });
  expect(metrics.overflowY).toBe('auto');
  expect(metrics.transform).toBe('none');
  expect(metrics.position).not.toBe('fixed');
  expect(metrics.shellPosition).toBe('fixed');
  expect(metrics.shellOverflow).toBe('hidden');
  expect(metrics.touchAction).toContain('pan-y');
  expect(metrics.clientHeight).toBeLessThanOrEqual(viewportHeight);
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight + 8);
  expect(metrics.fontSize).toBeGreaterThanOrEqual(16);

  await expectFullyInView(title, viewportHeight);
  const submitBefore = await submit.boundingBox();
  expect(submitBefore).not.toBeNull();
  expect(submitBefore!.y).toBeGreaterThan(viewportHeight - 8);

  const box = await scroller.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, Math.min(320, viewportHeight - 40));
  const beforeWheel = await scroller.evaluate((node) => node.scrollTop);
  await page.mouse.wheel(0, 280);
  await expect.poll(async () => scroller.evaluate((node) => node.scrollTop)).toBeGreaterThan(beforeWheel + 40);
  const pageScroll = await page.evaluate(() => document.documentElement.scrollTop + document.body.scrollTop);
  expect(pageScroll).toBe(0);

  await scroller.evaluate((node) => {
    node.scrollTop = 0;
  });
  const session = await page.context().newCDPSession(page);
  const startY = 420;
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: 180, y: startY, id: 1 }],
  });
  for (const y of [390, 360, 330, 300, 270, 240]) {
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: 180, y, id: 1 }],
    });
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(async () => scroller.evaluate((node) => node.scrollTop)).toBeGreaterThan(30);

  await submit.scrollIntoViewIfNeeded();
  await expectFullyInView(submit, viewportHeight);
  await title.scrollIntoViewIfNeeded();
  await expectFullyInView(title, viewportHeight);
  await description.click();
  await expect(description).toBeFocused();
});

async function expectFullyInView(locator: Locator, viewportHeight: number): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(-1);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewportHeight + 1);
}
