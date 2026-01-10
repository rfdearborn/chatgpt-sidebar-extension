// Sidebar panel script - handles communication with background and UI

// Helper to check if we are in a browser context with a DOM
const isBrowser = typeof document !== 'undefined';

// DOM Elements
const frame = isBrowser ? document.getElementById('chatgpt-frame') : null;
const sharePageBtn = isBrowser ? document.getElementById('sharePage') : null;
const autoAttachCheckbox = isBrowser ? document.getElementById('autoAttach') : null;
const openExternalBtn = isBrowser ? document.getElementById('openExternal') : null;
const statusBar = isBrowser ? document.getElementById('status-bar') : null;
const statusMessage = isBrowser ? document.getElementById('status-message') : null;
const statusClose = isBrowser ? document.getElementById('status-close') : null;

// Track state
let currentTabId = null;
let currentChatUrl = 'https://chatgpt.com/';
let lastPageFingerprint = null;
let autoAttachInterval = null;

// Helper to calculate page fingerprint
function calculateFingerprint(url, pageText) {
  return `${url}|${pageText}`;
}

// Show status message
function showStatus(message, isError = false) {
  if (!isBrowser || !statusMessage || !statusBar) return;
  statusMessage.textContent = message;
  statusBar.classList.remove('hidden', 'error');
  if (isError) {
    statusBar.classList.add('error');
  }
  // Auto-hide success messages after 3 seconds
  if (!isError) {
    setTimeout(() => {
      statusBar.classList.add('hidden');
    }, 3000);
  }
}

// Hide status bar
if (isBrowser && statusClose) {
  statusClose.addEventListener('click', () => {
    statusBar.classList.add('hidden');
  });
}

// Helper to handle PDF attachment logic
async function attachCurrentPage(isAuto = false) {
  try {
    if (!isAuto) showStatus('Generating PDF...');

    // Step 1: Generate PDF via background script
    const pdfResponse = await chrome.runtime.sendMessage({
      action: 'printToPDF',
      tabId: currentTabId,
      sidepanelTabId: currentTabId  // Pass sidepanel tab ID for debugger ref counting
    });
    if (pdfResponse.error) {
      if (!isAuto) showStatus('PDF error: ' + pdfResponse.error, true);
      return;
    }

    // Step 2: Compare with last attached (if auto)
    // We use innerText + URL as a stable fingerprint instead of raw PDF bytes
    // to avoid re-attaching when only PDF metadata (like timestamps) changes.
    const currentFingerprint = calculateFingerprint(pdfResponse.url, pdfResponse.pageText);
    if (isAuto && currentFingerprint === lastPageFingerprint) {
      console.log('[ChatGPT Sidebar] Page content unchanged, skipping auto-attach');
      return;
    }

    if (!isAuto) showStatus('Attaching to ChatGPT...');

    // Step 3: Send PDF to content script in ChatGPT iframe
    const dropResponse = await chrome.runtime.sendMessage({
      action: 'dropPDF',
      pdfData: pdfResponse.pdfData,
      filename: pdfResponse.filename,
      tabId: currentTabId
    });

    if (dropResponse && dropResponse.error) {
      if (!isAuto) showStatus('Drop error: ' + dropResponse.error, true);
      return;
    }

    lastPageFingerprint = currentFingerprint;
    if (!isAuto) {
      showStatus('Page attached! Add your prompt and send.');
    } else {
      console.log('[ChatGPT Sidebar] Automatically (re-)attached page');
    }
  } catch (err) {
    if (!isAuto) showStatus('Failed: ' + err.message, true);
  }
}

// Share Page button click
if (isBrowser && sharePageBtn) {
  sharePageBtn.addEventListener('click', () => attachCurrentPage(false));
}

// Open in new tab and close sidebar
if (isBrowser && openExternalBtn) {
  openExternalBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: currentChatUrl });

    // Cleanup debugger before closing
    chrome.runtime.sendMessage({
      action: 'detachDebugger',
      tabId: currentTabId,
      sidepanelTabId: currentTabId
    });
    // Close the sidebar by disabling it for this tab
    chrome.sidePanel.setOptions({
      tabId: currentTabId,
      enabled: false
    });
  });
}

// Auto-attach toggle handling
if (isBrowser && autoAttachCheckbox) {
  autoAttachCheckbox.addEventListener('change', () => {
    const isEnabled = autoAttachCheckbox.checked;
    // Use per-tab auto-attach setting to prevent affecting other tabs
    chrome.storage.local.set({ [`autoAttachEnabled_${currentTabId}`]: isEnabled });

    if (isEnabled) {
      console.log('[ChatGPT Sidebar] Auto-attach enabled');
      startPeriodicCheck();
      // Also do an initial attach if we haven't yet
      attachCurrentPage(true);
    } else {
      console.log('[ChatGPT Sidebar] Auto-attach disabled');
      stopPeriodicCheck();
      // Cleanup debugger if auto-attach is turned off
      chrome.runtime.sendMessage({
        action: 'detachDebugger',
        tabId: currentTabId,
        sidepanelTabId: currentTabId
      });
    }
  });
}

// Load saved auto-attach state (will be loaded after we know currentTabId)
function loadAutoAttachState() {
  chrome.storage.local.get(`autoAttachEnabled_${currentTabId}`, (result) => {
    if (result[`autoAttachEnabled_${currentTabId}`]) {
      if (isBrowser && autoAttachCheckbox) autoAttachCheckbox.checked = true;
      startPeriodicCheck();
      // No immediate attach here; let the iframe 'load' event handle it
    }
  });
}

function startPeriodicCheck() {
  stopPeriodicCheck();
  // Check every 10 seconds for content changes
  autoAttachInterval = setInterval(() => {
    if (isBrowser && autoAttachCheckbox && autoAttachCheckbox.checked) {
      attachCurrentPage(true);
    }
  }, 10000);
}

function stopPeriodicCheck() {
  if (autoAttachInterval) {
    clearInterval(autoAttachInterval);
    autoAttachInterval = null;
  }
}

// Frame load handling
if (isBrowser && frame) {
  frame.addEventListener('load', () => {
    frame.classList.remove('loading');
    
    // If auto-attach is enabled, trigger it after the frame loads
    if (autoAttachCheckbox && autoAttachCheckbox.checked) {
      console.log('[ChatGPT Sidebar] Frame loaded, triggering auto-attach in 1s...');
      // Give the content script a moment to initialize its storage listeners
      setTimeout(() => {
        attachCurrentPage(true);
      }, 1000);
    }
  });
}

// Load the chat URL for a specific tab
async function loadUrlForTab(tabId) {
  if (isBrowser && frame) frame.classList.add('loading');
  currentTabId = tabId;

  // Load per-tab URL
  const result = await chrome.storage.local.get(`lastChatUrl_${tabId}`);
  const lastUrl = result[`lastChatUrl_${tabId}`] || 'https://chatgpt.com/';
  currentChatUrl = lastUrl;

  // Add tab ID to URL so content script knows which tab it belongs to
  // This avoids using shared storage which causes cross-tab contamination
  const url = new URL(lastUrl);
  url.searchParams.set('__sidebarTabId', tabId);
  if (isBrowser && frame) frame.src = url.toString();

  // Load per-tab auto-attach state
  loadAutoAttachState();
}

// Initialize and load URL for current tab
async function initializeFrame() {
  try {
    // Priority 1: Check URL parameters (set by background script)
    const urlParams = new URLSearchParams(window.location.search);
    const tabIdFromUrl = urlParams.get('tabId');
    
    if (tabIdFromUrl) {
      const tabId = parseInt(tabIdFromUrl, 10);
      console.log('[ChatGPT Sidebar] Initializing with Tab ID from URL:', tabId);
      await loadUrlForTab(tabId);
      return;
    }

    // Priority 2: Ask background script (fallback)
    const response = await chrome.runtime.sendMessage({ action: 'getTabId' });
    if (response?.tabId) {
      console.log('[ChatGPT Sidebar] Initializing with Tab ID from background:', response.tabId);
      await loadUrlForTab(response.tabId);
    } else {
      if (isBrowser && frame) frame.src = 'https://chatgpt.com/';
    }
  } catch (err) {
    if (isBrowser && frame) frame.src = 'https://chatgpt.com/';
  }
}

// Listen for messages
chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'sidepanelOpened') {
    // Only switch if we aren't already initialized OR if we are a global sidepanel (no currentTabId)
    // In per-tab mode, we shouldn't switch once we have a tab ID
    if (!currentTabId) {
      loadUrlForTab(request.tabId);
    }
  }

  if (request.action === 'chatUrlChanged') {
    // Only update if it belongs to our tab
    if (request.tabId === currentTabId) {
      currentChatUrl = request.url;
    }
  }

  if (request.action === 'autoAttachTrigger') {
    // Only respond if the turn was detected in THIS sidebar's ChatGPT instance
    const isAutoEnabled = isBrowser && autoAttachCheckbox ? autoAttachCheckbox.checked : false;
    if (isAutoEnabled && (!request.sourceTabId || request.sourceTabId === currentTabId)) {
      console.log('[ChatGPT Sidebar] Triggering auto-attach due to turn');
      attachCurrentPage(true);
    }
  }
});

if (isBrowser) {
  initializeFrame();
}

// Export for testing
if (typeof module !== 'undefined') {
  module.exports = {
    calculateFingerprint,
    attachCurrentPage,
    loadUrlForTab,
    startPeriodicCheck,
    stopPeriodicCheck,
    currentTabId: () => currentTabId,
    lastPageFingerprint: () => lastPageFingerprint,
    setLastPageFingerprint: (val) => { lastPageFingerprint = val; },
    setCurrentTabId: (id) => { currentTabId = id; }
  };
}
