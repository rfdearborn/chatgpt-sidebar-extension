import { test, expect } from './extension-fixture.mjs';

test.describe('ChatGPT Sidebar E2E', () => {
  test('should load the sidepanel correctly', async ({ page, extensionId }) => {
    // Navigate to the sidepanel page directly
    await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);

    // Check for the header/logo area
    const toolbarLabel = page.locator('span.toolbar-label');
    await expect(toolbarLabel).toContainText('Share page:');

    // Check for the ChatGPT iframe
    const frame = page.locator('#chatgpt-frame');
    await expect(frame).toBeVisible();
    
    // Check for the Share Page button
    const shareBtn = page.locator('#sharePage');
    await expect(shareBtn).toBeVisible();
    await expect(shareBtn).toContainText('Now');

    // Check for the Auto-attach toggle
    const autoToggle = page.locator('.toggle-container');
    await expect(autoToggle).toBeVisible();
    await expect(autoToggle).toContainText('Auto');
  });

  test('should load chatgpt.com in iframe', async ({ page, extensionId }) => {
    await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    
    const frame = page.locator('#chatgpt-frame');
    // The src should eventually contain the tab ID
    await expect(frame).toHaveAttribute('src', /chatgpt\.com\/.*__sidebarTabId=/);
  });
});
