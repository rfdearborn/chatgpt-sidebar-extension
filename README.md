# ChatGPT Sidebar

A simple, trustworthy Chrome extension that provides quick access to ChatGPT in a sidebar with page context features. Unlike third-party wrappers, this extension embeds the actual chatgpt.com site, so all conversations sync to your real ChatGPT account and appear in your conversation history across devices.

## Features

- **Real ChatGPT**: Uses the actual chatgpt.com in an iframe - your conversations sync everywhere
- **Page Context**: Extract full page content and send it to ChatGPT
- **Selection Support**: Send just the selected text to ChatGPT
- **Keyboard Shortcuts**: Quick access via Cmd+Shift+G (toggle sidebar) and Cmd+Shift+E (extract page)
- **Minimal Permissions**: Only requests what's necessary

## Installation

1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top right)
3. Click "Load unpacked"
4. Select this extension folder (`chatgpt-sidebar-extension`)
5. The extension icon should appear in your toolbar

## Usage

1. **Open Sidebar**: Click the extension icon or press `Cmd+Shift+G`
2. **Log in**: Sign into your ChatGPT account in the sidebar (first time only)
3. **Read Page**: Click "Read Page" to extract the current page's content - it will be copied to your clipboard
4. **Selection**: Select text on a page, then click "Selection" to copy it with context
5. **New Chat**: Start a fresh conversation
6. **Paste**: Press `Cmd+V` in the ChatGPT input to paste the extracted content

## How It Works

The extension opens chatgpt.com in Chrome's built-in Side Panel. When you click "Read Page" or "Selection", it extracts the content from the current tab and copies it to your clipboard with formatting. You then paste it into the ChatGPT input.

This approach is necessary because cross-origin iframe restrictions prevent directly injecting text into the ChatGPT input. The tradeoff is one extra paste step, but the benefit is that your conversations are 100% native ChatGPT conversations that sync to your account.

## Permissions Explained

- `activeTab`: Read content from the current tab when you click extract
- `sidePanel`: Display ChatGPT in Chrome's side panel
- `storage`: Store preferences locally
- `scripting`: Extract page content
- `host_permissions (chatgpt.com)`: Load ChatGPT in the sidebar iframe

## Privacy

- No data is sent to any third-party servers
- All conversations happen directly with OpenAI through your ChatGPT account
- Page content is only extracted when you explicitly click the button
- Nothing is stored except local preferences

## Limitations

- Requires pasting content (clipboard workflow) due to iframe security restrictions
- ChatGPT must be logged in within the sidebar
- Some pages may block content extraction

## Troubleshooting

**Sidebar won't open**: Make sure you've enabled the extension and granted permissions

**Can't paste content**: Check that clipboard permissions are enabled for the extension

**ChatGPT not loading**: Try clicking the refresh button in the toolbar

**"Read Page" not working**: Some pages (like chrome:// pages or PDFs) restrict content access
