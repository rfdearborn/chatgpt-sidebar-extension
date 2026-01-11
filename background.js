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

    let pdfData;
    let pageText;
    let usedTab = tab;
    let tempTabId = null;

    // Special handling for Gmail to get "Print all" view
    if (tab.url.includes('mail.google.com')) {
      try {
        const evalResult = await chrome.debugger.sendCommand(debugTarget, 'Runtime.evaluate', {
          expression: `(() => {
            const getThreadId = () => {
              // 1. Check for the specific attribute Gmail uses for thread ID
              const el = document.querySelector('[data-legacy-thread-id]');
              if (el) return el.getAttribute('data-legacy-thread-id');
              
              // 2. Fallback to parsing the URL hash for a 16-char hex string
              const hash = window.location.hash;
              const hexMatch = hash.match(/[#\/]([0-9a-f]{16})/i);
              if (hexMatch) return hexMatch[1];

              return null;
            };

            const ik = window._ik || (window.GLOBALS && window.GLOBALS[9]);
            const th = getThreadId();
            
            if (ik && th) {
              const url = new URL(window.location.href);
              // Preserve the specific user session (e.g., /mail/u/1/)
              const sessionMatch = url.pathname.match(/\\/mail\\/u\\/\\d+\\//);
              const basePath = sessionMatch ? sessionMatch[0] : '/mail/u/0/';
              return \`\${url.origin}\${basePath}?ui=2&ik=\${ik}&view=pt&search=all&th=\${th}\`;
            }
            return null;
          })()`,
          returnByValue: true
        });

        const printUrl = evalResult.result?.value;
        if (printUrl) {
          // 1. Create a blank tab first so we can attach debugger and block print dialog
          const tempTab = await chrome.tabs.create({ url: 'about:blank', active: false });
          tempTabId = tempTab.id;
          const tempDebugTarget = { tabId: tempTabId };

          await chrome.debugger.attach(tempDebugTarget, '1.3');
          await chrome.debugger.sendCommand(tempDebugTarget, 'Page.enable');
          
          // 2. CRITICAL: Block window.print() before it can open a modal dialog that hangs the tab
          // This script runs before any other script on the new page
          await chrome.debugger.sendCommand(tempDebugTarget, 'Page.addScriptToEvaluateOnNewDocument', {
            source: 'window.print = () => { console.log("[ChatGPT Sidebar] Print dialog blocked"); };'
          });

          // 3. Now navigate to the actual Gmail print URL
          await chrome.tabs.update(tempTabId, { url: printUrl });

          // Wait for tab to load with timeout
          await Promise.race([
            new Promise((resolve) => {
              const listener = (tabId, info) => {
                if (tabId === tempTabId && info.status === 'complete') {
                  chrome.tabs.onUpdated.removeListener(listener);
                  resolve();
                }
              };
              chrome.tabs.onUpdated.addListener(listener);
              
              // Also check if it's already complete
              chrome.tabs.get(tempTabId, (tab) => {
                if (tab && tab.status === 'complete') {
                  chrome.tabs.onUpdated.removeListener(listener);
                  resolve();
                }
              });
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout waiting for Gmail print view')), 15000))
          ]);

          // Ensure Runtime is enabled for the content check
          await chrome.debugger.sendCommand(tempDebugTarget, 'Runtime.enable');

          // CRITICAL: Wait for the actual email content to render in the print view
          await chrome.debugger.sendCommand(tempDebugTarget, 'Runtime.evaluate', {
            expression: `new Promise(resolve => {
              const check = () => {
                const hasTable = !!document.querySelector('table');
                const hasContent = document.body.innerText.length > 300;
                const isDeleted = document.body.innerText.includes('deleted') || document.body.innerText.includes('not available');
                
                if ((hasTable && hasContent) || isDeleted) {
                  resolve(true);
                } else {
                  setTimeout(check, 100);
                }
              };
              check();
              setTimeout(() => resolve(false), 8000); // 8s max wait for content
            })`,
            awaitPromise: true
          });
          
          const result = await chrome.debugger.sendCommand(tempDebugTarget, 'Page.printToPDF', {
            printBackground: true,
            preferCSSPageSize: true,
            displayHeaderFooter: false,
            generateDocumentOutline: true
          });
          pdfData = result.data;

          const textResult = await chrome.debugger.sendCommand(tempDebugTarget, 'Runtime.evaluate', {
            expression: 'document.body.innerText'
          });
          pageText = textResult.result?.value || '';

          await chrome.debugger.detach(tempDebugTarget);
          await chrome.tabs.remove(tempTabId);
          tempTabId = null;
        }
      } catch (gmailErr) {
        console.error('Failed to get Gmail print view, falling back to normal print:', gmailErr);
        if (tempTabId) {
          chrome.tabs.remove(tempTabId).catch(() => {});
        }
      }
    }

    if (!pdfData) {
      // Print to PDF (standard fallback)
      const result = await chrome.debugger.sendCommand(debugTarget, 'Page.printToPDF', {
        printBackground: true,
        preferCSSPageSize: true,
      });
      pdfData = result.data;

      // Get page text for a more stable diffing fingerprint
      const evalResult = await chrome.debugger.sendCommand(debugTarget, 'Runtime.evaluate', {
        expression: 'document.body.innerText'
      });
      pageText = evalResult.result?.value || '';
    }

    // Generate filename from page title
    const filename = sanitizeFilename(tab.title);

    sendResponse({
      pdfData: pdfData,
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
