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
  // Clean up stored URLs, pending PDFs, and settings for this tab (all models)
  chrome.storage.local.remove([
    // ChatGPT
    `lastChatUrl_chatgpt_${tabId}`,
    `pendingPDF_chatgpt_${tabId}`,
    // Claude
    `lastChatUrl_claude_${tabId}`,
    `pendingPDF_claude_${tabId}`,
    // Gemini
    `lastChatUrl_gemini_${tabId}`,
    `pendingPDF_gemini_${tabId}`,
    // Shared settings
    `autoAttachEnabled_${tabId}`,
    `selectedModel_${tabId}`
  ]);
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

    let pdfData;
    let pageText;
    let usedTab = tab;
    let tempTabId = null;

    // Special handling for PDF files to get original bytes instead of a "PDF of the viewer"
    // Similar to Gmail handling, we use custom logic for specific content types.
    // We do this BEFORE attaching the debugger to avoid the blue bar for direct PDFs.
    const isPdfUrl = tab.url.toLowerCase().endsWith('.pdf') || 
                     tab.url.toLowerCase().includes('.pdf?') ||
                     tab.url.toLowerCase().includes('/pdf/');

    if (isPdfUrl) {
      try {
        console.log('[ChatGPT Sidebar] Detected PDF URL, attempting direct fetch:', tab.url);
        const response = await fetch(tab.url);
        if (response.ok) {
          const contentType = response.headers.get('content-type');
          if (contentType && contentType.toLowerCase().includes('application/pdf')) {
            const arrayBuffer = await response.arrayBuffer();
            const bytes = new Uint8Array(arrayBuffer);
            let binary = '';
            for (let i = 0; i < bytes.byteLength; i++) {
              binary += String.fromCharCode(bytes[i]);
            }
            pdfData = btoa(binary);
            // For PDFs, we use the URL as a fingerprint since text extraction is hard
            pageText = tab.url;
            console.log('[ChatGPT Sidebar] Successfully fetched original PDF bytes');
            
            // Skip debugger attachment and Gmail logic if we already have the PDF
            sendResponse({
              pdfData: pdfData,
              pageText: pageText,
              filename: sanitizeFilename(tab.title),
              title: tab.title,
              url: tab.url,
            });
            return;
          }
        }
      } catch (pdfErr) {
        console.error('[ChatGPT Sidebar] Failed to fetch PDF directly, falling back to printToPDF:', pdfErr);
      }
    }

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

    // Special handling for Gmail to get "Print all" view
    if (tab.url.includes('mail.google.com')) {
      try {
        const evalResult = await chrome.debugger.sendCommand(debugTarget, 'Runtime.evaluate', {
          expression: `(() => {
            const getThreadId = () => {
              // 1. URL parameters are highest signal for popouts and direct links
              const urlParams = new URLSearchParams(window.location.search);
              const thParams = ['th', 'threadId', 'id', 'mid', 'message_id'];
              for (const p of thParams) {
                const val = urlParams.get(p);
                if (val && /^[0-9a-f]{16}$/i.test(val)) return val;
              }

              // 2. URL hash is extremely reliable for the main Gmail UI when viewing a thread
              // Example: #inbox/abcdef1234567890 or #search/term/abcdef1234567890
              const hash = window.location.hash;
              const hexMatch = hash.match(/[#\\/]([0-9a-f]{16})/i);
              if (hexMatch) return hexMatch[1];

              // 3. DOM check - ONLY if we appear to be in a message view to avoid grabbing inbox rows
              // We check for elements that usually only exist when a message is actually open
              const isMessageView = !!document.querySelector('[role="main"] [role="listitem"], [role="main"] .h7, [role="main"] .if');
              if (isMessageView) {
                // Try to find the thread ID in the main content area
                const mainEl = document.querySelector('[role="main"]');
                if (mainEl) {
                  const el = mainEl.querySelector('[data-legacy-thread-id], [data-thread-id]');
                  if (el) {
                    const val = el.getAttribute('data-legacy-thread-id') || el.getAttribute('data-thread-id');
                    if (val && /^[0-9a-f]{16}$/i.test(val)) return val;
                  }
                }
              }

              // 4. Last resort scans for popouts where IDs might be in script blocks
              const html = document.documentElement.innerHTML;
              const thMatch = html.match(/["']?threadId["']?\\s*[:=]\\s*["']([0-9a-f]{16})["']/) ||
                              html.match(/["']?th["']?\\s*[:=]\\s*["']([0-9a-f]{16})["']/) ||
                              html.match(/legacy_thread_id["']?\\s*[:=]\\s*["']([0-9a-f]{16})["']/);
              if (thMatch) return thMatch[1];

              return null;
            };

            const getIk = () => {
              // 1. Check common global variables
              const ik = window._ik || (window.GLOBALS && window.GLOBALS[9]);
              if (ik) return ik;

              // 2. Check window.opener if available
              try {
                if (window.opener && window.opener._ik) return window.opener._ik;
                if (window.opener && window.opener.GLOBALS && window.opener.GLOBALS[9]) return window.opener.GLOBALS[9];
              } catch (e) {}

              // 3. Check URL parameters
              const urlParams = new URLSearchParams(window.location.search);
              const ikParams = ['ik', 'ver', 'at'];
              for (const p of ikParams) {
                const val = urlParams.get(p);
                if (val && /^[a-z0-9]{10,15}$/i.test(val)) return val;
              }

              // 4. Search all scripts for "ik"
              const scripts = document.getElementsByTagName('script');
              for (let i = 0; i < scripts.length; i++) {
                const text = scripts[i].textContent;
                const match = text.match(/["']?ik["']?\\s*[:=]\\s*["']([^"']+)["']/) || 
                             text.match(/_ik\\s*=\\s*["']([^"']+)["']/);
                if (match) return match[1];
              }

              return null;
            };

            // 5. Try to find a direct print link in the DOM if possible
            const printLink = document.querySelector('a[href*="view=pt"]');
            if (printLink && printLink.href) return printLink.href;

            const ik = getIk();
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

// Store PDF data for content script to pick up (per-tab, per-model to avoid cross-contamination)
async function forwardDropPDF(request, sender, sendResponse) {
  try {
    let tabId = request.tabId;
    const model = request.model || 'chatgpt';

    if (!tabId) {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      tabId = tabs[0]?.id;
    }

    // Use per-tab, per-model storage key to prevent PDFs from going to wrong tabs/models
    await chrome.storage.local.set({
      [`pendingPDF_${model}_${tabId}`]: {
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
