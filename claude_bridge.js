// claude_bridge.js — runs on claude.ai/*
(async function () {
    'use strict';

    function isContextValid() { try { return !!chrome.runtime?.id; } catch { return false; } }
    const TASK_KEY = 'cqsClaudeTask';
    const ANSWER_KEY = 'cqsClaudeAnswers';

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (msg.type === 'PING') {
            sendResponse({ alive: true });
            chrome.storage.local.get([TASK_KEY], (data) => {
                if (data[TASK_KEY]?.prompt) handleTask(data[TASK_KEY]);
            });
        }
    });

    chrome.storage.onChanged.addListener((changes, namespace) => {
        if (namespace === 'local' && changes[TASK_KEY]?.newValue) {
            handleTask(changes[TASK_KEY].newValue);
        }
    });

    const storage = await chrome.storage.local.get([TASK_KEY]);
    if (storage[TASK_KEY]) {
        handleTask(storage[TASK_KEY]);
    }

    async function handleTask(task) {
        if (!task?.prompt) return;

        console.log('[AI Quiz Solver] Task found. Prompt length:', task.prompt.length);

        if (!sessionStorage.getItem('_cqs_refreshed')) {
            sessionStorage.setItem('_cqs_refreshed', '1');
            location.reload();
            return;
        }
        sessionStorage.removeItem('_cqs_refreshed');

        await delay(3000);

        const inputEl = await waitForEl([
            'div.tiptap.ProseMirror',
            'div[contenteditable="true"][enterkeyhint]',
            'div[contenteditable="true"][data-placeholder]',
            'div[contenteditable="true"]',
        ], 20000);

        if (!inputEl) {
            await storeError('Claude chat input not found. Make sure you are logged into claude.ai');
            return;
        }

        const RESPONSE_SELS = [
            '.font-claude-response',
            '.font-claude-response-body',
            '[class*="font-claude-response"]',
        ];

        function getAllResponseEls() {
            for (const sel of RESPONSE_SELS) {
                const all = document.querySelectorAll(sel);
                if (all.length > 0) return [...all];
            }
            return [];
        }

        const baselineCount = getAllResponseEls().length;

        let injected = false;
        for (let attempt = 0; attempt < 3 && !injected; attempt++) {
            if (attempt > 0) await delay(1500);

            inputEl.focus();
            await delay(300);
            document.execCommand('selectAll', false, null);
            document.execCommand('delete', false, null);
            await delay(200);

            const inserted = document.execCommand('insertText', false, task.prompt);

            if (inserted && (inputEl.innerText || '').trim().length > 5) {
                injected = true;
                break;
            }

            const dt = new DataTransfer();
            dt.setData('text/plain', task.prompt);
            inputEl.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
            await delay(500);

            if ((inputEl.innerText || '').trim().length > 5) {
                injected = true;
                break;
            }

            inputEl.innerHTML = '<p>' + task.prompt.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>') + '</p>';
            inputEl.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
            await delay(500);

            if ((inputEl.innerText || '').trim().length > 5) {
                injected = true;
            }
        }

        if (!injected) {
            await storeError('Could not type prompt into Claude. Try clicking in the chat box and retry.');
            return;
        }

        await delay(600);

        const sendBtn = await waitForEl([
            'button[aria-label="Send message"]',
            'button[aria-label="Send Message"]',
            'button[data-testid="send-button"]',
            'button[aria-label*="Send" i]',
        ], 5000);

        if (sendBtn && !sendBtn.disabled) {
            sendBtn.click();
        } else {
            inputEl.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true
            }));
        }

        await delay(3000);

        const newEls = await waitFor(
            () => {
                const all = getAllResponseEls();
                return all.length > baselineCount ? all : null;
            },
            60000
        );

        if (!newEls) {
            await storeError('Claude did not generate a response in time. Try again.');
            return;
        }

        const responseText = await waitForStableText(() => {
            const all = getAllResponseEls();
            return all.slice(baselineCount).map(el => (el.innerText || '').trim()).filter(t => t.length > 5).join('\n');
        }, 120000);

        if (!responseText.trim()) {
            await storeError('Claude response was empty. Try again.');
            return;
        }

        const answers = parseClaudeResponse(responseText);

        try { await chrome.storage.local.set({
            [ANSWER_KEY]: {
                answers,
                taskId: task.taskId,
                timestamp: Date.now(),
            }
        }); } catch(e) { return; }
        try { await chrome.storage.local.remove([TASK_KEY]); } catch(e) {}

        await delay(1500);
        if (isContextValid()) { try { chrome.runtime.sendMessage({ type: 'FOCUS_COURSERA_TAB' }); } catch(e) {} }

        // HELPERS

        function waitForEl(sels, maxMs) {
            return new Promise(resolve => {
                for (const sel of sels) {
                    const el = document.querySelector(sel);
                    if (el) { resolve(el); return; }
                }
                const start = Date.now();
                const id = setInterval(() => {
                    for (const sel of sels) {
                        const el = document.querySelector(sel);
                        if (el) { clearInterval(id); resolve(el); return; }
                    }
                    if (Date.now() - start > maxMs) { clearInterval(id); resolve(null); }
                }, 400);
            });
        }

        function waitFor(fn, maxMs) {
            return new Promise(resolve => {
                const r = fn(); if (r) { resolve(r); return; }
                const start = Date.now();
                const id = setInterval(() => {
                    const r2 = fn();
                    if (r2 || Date.now() - start > maxMs) { clearInterval(id); resolve(r2 || null); }
                }, 600);
            });
        }

        function waitForStableText(getText, maxMs) {
            return new Promise(resolve => {
                let last = '', stableCount = 0;
                const start = Date.now();
                const id = setInterval(() => {
                    const cur = getText();
                    if (cur && cur === last && cur.length > 10) {
                        stableCount++;
                        if (stableCount >= 3) { clearInterval(id); resolve(cur); return; }
                    } else { stableCount = 0; last = cur; }
                    if (Date.now() - start > maxMs) { clearInterval(id); resolve(last); }
                }, 800);
            });
        }

        function parseClaudeResponse(text) {
            const candidates = extractJsonObjects(text);
            for (const candidate of candidates.reverse()) {
                try {
                    const p = JSON.parse(candidate);
                    if (Array.isArray(p.answers) && p.answers.length) {
                        return p.answers;
                    }
                } catch { }
            }
            return [];
        }

        function extractJsonObjects(text) {
            const results = [];
            let depth = 0, start = -1;
            for (let i = 0; i < text.length; i++) {
                if (text[i] === '{') {
                    if (depth === 0) start = i;
                    depth++;
                } else if (text[i] === '}') {
                    depth--;
                    if (depth === 0 && start !== -1) {
                        results.push(text.slice(start, i + 1));
                        start = -1;
                    }
                }
            }
            return results;
        }

        async function storeError(msg) {
            try {
                await chrome.storage.local.set({ [ANSWER_KEY]: { error: msg, taskId: task.taskId, timestamp: Date.now() } });
                await chrome.storage.local.remove([TASK_KEY]);
            } catch(e) { }
            await delay(1500);
            if (isContextValid()) { try { chrome.runtime.sendMessage({ type: 'FOCUS_COURSERA_TAB' }); } catch(e) {} }
        }

        function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
    }
})();
