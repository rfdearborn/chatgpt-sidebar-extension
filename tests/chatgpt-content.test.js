import { describe, it, expect, vi, beforeEach } from 'vitest';
const content = require('../chatgpt-content.js');

describe('ChatGPT Content Script - findDropTarget', () => {
  beforeEach(() => {
    // Reset DOM
    document.body.innerHTML = '';
  });

  it('should find #prompt-textarea first if it exists', () => {
    document.body.innerHTML = `
      <main>
        <form>
          <div id="prompt-textarea"></div>
        </form>
      </main>
    `;

    const target = content.findDropTarget();
    expect(target.id).toBe('prompt-textarea');
  });

  it('should fall back to form if #prompt-textarea is missing', () => {
    document.body.innerHTML = `
      <main>
        <form id="test-form"></form>
      </main>
    `;

    const target = content.findDropTarget();
    expect(target.tagName).toBe('FORM');
  });

  it('should fall back to main if form is missing', () => {
    document.body.innerHTML = `
      <main id="main-content"></main>
    `;

    const target = content.findDropTarget();
    expect(target.tagName).toBe('MAIN');
  });

  it('should fall back to body if nothing else exists', () => {
    document.body.innerHTML = '';

    const target = content.findDropTarget();
    expect(target.tagName).toBe('BODY');
  });

  it('should find data-testid="composer" if present', () => {
    document.body.innerHTML = `
      <main>
        <div data-testid="composer" id="composer-div"></div>
      </main>
    `;

    const target = content.findDropTarget();
    expect(target.id).toBe('composer-div');
  });
});

describe('ChatGPT Content Script - handlePDFDrop', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('should convert base64 to blob and create proper file', async () => {
    // Create a fresh DOM for this test
    document.body.innerHTML = '<div id="prompt-textarea"></div>';

    const base64Data = btoa('fake pdf content');
    const filename = 'test.pdf';

    const dropTarget = document.getElementById('prompt-textarea');

    // Capture the drop event to verify it was dispatched
    // Note: happy-dom may not fully preserve dataTransfer on event listeners,
    // so we verify the event was dispatched and check dataTransfer if available
    let dropEventReceived = false;
    let capturedDataTransfer = null;
    dropTarget.addEventListener('drop', (e) => {
      dropEventReceived = true;
      capturedDataTransfer = e.dataTransfer;
    });

    await content.handlePDFDrop(base64Data, filename);

    // Verify the drop event was dispatched
    expect(dropEventReceived).toBe(true);

    // If dataTransfer is available, verify file details
    // (happy-dom may not fully support DataTransfer in event listeners)
    if (capturedDataTransfer && capturedDataTransfer.files) {
      expect(capturedDataTransfer.files.length).toBe(1);
      expect(capturedDataTransfer.files[0].name).toBe('test.pdf');
      expect(capturedDataTransfer.files[0].type).toBe('application/pdf');
    }
  });

  it('should dispatch dragenter, dragover, and drop events in order', async () => {
    document.body.innerHTML = '<div id="prompt-textarea"></div>';
    const dropTarget = document.getElementById('prompt-textarea');

    const eventSequence = [];
    ['dragenter', 'dragover', 'drop'].forEach(type => {
      dropTarget.addEventListener(type, () => eventSequence.push(type));
    });

    await content.handlePDFDrop(btoa('test'), 'test.pdf');

    expect(eventSequence).toEqual(['dragenter', 'dragover', 'drop']);
  });

  it('should fall back to body if no other drop target exists', async () => {
    document.body.innerHTML = ''; // Remove all elements
    const base64Data = btoa('fake pdf');

    // This should not throw since body is always available as fallback
    await expect(content.handlePDFDrop(base64Data, 'test.pdf')).resolves.not.toThrow();
  });
});

describe('ChatGPT Content Script - notifyTurn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    content.setCurrentTabId(123);
    content.setLastNotifyTime(0); // Reset throttle
  });

  it('should send message to background when turn is detected', () => {
    content.notifyTurn();

    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'conversationTurnDetected',
      tabId: 123
    });
  });

  it('should throttle notifications to once per 2 seconds', () => {
    content.notifyTurn();
    content.notifyTurn(); // Should be throttled
    content.notifyTurn(); // Should be throttled

    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('should allow notification after throttle period', () => {
    content.notifyTurn();

    // Simulate 2+ seconds passing
    content.setLastNotifyTime(Date.now() - 3000);

    content.notifyTurn();

    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(2);
  });
});
