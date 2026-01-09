// Content script that runs on chatgpt.com
// Receives PDF data via storage and simulates a file drop

// Track the tab ID this content script is associated with
let currentTabId = null;

// Listen for storage changes to get PDF data
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.pendingPDF?.newValue) {
    const { pdfData, filename, tabId } = changes.pendingPDF.newValue;
    console.log('[ChatGPT Sidebar] Received PDF via storage:', filename);

    // Save the tab ID for URL persistence
    currentTabId = tabId;

    handlePDFDrop(pdfData, filename)
      .then(() => {
        // Clear the pending PDF
        chrome.storage.local.remove('pendingPDF');
        console.log('[ChatGPT Sidebar] PDF drop completed');
      })
      .catch((err) => {
        console.error('[ChatGPT Sidebar] PDF drop failed:', err);
      });
  }
});

// Also check for pending PDF on load (in case storage was set before script loaded)
chrome.storage.local.get('pendingPDF', (result) => {
  if (result.pendingPDF) {
    const { pdfData, filename, timestamp, tabId } = result.pendingPDF;
    // Only process if recent (within last 10 seconds)
    if (Date.now() - timestamp < 10000) {
      console.log('[ChatGPT Sidebar] Found pending PDF on load:', filename);
      currentTabId = tabId;
      handlePDFDrop(pdfData, filename)
        .then(() => chrome.storage.local.remove('pendingPDF'))
        .catch((err) => console.error('[ChatGPT Sidebar] PDF drop failed:', err));
    } else {
      // Clear stale PDF
      chrome.storage.local.remove('pendingPDF');
    }
  }
});

async function handlePDFDrop(base64Data, filename) {
  // Convert base64 to blob
  const binaryString = atob(base64Data);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const file = new File([blob], filename, { type: 'application/pdf' });

  // Find the drop target
  const dropTarget = findDropTarget();
  if (!dropTarget) {
    throw new Error('Could not find drop target on ChatGPT page');
  }

  console.log('[ChatGPT Sidebar] Dropping PDF on:', dropTarget.tagName, dropTarget.className);

  // Create DataTransfer with the file
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);

  // Simulate the drop sequence
  const events = ['dragenter', 'dragover', 'drop'];

  for (const eventType of events) {
    const event = new DragEvent(eventType, {
      bubbles: true,
      cancelable: true,
      dataTransfer: dataTransfer,
    });
    dropTarget.dispatchEvent(event);

    // Small delay between events
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  console.log('[ChatGPT Sidebar] PDF drop simulated successfully');
}

function findDropTarget() {
  // Try various selectors that ChatGPT might use
  const selectors = [
    // The composer/input area
    '#prompt-textarea',
    '[data-testid="composer"]',
    // Main chat form
    'form',
    // Main content area
    'main',
    // Fallback to body
    'body'
  ];

  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el) {
      console.log('[ChatGPT Sidebar] Found drop target:', selector);
      return el;
    }
  }

  return document.body;
}

// Save current URL to storage so we can restore it later (per tab)
function saveCurrentUrl() {
  if (!currentTabId) return; // Don't save if we don't know which tab we're associated with

  const url = window.location.href;
  if (url && url.startsWith('https://chatgpt.com')) {
    chrome.storage.local.set({ [`lastChatUrl_${currentTabId}`]: url });
  }
}

// Get tab ID from storage on load (set by sidepanel)
chrome.storage.local.get('currentSidepanelTabId', (result) => {
  if (result.currentSidepanelTabId) {
    currentTabId = result.currentSidepanelTabId;
    console.log('[ChatGPT Sidebar] Using tab ID from sidepanel:', currentTabId);
    // Save initial URL
    saveCurrentUrl();
  }
});

// Also listen for tab ID changes in storage
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.currentSidepanelTabId?.newValue) {
    currentTabId = changes.currentSidepanelTabId.newValue;
    console.log('[ChatGPT Sidebar] Updated tab ID:', currentTabId);
    saveCurrentUrl();
  }
});

// Watch for URL changes (pushState/popState)
let lastUrl = window.location.href;
const urlObserver = new MutationObserver(() => {
  if (window.location.href !== lastUrl) {
    lastUrl = window.location.href;
    saveCurrentUrl();
  }
});
urlObserver.observe(document.body, { childList: true, subtree: true });

// Also listen for popstate
window.addEventListener('popstate', saveCurrentUrl);

// --- Conversation Turn Detection ---
// Detect when a user sends a message to ChatGPT
function setupTurnDetection() {
  console.log('[ChatGPT Sidebar] Setting up turn detection...');

  // 1. Listen for clicks on the send button
  document.addEventListener('click', (e) => {
    const sendButton = e.target.closest('[data-testid="send-button"]') ||
                       e.target.closest('button[aria-label="Send prompt"]');
    if (sendButton) {
      console.log('[ChatGPT Sidebar] Send button clicked');
      notifyTurn();
    }
  }, true);

  // 2. Listen for Enter key in the textarea
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      const textarea = e.target.closest('#prompt-textarea');
      if (textarea) {
        console.log('[ChatGPT Sidebar] Enter pressed in textarea');
        notifyTurn();
      }
    }
  }, true);
}

let lastNotifyTime = 0;
function notifyTurn() {
  // Throttle notifications to once per 2 seconds
  const now = Date.now();
  if (now - lastNotifyTime < 2000) return;
  lastNotifyTime = now;

  console.log('[ChatGPT Sidebar] Notifying turn detected');
  chrome.runtime.sendMessage({ 
    action: 'conversationTurnDetected',
    tabId: currentTabId 
  });
}

// Initialize turn detection
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  setupTurnDetection();
} else {
  window.addEventListener('DOMContentLoaded', setupTurnDetection);
}

console.log('[ChatGPT Sidebar] Content script loaded on chatgpt.com');
