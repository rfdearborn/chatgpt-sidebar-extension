import { vi } from 'vitest';
import { chrome } from 'jest-chrome';

Object.assign(global, { chrome, jest: vi });

// jest-chrome provides a `callListeners` method on event objects (like chrome.tabs.onRemoved)
// that allows tests to simulate Chrome triggering events. This is specific to jest-chrome's API.
// Usage: chrome.tabs.onRemoved.callListeners(tabId) simulates a tab being closed.

// Ensure all expected APIs exist
if (!chrome.action) chrome.action = { onClicked: { addListener: vi.fn() } };
if (!chrome.sidePanel) chrome.sidePanel = { setOptions: vi.fn(), open: vi.fn() };
if (!chrome.debugger) chrome.debugger = { attach: vi.fn(), detach: vi.fn(), sendCommand: vi.fn() };
if (!chrome.tabs) chrome.tabs = { onRemoved: { addListener: vi.fn() }, query: vi.fn(), get: vi.fn(), create: vi.fn() };
if (!chrome.runtime) chrome.runtime = { onMessage: { addListener: vi.fn() }, sendMessage: vi.fn() };
if (!chrome.storage) chrome.storage = { local: { get: vi.fn(), set: vi.fn(), remove: vi.fn() } };
