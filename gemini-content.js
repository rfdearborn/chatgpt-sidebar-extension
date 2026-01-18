// Content script that runs on gemini.google.com
// Receives PDF data via storage and simulates a file drop

const MODEL_ID = 'gemini';

// Track the tab ID this content script is associated with
let currentTabId = null;

// Initialize tab ID from URL parameter
function initTabId() {
  const url = new URL(window.location.href);
  const tabIdParam = url.searchParams.get('__sidebarTabId');
  if (tabIdParam) {
    currentTabId = parseInt(tabIdParam, 10);
    console.log('[AI Sidebar] Gemini: Tab ID from URL param:', currentTabId);

    // Check for any pending PDF for this specific tab
    checkPendingPDF();

    // Set up listener for this tab's PDF storage
    setupPDFListener();

    // Set up URL observer to track navigation
    setupUrlObserver();
  }
}

// Listen for storage changes to get PDF data (only for this tab's key)
function setupPDFListener() {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    const storageKey = `pendingPDF_${MODEL_ID}_${currentTabId}`;
    if (areaName === 'local' && changes[storageKey]?.newValue) {
      const { pdfData, filename } = changes[storageKey].newValue;
      console.log('[AI Sidebar] Gemini: Received PDF via storage:', filename);

      handlePDFDrop(pdfData, filename)
        .then(() => {
          // Clear the pending PDF for this tab
          chrome.storage.local.remove(storageKey);
          console.log('[AI Sidebar] Gemini: PDF drop completed');
        })
        .catch((err) => {
          console.error('[AI Sidebar] Gemini: PDF drop failed:', err);
        });
    }
  });
}

// Check for pending PDF on load (in case storage was set before script loaded)
function checkPendingPDF() {
  const storageKey = `pendingPDF_${MODEL_ID}_${currentTabId}`;
  chrome.storage.local.get(storageKey, (result) => {
    if (result[storageKey]) {
      const { pdfData, filename, timestamp } = result[storageKey];
      // Only process if recent (within last 10 seconds)
      if (Date.now() - timestamp < 10000) {
        console.log('[AI Sidebar] Gemini: Found pending PDF on load:', filename);
        handlePDFDrop(pdfData, filename)
          .then(() => chrome.storage.local.remove(storageKey))
          .catch((err) => console.error('[AI Sidebar] Gemini: PDF drop failed:', err));
      } else {
        // Clear stale PDF
        chrome.storage.local.remove(storageKey);
      }
    }
  });
}

// Initialize on load
initTabId();

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
    throw new Error('Could not find drop target on Gemini page');
  }

  console.log('[AI Sidebar] Gemini: Dropping PDF on:', dropTarget.tagName, dropTarget.className);

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

  console.log('[AI Sidebar] Gemini: PDF drop simulated successfully');
}

function findDropTarget() {
  // Try various selectors that Gemini might use
  const selectors = [
    // Gemini's input area selectors
    'rich-textarea',
    '.ql-editor',
    '[contenteditable="true"]',
    'textarea',
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
      console.log('[AI Sidebar] Gemini: Found drop target:', selector);
      return el;
    }
  }

  return document.body;
}

// Save current URL to storage so we can restore it later (per tab)
function saveCurrentUrl() {
  if (!currentTabId) return;

  // Remove the __sidebarTabId param before saving the URL
  const url = new URL(window.location.href);
  url.searchParams.delete('__sidebarTabId');
  const cleanUrl = url.toString();

  if (cleanUrl && cleanUrl.startsWith('https://gemini.google.com')) {
    chrome.storage.local.set({ [`lastChatUrl_${MODEL_ID}_${currentTabId}`]: cleanUrl });
    // Notify sidepanel of current URL
    chrome.runtime.sendMessage({
      action: 'chatUrlChanged',
      url: cleanUrl,
      tabId: currentTabId,
      model: MODEL_ID
    });
  }
}

// Watch for URL changes (pushState/popState)
let lastUrl = window.location.href;
function setupUrlObserver() {
  if (!currentTabId) return;

  const urlObserver = new MutationObserver(() => {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      saveCurrentUrl();
    }
  });
  urlObserver.observe(document.body, { childList: true, subtree: true });

  // Also listen for popstate
  window.addEventListener('popstate', saveCurrentUrl);

  // Save initial URL
  saveCurrentUrl();
}

// --- Conversation Turn Detection ---
function setupTurnDetection() {
  console.log('[AI Sidebar] Gemini: Setting up turn detection...');

  // Listen for clicks on send buttons
  document.addEventListener('click', (e) => {
    const sendButton = e.target.closest('button[aria-label="Send message"]') ||
                       e.target.closest('.send-button') ||
                       e.target.closest('button[mattooltip="Send message"]');
    if (sendButton) {
      console.log('[AI Sidebar] Gemini: Send button clicked');
      notifyTurn();
    }
  }, true);

  // Listen for Enter key in the input area
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      const inputArea = e.target.closest('rich-textarea') ||
                        e.target.closest('.ql-editor') ||
                        e.target.closest('[contenteditable="true"]');
      if (inputArea) {
        console.log('[AI Sidebar] Gemini: Enter pressed in input');
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

  console.log('[AI Sidebar] Gemini: Notifying turn detected');
  chrome.runtime.sendMessage({
    action: 'conversationTurnDetected',
    tabId: currentTabId,
    model: MODEL_ID
  });
}

// Initialize turn detection
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  setupTurnDetection();
} else {
  window.addEventListener('DOMContentLoaded', setupTurnDetection);
}

console.log('[AI Sidebar] Gemini content script loaded');

// Export for testing
if (typeof module !== 'undefined') {
  module.exports = {
    handlePDFDrop,
    findDropTarget,
    notifyTurn,
    MODEL_ID,
    setCurrentTabId: (id) => { currentTabId = id; },
    getLastNotifyTime: () => lastNotifyTime,
    setLastNotifyTime: (time) => { lastNotifyTime = time; }
  };
}
