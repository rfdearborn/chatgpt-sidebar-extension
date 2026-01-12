import { describe, it, expect, vi, beforeEach } from 'vitest';
const background = require('../background.js');

describe('Background Script - PDF Specific Handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    background.debuggerRefCounts.clear();
    // Reset mocks to default resolved state
    chrome.debugger.attach.mockResolvedValue(undefined);
    chrome.debugger.detach.mockResolvedValue(undefined);
    chrome.debugger.sendCommand.mockResolvedValue({});
    chrome.storage.local.set.mockResolvedValue(undefined);
    chrome.tabs.get.mockResolvedValue({ id: 1, status: 'complete', title: 'Test PDF', url: 'https://example.com/test.pdf' });
    
    // Mock global fetch
    global.fetch = vi.fn();
  });

  it('should fetch PDF directly when tab URL ends in .pdf', async () => {
    const targetTabId = 1;
    const sidepanelTabId = 101;
    const sendResponse = vi.fn();

    const mockPdfContent = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52]); // %PDF-1.4
    const mockBase64 = btoa(String.fromCharCode(...mockPdfContent));

    global.fetch.mockResolvedValue({
      ok: true,
      headers: new Map([['content-type', 'application/pdf']]),
      arrayBuffer: async () => mockPdfContent.buffer
    });

    await background.handlePrintToPDF(targetTabId, sidepanelTabId, sendResponse);

    // Should have called fetch
    expect(global.fetch).toHaveBeenCalledWith('https://example.com/test.pdf');

    // Final response should have the fetched PDF data
    expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({
      pdfData: mockBase64,
      url: 'https://example.com/test.pdf'
    }));
    
    // Should NOT have called Page.printToPDF via debugger
    expect(chrome.debugger.sendCommand).not.toHaveBeenCalledWith(
      expect.any(Object),
      'Page.printToPDF',
      expect.any(Object)
    );

    // Should NOT have attached debugger for direct PDF fetch
    expect(chrome.debugger.attach).not.toHaveBeenCalled();
  });

  it('should fallback to printToPDF if fetch fails', async () => {
    const targetTabId = 1;
    const sidepanelTabId = 101;
    const sendResponse = vi.fn();

    global.fetch.mockRejectedValue(new Error('Fetch failed'));
    
    chrome.debugger.sendCommand.mockImplementation(async (target, command) => {
      if (command === 'Page.printToPDF') return { data: 'fallback_pdf_data' };
      if (command === 'Runtime.evaluate') return { result: { value: 'fallback text' } };
      return {};
    });

    await background.handlePrintToPDF(targetTabId, sidepanelTabId, sendResponse);

    // Should have tried fetch
    expect(global.fetch).toHaveBeenCalled();

    // Should have fallen back to Page.printToPDF
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      expect.any(Object),
      'Page.printToPDF',
      expect.any(Object)
    );

    expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({
      pdfData: 'fallback_pdf_data'
    }));
  });

  it('should fallback if Content-Type is not application/pdf', async () => {
    const targetTabId = 1;
    const sidepanelTabId = 101;
    const sendResponse = vi.fn();

    global.fetch.mockResolvedValue({
      ok: true,
      headers: new Map([['content-type', 'text/html']]),
      arrayBuffer: async () => new ArrayBuffer(0)
    });
    
    chrome.debugger.sendCommand.mockImplementation(async (target, command) => {
      if (command === 'Page.printToPDF') return { data: 'fallback_pdf_data' };
      if (command === 'Runtime.evaluate') return { result: { value: 'fallback text' } };
      return {};
    });

    await background.handlePrintToPDF(targetTabId, sidepanelTabId, sendResponse);

    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      expect.any(Object),
      'Page.printToPDF',
      expect.any(Object)
    );
  });
});
