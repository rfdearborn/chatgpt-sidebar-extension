// Background service worker for ChatGPT Sidebar extension

// Track which tabs have the sidebar open
const openTabs = new Set();
// Track which tabs have a debugger attached to avoid flickering
const attachedTabs = new Set();

// Toggle panel on action click
chrome.action.onClicked.addListener(async (tab) => {
  if (openTabs.has(tab.id)) {
    // Close the sidebar
    await chrome.sidePanel.setOptions({
      tabId: tab.id,
      enabled: false,
    });
    openTabs.delete(tab.id);
    // Cleanup debugger if sidebar is closed
    detachDebugger(tab.id);
  } else {
    // Open the sidebar
    chrome.sidePanel.setOptions({
      tabId: tab.id,
      path: 'sidepanel.html',
      enabled: true,
    });
    chrome.sidePanel.open({ tabId: tab.id });
    openTabs.add(tab.id);

    // Notify sidepanel which tab it's being opened for
    // Small delay to ensure sidepanel is loaded
    setTimeout(() => {
      chrome.runtime.sendMessage({ action: 'sidepanelOpened', tabId: tab.id });
    }, 100);
  }
});

// Clean up when tabs are closed
chrome.tabs.onRemoved.addListener((tabId) => {
  openTabs.delete(tabId);
  attachedTabs.delete(tabId);
  // Clean up stored URL for this tab
  chrome.storage.local.remove(`lastChatUrl_${tabId}`);
});

// Listen for messages
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'printToPDF') {
    handlePrintToPDF(request.tabId, sendResponse);
    return true;
  }
  if (request.action === 'detachDebugger') {
    detachDebugger(request.tabId);
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

// Helper to attach debugger if not already attached
async function attachDebugger(tabId) {
  if (attachedTabs.has(tabId)) return true;
  
  const debugTarget = { tabId };
  try {
    await chrome.debugger.attach(debugTarget, '1.3');
    attachedTabs.add(tabId);
    return true;
  } catch (err) {
    if (err.message.includes('already attached')) {
      attachedTabs.add(tabId);
      return true;
    }
    throw err;
  }
}

// Helper to detach debugger
async function detachDebugger(tabId) {
  if (!attachedTabs.has(tabId)) return;
  
  const debugTarget = { tabId };
  try {
    await chrome.debugger.detach(debugTarget);
  } catch (err) {
    // Ignore errors if already detached
  }
  attachedTabs.delete(tabId);
}

// Print page to PDF using debugger API
async function handlePrintToPDF(targetTabId, sendResponse) {
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
      await attachDebugger(tab.id);
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
    const sanitizedTitle = tab.title
      .replace(/[^a-z0-9]/gi, '_')
      .substring(0, 50);
    const filename = `${sanitizedTitle}.pdf`;

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

// Store PDF data for content script to pick up
async function forwardDropPDF(request, sender, sendResponse) {
  try {
    let tabId = request.tabId;
    
    if (!tabId) {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      tabId = tabs[0]?.id;
    }

    await chrome.storage.local.set({
      pendingPDF: {
        pdfData: request.pdfData,
        filename: request.filename,
        timestamp: Date.now(),
        tabId: tabId
      }
    });
    sendResponse({ success: true });
  } catch (err) {
    sendResponse({ error: err.message });
  }
}

// Handle request for current tab ID from sidepanel
function handleGetTabId(sender, sendResponse) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    sendResponse({ tabId: tabs[0]?.id });
  });
  return true;
}
