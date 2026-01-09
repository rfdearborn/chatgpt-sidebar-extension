// Sidebar panel script - handles communication with background and UI

const frame = document.getElementById('chatgpt-frame');
const attachPageBtn = document.getElementById('attachPage');
const newChatBtn = document.getElementById('newChat');
const refreshBtn = document.getElementById('refreshFrame');
const statusBar = document.getElementById('status-bar');
const statusMessage = document.getElementById('status-message');
const statusClose = document.getElementById('status-close');

// Track which browser tab this sidepanel is associated with
let currentTabId = null;

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

// Attach Page - print page to PDF and drop it into ChatGPT
attachPageBtn.addEventListener('click', async () => {
  try {
    showStatus('Generating PDF...');

    // Step 1: Generate PDF via background script
    const pdfResponse = await chrome.runtime.sendMessage({ action: 'printToPDF' });
    if (pdfResponse.error) {
      showStatus('PDF error: ' + pdfResponse.error, true);
      return;
    }

    showStatus('Attaching to ChatGPT...');

    // Step 2: Send PDF to content script in ChatGPT iframe
    const dropResponse = await chrome.runtime.sendMessage({
      action: 'dropPDF',
      pdfData: pdfResponse.pdfData,
      filename: pdfResponse.filename,
    });

    if (dropResponse && dropResponse.error) {
      showStatus('Drop error: ' + dropResponse.error, true);
      return;
    }

    showStatus('Page attached! Add your prompt and send.');
  } catch (err) {
    showStatus('Failed: ' + err.message, true);
  }
});

// Start new chat
newChatBtn.addEventListener('click', () => {
  frame.src = 'https://chatgpt.com/';
});

// Refresh frame
refreshBtn.addEventListener('click', () => {
  frame.src = frame.src;
});

// Frame load handling
frame.addEventListener('load', () => {
  frame.classList.remove('loading');
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

// Listen for explicit sidebar opens from background script
chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'sidepanelOpened' && request.tabId !== currentTabId) {
    loadUrlForTab(request.tabId);
  }
});

initializeFrame();
