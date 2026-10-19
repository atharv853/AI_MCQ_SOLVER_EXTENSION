'use strict';

function setStatus(msg) {
  const t = document.getElementById('statusText');
  if (t) {
    t.textContent = msg;
    t.style.color = (msg === 'Ready' || msg.includes('completed')) ? '#10b981' : '#f59e0b';
    if (msg.includes('Error') || msg.includes('fail') || msg.includes('invalid') || msg.includes('found')) {
      t.style.color = '#ef4444';
    }
  }
}

// Solve This Quiz button
document.getElementById('btnSolveQuiz')?.addEventListener('click', () => {
  setStatus('Extracting quiz...');
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (!tab?.id) {
      setStatus('Error: No active tab');
      return;
    }
    
    // Send a message to content script to start solving
    chrome.tabs.sendMessage(tab.id, { type: 'TRIGGER_SOLVE_QUIZ' }, (response) => {
      if (chrome.runtime.lastError) {
        setStatus('Error: Please reload this page');
        console.error(chrome.runtime.lastError);
      }
    });
  });
});

// Listen for status updates from content script
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'UPDATE_STATUS') {
    setStatus(msg.status);
  }
  return true;
});
