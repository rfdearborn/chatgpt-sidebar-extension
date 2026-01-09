// Sidebar panel script - handles communication with background and UI

const frame = document.getElementById('chatgpt-frame');
const sharePageBtn = document.getElementById('sharePage');
const autoAttachCheckbox = document.getElementById('autoAttach');
const statusBar = document.getElementById('status-bar');
const statusMessage = document.getElementById('status-message');
const statusClose = document.getElementById('status-close');

// Track state
let currentTabId = null;
let lastPageFingerprint = null;
let autoAttachInterval = null;

// Show status message
function showStatus(message, isError = false) {
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
statusClose.addEventListener('click', () => {
  statusBar.classList.add('hidden');
});

// Helper to handle PDF attachment logic
async function attachCurrentPage(isAuto = false) {
  try {
    if (!isAuto) showStatus('Generating PDF...');

    // Step 1: Generate PDF via background script
    const pdfResponse = await chrome.runtime.sendMessage({ 
      action: 'printToPDF',
      tabId: currentTabId 
    });
    if (pdfResponse.error) {
      if (!isAuto) showStatus('PDF error: ' + pdfResponse.error, true);
      return;
    }

    // Step 2: Compare with last attached (if auto)
    // We use innerText + URL as a stable fingerprint instead of raw PDF bytes
    // to avoid re-attaching when only PDF metadata (like timestamps) changes.
    const currentFingerprint = `${pdfResponse.url}|${pdfResponse.pageText}`;
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
sharePageBtn.addEventListener('click', () => attachCurrentPage(false));

// Open in new tab and close sidebar
openExternalBtn.addEventListener('click', () => {
  const url = frame.src;
  chrome.tabs.create({ url });
  
  // Cleanup debugger before closing
  chrome.runtime.sendMessage({ 
    action: 'detachDebugger', 
    tabId: currentTabId 
  });

  // Close the sidebar by disabling it for this tab
  chrome.sidePanel.setOptions({
    tabId: currentTabId,
    enabled: false
  });
});

// Auto-attach toggle handling
autoAttachCheckbox.addEventListener('change', () => {
  const isEnabled = autoAttachCheckbox.checked;
  chrome.storage.local.set({ autoAttachEnabled: isEnabled });

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
      tabId: currentTabId 
    });
  }
});

// Load saved auto-attach state
chrome.storage.local.get('autoAttachEnabled', (result) => {
  if (result.autoAttachEnabled) {
    autoAttachCheckbox.checked = true;
    startPeriodicCheck();
    // No immediate attach here; let the iframe 'load' event handle it
  }
});

function startPeriodicCheck() {
  stopPeriodicCheck();
  // Check every 10 seconds for content changes
  autoAttachInterval = setInterval(() => {
    if (autoAttachCheckbox.checked) {
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
frame.addEventListener('load', () => {
  frame.classList.remove('loading');
  
  // If auto-attach is enabled, trigger it after the frame loads
  if (autoAttachCheckbox.checked) {
    console.log('[ChatGPT Sidebar] Frame loaded, triggering auto-attach in 1s...');
    // Give the content script a moment to initialize its storage listeners
    setTimeout(() => {
      attachCurrentPage(true);
    }, 1000);
  }
});

// Load the chat URL for a specific tab
async function loadUrlForTab(tabId) {
  frame.classList.add('loading');
  currentTabId = tabId;

  // Store tab ID so content script knows which tab it's associated with
  await chrome.storage.local.set({ currentSidepanelTabId: tabId });

  // Load per-tab URL
  const result = await chrome.storage.local.get(`lastChatUrl_${tabId}`);
  if (result[`lastChatUrl_${tabId}`]) {
    frame.src = result[`lastChatUrl_${tabId}`];
  } else {
    frame.src = 'https://chatgpt.com/';
  }
}

// Initialize and load URL for current tab
async function initializeFrame() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getTabId' });
    if (response?.tabId) {
      await loadUrlForTab(response.tabId);
    } else {
      frame.src = 'https://chatgpt.com/';
    }
  } catch (err) {
    frame.src = 'https://chatgpt.com/';
  }
}

// Listen for messages
chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'sidepanelOpened' && request.tabId !== currentTabId) {
    loadUrlForTab(request.tabId);
  }

  if (request.action === 'autoAttachTrigger') {
    // Only respond if the turn was detected in THIS sidebar's ChatGPT instance
    if (autoAttachCheckbox.checked && (!request.sourceTabId || request.sourceTabId === currentTabId)) {
      console.log('[ChatGPT Sidebar] Triggering auto-attach due to turn');
      attachCurrentPage(true);
    }
  }
});

initializeFrame();
