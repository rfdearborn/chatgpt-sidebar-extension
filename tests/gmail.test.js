import { describe, it, expect, vi, beforeEach } from 'vitest';
const background = require('../background.js');

describe('Background Script - Gmail Specific Handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    background.debuggerRefCounts.clear();
    // Reset mocks to default resolved state
    chrome.debugger.attach.mockResolvedValue(undefined);
    chrome.debugger.detach.mockResolvedValue(undefined);
    chrome.debugger.sendCommand.mockResolvedValue({});
    chrome.storage.local.set.mockResolvedValue(undefined);
    chrome.tabs.create.mockResolvedValue({ id: 2, status: 'complete' });
    chrome.tabs.remove.mockResolvedValue(undefined);
    chrome.tabs.get.mockImplementation(async (id) => ({ id, status: 'complete', title: 'Gmail', url: 'https://mail.google.com/mail/u/0/#inbox/thread1' }));
  });

  it('should use Gmail print view when on a Gmail thread', async () => {
    const targetTabId = 1;
    const sidepanelTabId = 101;
    const sendResponse = vi.fn();

    const mockTab = { 
      id: 1, 
      title: 'Gmail Thread', 
      url: 'https://mail.google.com/mail/u/0/#inbox/thread1' 
    };
    
    chrome.tabs.get.mockImplementation(async (id) => {
      if (id === 1) return mockTab;
      if (id === 2) return { id: 2, status: 'complete', title: 'Print View', url: 'https://mail.google.com/mail/u/0/?ui=2&ik=testik&view=pt&search=all&th=thread1' };
    });

    // Mock debugger responses
    chrome.debugger.sendCommand.mockImplementation(async (target, command, params) => {
      if (command === 'Runtime.evaluate') {
        if (target.tabId === 1) {
          // Gmail print URL extraction
          return { result: { value: 'https://mail.google.com/mail/u/0/?ui=2&ik=testik&view=pt&search=all&th=thread1' } };
        } else if (target.tabId === 2) {
          // Page text extraction from print view
          return { result: { value: 'printed thread text' } };
        }
      }
      if (command === 'Page.printToPDF' && target.tabId === 2) {
        return { data: 'gmail_pdf_data' };
      }
      return {};
    });

    const promise = background.handlePrintToPDF(targetTabId, sidepanelTabId, sendResponse);

    // Give it a tiny bit of time to reach the first listener attachment
    await new Promise(resolve => setTimeout(resolve, 0));
    
    // Simulate navigation to the Gmail URL
    chrome.tabs.onUpdated.callListeners(2, { status: 'complete' });

    await promise;

    // Verify Gmail-specific steps
    // 1. Should create a blank tab first
    expect(chrome.tabs.create).toHaveBeenCalledWith(expect.objectContaining({
      url: 'about:blank'
    }));
    
    // 2. Should attach debugger to the blank tab (id: 2)
    expect(chrome.debugger.attach).toHaveBeenCalledWith({ tabId: 2 }, '1.3');

    // 3. Should update the tab to the Gmail print URL
    expect(chrome.tabs.update).toHaveBeenCalledWith(2, expect.objectContaining({
      url: 'https://mail.google.com/mail/u/0/?ui=2&ik=testik&view=pt&search=all&th=thread1'
    }));
    
    // 4. Should print from the temporary tab
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 2 },
      'Page.printToPDF',
      expect.any(Object)
    );

    // Should cleanup
    expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 2 });
    expect(chrome.tabs.remove).toHaveBeenCalledWith(2);

    // Final response should have the Gmail PDF data
    expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({
      pdfData: 'gmail_pdf_data',
      pageText: 'printed thread text'
    }));
  });

  it('should fallback to normal print if Gmail print URL extraction fails', async () => {
    const targetTabId = 1;
    const sidepanelTabId = 101;
    const sendResponse = vi.fn();

    const mockTab = { 
      id: 1, 
      title: 'Gmail Inbox', 
      url: 'https://mail.google.com/mail/u/0/#inbox' 
    };
    chrome.tabs.get.mockResolvedValue(mockTab);

    // Mock debugger responses
    chrome.debugger.sendCommand.mockImplementation(async (target, command, params) => {
      if (command === 'Runtime.evaluate') {
        if (target.tabId === 1) {
          // Gmail print URL extraction returns null (not a thread)
          return { result: { value: null } };
        }
      }
      if (command === 'Page.printToPDF' && target.tabId === 1) {
        return { data: 'normal_pdf_data' };
      }
      if (command === 'Runtime.evaluate' && target.tabId === 1) {
        return { result: { value: 'normal page text' } };
      }
      return {};
    });

    await background.handlePrintToPDF(targetTabId, sidepanelTabId, sendResponse);

    // Should NOT create a temporary tab
    expect(chrome.tabs.create).not.toHaveBeenCalled();
    
    // Final response should have the normal PDF data
    expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({
      pdfData: 'normal_pdf_data'
    }));
  });
});
