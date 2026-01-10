// Background service worker for ChatGPT Sidebar extension

// Track which tabs have the sidebar open
const openTabs = new Set();
// Track debugger attachment with reference counting to handle multiple sidepanels
// Maps tabId -> Set of sidepanelTabIds that requested attachment
const debuggerRefCounts = new Map();

// Toggle panel on action click
chrome.action.onClicked.addListener(async (tab) => {
  if (openTabs.has(tab.id)) {
    // Close the sidebar
    await chrome.sidePanel.setOptions({
      tabId: tab.id,
      enabled: false,
    });
    openTabs.delete(tab.id);
    // Cleanup debugger if sidebar is closed (use tab.id as both target and sidepanel)
    detachDebugger(tab.id, tab.id);
  } else {
    // Open the sidebar
    chrome.sidePanel.setOptions({
      tabId: tab.id,
      path: `sidepanel.html?tabId=${tab.id}`,
      enabled: true,
    });
    chrome.sidePanel.open({ tabId: tab.id });
    openTabs.add(tab.id);
  }
});

// Clean up when tabs are closed
chrome.tabs.onRemoved.addListener((tabId) => {
  openTabs.delete(tabId);
  // Clean up debugger refs for this tab (both as target and as sidepanel)
  debuggerRefCounts.delete(tabId);
  // Also remove this tab from any ref sets where it was a sidepanel
  for (const [targetTabId, refs] of debuggerRefCounts.entries()) {
    refs.delete(tabId);
    if (refs.size === 0) {
      debuggerRefCounts.delete(targetTabId);
      // Detach debugger if no more references
      chrome.debugger.detach({ tabId: targetTabId }).catch(() => {});
    }
  }
  // Clean up stored URL and pending PDF for this tab
  chrome.storage.local.remove([`lastChatUrl_${tabId}`, `pendingPDF_${tabId}`, `autoAttachEnabled_${tabId}`]);
});

// Listen for messages
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'printToPDF') {
    handlePrintToPDF(request.tabId, request.sidepanelTabId, sendResponse);
    return true;
  }
  if (request.action === 'detachDebugger') {
    detachDebugger(request.tabId, request.sidepanelTabId);
    sendResponse({ success: true });
    return false;
  }
  if (request.action === 'dropPDF') {
    forwardDropPDF(request, sender, sendResponse);
    return true;
  }
  if (request.action === 'getTabId') {
    handleGetTabId(sender, sendResponse);
    return true;
  }
  if (request.action === 'conversationTurnDetected') {
    // Forward back to the sidepanel that sent it
    chrome.runtime.sendMessage({ 
      action: 'autoAttachTrigger', 
      reason: 'turn',
      sourceTabId: request.tabId
    });
    return false;
  }
});

// Export for testing
if (typeof module !== 'undefined') {
  module.exports = {
    attachDebugger,
    detachDebugger,
    handlePrintToPDF,
    sanitizeFilename,
    forwardDropPDF,
    handleGetTabId,
    debuggerRefCounts,
    openTabs
  };
}

// Helper to attach debugger with reference counting
// sidepanelTabId tracks which sidepanel requested the attachment
async function attachDebugger(tabId, sidepanelTabId) {
  // Add reference
  if (!debuggerRefCounts.has(tabId)) {
    debuggerRefCounts.set(tabId, new Set());
  }
  const refs = debuggerRefCounts.get(tabId);
  const wasEmpty = refs.size === 0;
  refs.add(sidepanelTabId);

  // Only actually attach if this is the first reference
  if (!wasEmpty) return true;

  const debugTarget = { tabId };
  try {
    await chrome.debugger.attach(debugTarget, '1.3');
    return true;
  } catch (err) {
    if (err.message.includes('already attached')) {
      return true;
    }
    // Failed to attach, remove the reference we just added
    refs.delete(sidepanelTabId);
    if (refs.size === 0) {
      debuggerRefCounts.delete(tabId);
    }
    throw err;
  }
}

// Helper to detach debugger with reference counting
async function detachDebugger(tabId, sidepanelTabId) {
  if (!debuggerRefCounts.has(tabId)) return;

  const refs = debuggerRefCounts.get(tabId);
  refs.delete(sidepanelTabId);

  // Only actually detach if no more references
  if (refs.size > 0) return;

  debuggerRefCounts.delete(tabId);
  const debugTarget = { tabId };
  try {
    await chrome.debugger.detach(debugTarget);
  } catch (err) {
    // Ignore errors if already detached
  }
}

// Print page to PDF using debugger API
async function handlePrintToPDF(targetTabId, sidepanelTabId, sendResponse) {
  let debugTarget = null;

  try {
    let tab;
    if (targetTabId) {
      tab = await chrome.tabs.get(targetTabId);
    } else {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      tab = tabs.find(t => t.url && (t.url.startsWith('http://') || t.url.startsWith('https://')));
    }

    if (!tab) {
      sendResponse({ error: 'Target page not found' });
      return;
    }

    debugTarget = { tabId: tab.id };

    // Attach debugger (persistently to avoid flickering)
    try {
      await attachDebugger(tab.id, sidepanelTabId);
    } catch (attachErr) {
      // Provide helpful error for extension conflicts
      if (attachErr.message.includes('chrome-extension://')) {
        sendResponse({
          error: 'Cannot attach debugger - another extension (like Ghostery, ad blockers) may be interfering. Try disabling other extensions for this site.'
        });
        return;
      }
      throw attachErr;
    }

    // Print to PDF
    const result = await chrome.debugger.sendCommand(debugTarget, 'Page.printToPDF', {
      printBackground: true,
      preferCSSPageSize: true,
    });

    // Get page text for a more stable diffing fingerprint
    const evalResult = await chrome.debugger.sendCommand(debugTarget, 'Runtime.evaluate', {
      expression: 'document.body.innerText'
    });
    const pageText = evalResult.result?.value || '';

    // Generate filename from page title
    const filename = sanitizeFilename(tab.title);

    sendResponse({
      pdfData: result.data,
      pageText: pageText,
      filename: filename,
      title: tab.title,
      url: tab.url,
    });
  } catch (err) {
    sendResponse({ error: err.message });
  }
}

// Store PDF data for content script to pick up (per-tab to avoid cross-contamination)
async function forwardDropPDF(request, sender, sendResponse) {
  try {
    let tabId = request.tabId;

    if (!tabId) {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      tabId = tabs[0]?.id;
    }

    // Use per-tab storage key to prevent PDFs from going to wrong tabs
    await chrome.storage.local.set({
      [`pendingPDF_${tabId}`]: {
        pdfData: request.pdfData,
        filename: request.filename,
        timestamp: Date.now()
      }
    });
    sendResponse({ success: true });
  } catch (err) {
    sendResponse({ error: err.message });
  }
}

// Helper to sanitize page title for filename
function sanitizeFilename(title) {
  const sanitized = title
    .replace(/[^a-z0-9]/gi, '_')
    .substring(0, 50);
  // Fallback to 'page' if title is empty or only had special characters
  return (sanitized.replace(/_/g, '') ? sanitized : 'page') + '.pdf';
}

// Handle request for current tab ID from sidepanel
function handleGetTabId(sender, sendResponse) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    sendResponse({ tabId: tabs[0]?.id });
  });
  return true;
}
