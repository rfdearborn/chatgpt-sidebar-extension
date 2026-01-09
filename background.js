// Background service worker for ChatGPT Sidebar extension

// Track which tabs have the sidebar open
const openTabs = new Set();

// Toggle panel on action click
chrome.action.onClicked.addListener(async (tab) => {
  if (openTabs.has(tab.id)) {
    // Close the sidebar
    await chrome.sidePanel.setOptions({
      tabId: tab.id,
      enabled: false,
    });
    openTabs.delete(tab.id);
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
  // Clean up stored URL for this tab
  chrome.storage.local.remove(`lastChatUrl_${tabId}`);
});

// Handle messages from sidepanel
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'printToPDF') {
    handlePrintToPDF(sendResponse);
    return true;
  }
  if (request.action === 'dropPDF') {
    forwardDropPDF(request, sendResponse);
    return true;
  }
  if (request.action === 'getTabId') {
    return handleGetTabId(sendResponse);
  }
});

// Store PDF data for content script to pick up
async function forwardDropPDF(request, sendResponse) {
  try {
    // Get the active tab to associate this PDF with
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tabId = tabs[0]?.id;

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
function handleGetTabId(sendResponse) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    sendResponse({ tabId: tabs[0]?.id });
  });
  return true;
}

// Print page to PDF using debugger API
async function handlePrintToPDF(sendResponse) {
  let debugTarget = null;

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs.find(t => t.url && (t.url.startsWith('http://') || t.url.startsWith('https://')));

    if (!tab) {
      sendResponse({ error: 'No web page tab found' });
      return;
    }

    debugTarget = { tabId: tab.id };

    // Attach debugger
    try {
      await chrome.debugger.attach(debugTarget, '1.3');
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

    // Detach debugger
    await chrome.debugger.detach(debugTarget);

    // Generate filename from page title
    const sanitizedTitle = tab.title
      .replace(/[^a-z0-9]/gi, '_')
      .substring(0, 50);
    const filename = `${sanitizedTitle}.pdf`;

    sendResponse({
      pdfData: result.data,
      filename: filename,
      title: tab.title,
      url: tab.url,
    });
  } catch (err) {
    if (debugTarget) {
      try {
        await chrome.debugger.detach(debugTarget);
      } catch (e) {
        // Ignore detach errors
      }
    }
    sendResponse({ error: err.message });
  }
}
