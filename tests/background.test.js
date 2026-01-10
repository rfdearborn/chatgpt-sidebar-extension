import { describe, it, expect, vi, beforeEach } from 'vitest';
const background = require('../background.js');

describe('Background Script - Debugger Ref Counting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    background.debuggerRefCounts.clear();
    chrome.debugger.attach.mockResolvedValue(undefined);
    chrome.debugger.detach.mockResolvedValue(undefined);
  });

  it('should attach debugger on first reference', async () => {
    const tabId = 1;
    const sidepanelId = 101;

    const result = await background.attachDebugger(tabId, sidepanelId);

    expect(result).toBe(true);
    expect(chrome.debugger.attach).toHaveBeenCalledWith({ tabId }, '1.3');
    expect(background.debuggerRefCounts.get(tabId).has(sidepanelId)).toBe(true);
  });

  it('should not re-attach if already attached for same tab', async () => {
    const tabId = 1;
    const sidepanel1 = 101;
    const sidepanel2 = 102;

    await background.attachDebugger(tabId, sidepanel1);
    const result = await background.attachDebugger(tabId, sidepanel2);

    expect(result).toBe(true);
    expect(chrome.debugger.attach).toHaveBeenCalledTimes(1);
    expect(background.debuggerRefCounts.get(tabId).size).toBe(2);
  });

  it('should detach debugger only when last reference is removed', async () => {
    const tabId = 1;
    const sidepanel1 = 101;
    const sidepanel2 = 102;

    await background.attachDebugger(tabId, sidepanel1);
    await background.attachDebugger(tabId, sidepanel2);

    await background.detachDebugger(tabId, sidepanel1);
    expect(chrome.debugger.detach).not.toHaveBeenCalled();
    expect(background.debuggerRefCounts.get(tabId).size).toBe(1);

    await background.detachDebugger(tabId, sidepanel2);
    expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId });
    expect(background.debuggerRefCounts.has(tabId)).toBe(false);
  });
});

describe('Background Script - Message Handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    background.debuggerRefCounts.clear();
    // Reset mocks to default resolved state
    chrome.debugger.attach.mockResolvedValue(undefined);
    chrome.debugger.detach.mockResolvedValue(undefined);
    chrome.debugger.sendCommand.mockResolvedValue({});
    chrome.storage.local.set.mockResolvedValue(undefined);
  });

  it('should store PDF data with per-tab key in forwardDropPDF', async () => {
    const request = {
      tabId: 123,
      pdfData: 'base64data',
      filename: 'test.pdf'
    };
    const sendResponse = vi.fn();

    await background.forwardDropPDF(request, {}, sendResponse);

    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      'pendingPDF_123': expect.objectContaining({
        pdfData: 'base64data',
        filename: 'test.pdf',
        timestamp: expect.any(Number)
      })
    });
    expect(sendResponse).toHaveBeenCalledWith({ success: true });
  });

  it('should use current tab if tabId is missing in forwardDropPDF', async () => {
    chrome.tabs.query.mockImplementation((query, callback) => {
      if (callback) callback([{ id: 456 }]);
      return Promise.resolve([{ id: 456 }]);
    });
    chrome.tabs.query.mockResolvedValue([{ id: 456 }]);

    const request = {
      pdfData: 'base64data',
      filename: 'test.pdf'
    };
    const sendResponse = vi.fn();

    await background.forwardDropPDF(request, {}, sendResponse);

    expect(chrome.storage.local.set).toHaveBeenCalledWith({
      'pendingPDF_456': expect.any(Object)
    });
  });

  it('should cleanup state when a tab is removed', async () => {
    const tabId = 789;
    
    // Setup state
    background.openTabs.add(tabId);
    background.debuggerRefCounts.set(tabId, new Set([tabId]));
    
    // Trigger onRemoved listener via jest-chrome helper
    chrome.tabs.onRemoved.callListeners(tabId);
    
    expect(background.openTabs.has(tabId)).toBe(false);
    expect(background.debuggerRefCounts.has(tabId)).toBe(false);
    expect(chrome.storage.local.remove).toHaveBeenCalledWith(expect.arrayContaining([
      `lastChatUrl_${tabId}`,
      `pendingPDF_${tabId}`,
      `autoAttachEnabled_${tabId}`
    ]));
  });

  it('should handle printToPDF flow correctly', async () => {
    const targetTabId = 1;
    const sidepanelTabId = 101;
    const sendResponse = vi.fn();

    const mockTab = { id: 1, title: 'Test Page', url: 'https://test.com' };
    chrome.tabs.get.mockResolvedValue(mockTab);
    chrome.debugger.sendCommand
      .mockResolvedValueOnce({ data: 'pdf_data' }) // Page.printToPDF
      .mockResolvedValueOnce({ result: { value: 'page text' } }); // Runtime.evaluate

    await background.handlePrintToPDF(targetTabId, sidepanelTabId, sendResponse);

    expect(chrome.debugger.attach).toHaveBeenCalledWith({ tabId: 1 }, '1.3');
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 1 },
      'Page.printToPDF',
      expect.any(Object)
    );
    expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({
      pdfData: 'pdf_data',
      pageText: 'page text',
      filename: 'Test_Page.pdf'
    }));
  });

  it('should return error when target tab not found', async () => {
    const sendResponse = vi.fn();
    chrome.tabs.get.mockRejectedValue(new Error('No tab with id'));
    chrome.tabs.query.mockResolvedValue([]);

    await background.handlePrintToPDF(null, 101, sendResponse);

    expect(sendResponse).toHaveBeenCalledWith({ error: 'Target page not found' });
  });

  it('should handle debugger already attached error gracefully', async () => {
    // Test the attachDebugger function directly handles "already attached" errors
    chrome.debugger.attach.mockRejectedValue(new Error('Another debugger is already attached'));

    // Should return true (success) even when debugger is already attached
    const result = await background.attachDebugger(999, 888);

    expect(result).toBe(true);
    expect(chrome.debugger.attach).toHaveBeenCalledWith({ tabId: 999 }, '1.3');
  });

  it('should throw non-recoverable attach errors', async () => {
    chrome.debugger.attach.mockRejectedValue(new Error('Some other error'));

    await expect(background.attachDebugger(999, 888)).rejects.toThrow('Some other error');
  });

  it('should return error when debugger sendCommand fails', async () => {
    const sendResponse = vi.fn();
    const mockTab = { id: 1, title: 'Test', url: 'https://test.com' };
    chrome.tabs.get.mockResolvedValue(mockTab);
    chrome.debugger.attach.mockResolvedValue(undefined);
    chrome.debugger.sendCommand.mockRejectedValue(new Error('Page crashed'));

    await background.handlePrintToPDF(1, 101, sendResponse);

    expect(sendResponse).toHaveBeenCalledWith({ error: 'Page crashed' });
  });

  it('should handle forwardDropPDF storage failure', async () => {
    const sendResponse = vi.fn();
    chrome.storage.local.set.mockRejectedValue(new Error('Storage quota exceeded'));

    await background.forwardDropPDF(
      { tabId: 1, pdfData: 'data', filename: 'test.pdf' },
      {},
      sendResponse
    );

    expect(sendResponse).toHaveBeenCalledWith({ error: 'Storage quota exceeded' });
  });
});
