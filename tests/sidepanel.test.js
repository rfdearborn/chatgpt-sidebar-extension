import { describe, it, expect, vi, beforeEach } from 'vitest';
const sidepanel = require('../sidepanel.js');

describe('Sidepanel Script - Fingerprinting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sidepanel.setLastPageFingerprint(null);
  });

  it('should calculate consistent fingerprint from URL and text', () => {
    const url = 'https://example.com';
    const text = 'Hello world';
    const expected = 'https://example.com|Hello world';
    
    expect(sidepanel.calculateFingerprint(url, text)).toBe(expected);
  });

  it('should skip attach if fingerprint matches in auto mode', async () => {
    const mockPdfResponse = {
      url: 'https://example.com',
      pageText: 'same content',
      pdfData: 'data',
      filename: 'file.pdf'
    };

    // Mock chrome.runtime.sendMessage
    chrome.runtime.sendMessage.mockResolvedValueOnce(mockPdfResponse);
    
    // Set initial fingerprint
    const fingerprint = sidepanel.calculateFingerprint(mockPdfResponse.url, mockPdfResponse.pageText);
    sidepanel.setLastPageFingerprint(fingerprint);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await sidepanel.attachCurrentPage(true); // isAuto = true

    // Should have sent printToPDF but NOT dropPDF (skipped due to unchanged fingerprint)
    // In auto mode, if the page content hasn't changed, we avoid re-attaching
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ action: 'printToPDF' }));
    // Verify dropPDF was NOT called (the key behavior being tested)
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'dropPDF' }));
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Page content unchanged'));
    
    consoleSpy.mockRestore();
  });

  it('should NOT skip attach if fingerprint matches in manual mode', async () => {
    const mockPdfResponse = {
      url: 'https://example.com',
      pageText: 'same content',
      pdfData: 'data',
      filename: 'file.pdf'
    };

    chrome.runtime.sendMessage
      .mockResolvedValueOnce(mockPdfResponse) // printToPDF
      .mockResolvedValueOnce({ success: true }); // dropPDF
    
    const fingerprint = sidepanel.calculateFingerprint(mockPdfResponse.url, mockPdfResponse.pageText);
    sidepanel.setLastPageFingerprint(fingerprint);

    await sidepanel.attachCurrentPage(false); // isAuto = false

    // Should have sent both messages
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(2);
    expect(chrome.runtime.sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'dropPDF' }));
  });
});
