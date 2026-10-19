'use strict';

// Track our tabs to switch between them
let courseraTabId = null;
let claudeTabId = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'OPEN_CLAUDE_TAB') {
    if (sender.tab) {
      courseraTabId = sender.tab.id;
    }

    // Check if Claude tab is already open and valid
    if (claudeTabId) {
      chrome.tabs.get(claudeTabId, (tab) => {
        if (chrome.runtime.lastError || !tab || !tab.url.includes('claude.ai')) {
          createClaudeTab();
        } else {
          // Focus existing tab
          chrome.tabs.update(claudeTabId, { active: true }, () => {
            if (chrome.runtime.lastError) createClaudeTab();
            else {
              chrome.windows.update(tab.windowId, { focused: true });
              // Ping the bridge
              chrome.tabs.sendMessage(claudeTabId, { type: 'PING' }, () => {
                if (chrome.runtime.lastError) chrome.tabs.reload(claudeTabId);
              });
            }
          });
        }
      });
    } else {
      createClaudeTab();
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'FOCUS_COURSERA_TAB') {
    if (courseraTabId) {
      chrome.tabs.update(courseraTabId, { active: true }, () => {
        if (!chrome.runtime.lastError) {
          chrome.tabs.get(courseraTabId, tab => {
            if (tab) chrome.windows.update(tab.windowId, { focused: true });
          });
        }
      });
    }
    sendResponse({ ok: true });
    return true;
  }
});

function createClaudeTab() {
  chrome.tabs.create({ url: 'https://claude.ai/new', active: true }, (tab) => {
    claudeTabId = tab.id;
  });
}

// Cleanup closed tabs
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === courseraTabId) courseraTabId = null;
  if (tabId === claudeTabId) claudeTabId = null;
});
