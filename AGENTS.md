# Agent Instructions

This document provides guidance for AI coding assistants working on the ChatGPT Sidebar extension.

## Development Standards

- **Test-Driven Development**: ALWAYS ensure all tests are passing before committing changes.
- **Continuous Testing**: Ideally, every commit should include corresponding tests (unit, integration, or E2E) for new functionality or bug fixes.
- **Chrome API Mocking**: Use the existing infrastructure in `tests/setup.js` for mocking Chrome APIs. If a new API is used, add its mock definition there.

## Project Architecture

### 1. Per-Tab Isolation
The extension is designed to run independent ChatGPT instances for each browser tab. 
- **Tab Pinning**: Sidepanels are "pinned" to a tab ID via URL parameters (e.g., `sidepanel.html?tabId=123`).
- **Storage Namespacing**: All persistent state (URLs, PDFs, settings) MUST be namespaced with the `tabId` (e.g., `pendingPDF_${tabId}`) to prevent cross-tab contamination.
- **Messaging**: Most messages between background and sidepanel should include a `tabId` to ensure they are handled by the correct instance.

### 2. Testing Pyramid
- **Unit/Integration (Vitest)**: Fast tests for utilities (`background.js`, `utils.js`) and message routing. Run with `npm test`.
- **E2E (Playwright)**: Browser-based tests for UI and cross-extension logic. Run with `npm run test:e2e`. These use Chromium's "new headless" mode (`--headless=new`) to run without a visible window while still supporting extension APIs.

### 3. Background Script Exports
Since `background.js` and `sidepanel.js` are vanilla JS files run in a browser context, we use a specific pattern to export functions for testing in Node.js:
```javascript
if (typeof module !== 'undefined') {
  module.exports = { ... };
}
```
Maintain this pattern when adding new testable functions.

## Site-Specific Logic

### Gmail
- **Print View Hijacking**: For Gmail, the extension navigates a hidden temporary tab to Gmail's native print view (`view=pt`). This is the only reliable way to get high-fidelity email content.
- **Dialog Blocking**: The background script must inject a script to block `window.print()` in the temporary tab to prevent the browser from hanging.

### PDFs
- **Direct Byte Fetching**: For tabs displaying PDFs (detected via URL), the extension attempts to `fetch` the original document bytes directly. This provides the highest fidelity and avoids triggering the "browser is being debugged" notification.
- **Fallback Mechanism**: If direct fetch fails or the content-type is mismatched, it falls back to standard `Page.printToPDF` via the Debugger API.

## Environment Constraints

- **Manifest V3**: The extension strictly follows MV3 patterns (Service Workers, Declarative Net Request).
- **Debugger API**: The `debugger` API is used for PDF generation. Note that only one debugger can be attached to a tab at a time. Always use the reference counting logic in `background.js` to manage attachments.
- **Content Security Policy**: ChatGPT has a strict CSP. Communication is handled via `chrome.storage.local` and message passing rather than direct DOM manipulation across frames.
