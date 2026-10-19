// content.js
(function () {
  'use strict';

  function isContextValid() {
    try { return !!chrome.runtime?.id; } catch { return false; }
  }

  function setStatus(msg) {
    if (isContextValid()) {
      chrome.runtime.sendMessage({ type: 'UPDATE_STATUS', status: msg }, () => {
        chrome.runtime.lastError;
      });
    }
  }

  chrome.runtime.onMessage.addListener((msg, _, sendResponse) => {
    if (msg.type === 'TRIGGER_SOLVE_QUIZ') {
      (async () => {
        setStatus('Scanning quiz...');
        const success = await solveQuiz();
        if (success) setStatus('Quiz completed.');
      })();
      sendResponse({ ok: true });
    }
    return true;
  });

  async function solveQuiz() {
    const blocks = findBlocks();
    if (!blocks.length) { 
      setStatus('Error: No quiz detected'); 
      return false; 
    }

    let promptLines = [
      'You are solving a Coursera quiz.',
      'Return ONLY valid JSON.',
      'Format:',
      '{',
      '  "answers":[',
      '    {',
      '      "question":1,',
      '      "answer":"Option Text"',
      '    }',
      '  ]',
      '}',
      'For multiple-select:',
      '{',
      '  "question":2,',
      '  "answer":[',
      '      "Option A",',
      '      "Option C"',
      '  ]',
      '}',
      'Do not explain.',
      'Do not use markdown.',
      'Do not wrap in code fences.',
      '--- QUIZ ITEMS ---'
    ];

    const blockMeta = [];
    blocks.forEach((block, i) => {
      const q = getQuestion(block);
      const type = getType(block);
      const opts = getOptions(block);
      blockMeta.push({ block, q, type, opts });

      promptLines.push(`Question ${i + 1}: ${q}`);
      if (opts.length) {
        opts.forEach((o) => promptLines.push(`- ${o}`));
      }
      promptLines.push('');
    });

    const prompt = promptLines.join('\n');
    const taskId = Date.now().toString();
    const TASK_KEY = 'cqsClaudeTask';
    const ANSWER_KEY = 'cqsClaudeAnswers';

    try { await chrome.storage.local.remove([ANSWER_KEY]); } catch(e) {}
    try { await chrome.storage.local.set({ [TASK_KEY]: { prompt, taskId, timestamp: Date.now() } }); } catch(e) {}

    setStatus('Sending to Claude...');
    try { chrome.runtime.sendMessage({ type: 'OPEN_CLAUDE_TAB' }); } catch(e) {}

    setStatus('Wait for response...');
    const deadline = Date.now() + 180000;
    
    while (Date.now() < deadline) {
      await delay(2000);

      let stored;
      try {
        stored = await new Promise(r => {
          chrome.storage.local.get([ANSWER_KEY], d => {
            if (chrome.runtime.lastError) { r(null); return; }
            r(d[ANSWER_KEY]);
          });
        });
      } catch(e) { continue; }

      if (!stored) continue;

      if (stored.error) {
        setStatus(`Error: ${stored.error}`);
        await chrome.storage.local.remove([ANSWER_KEY]);
        return false;
      }

      if (Array.isArray(stored.answers) && stored.answers.length > 0) {
        setStatus(`Automatically selecting answers...`);
        
        await applyAnswers(blockMeta, stored.answers);
        await chrome.storage.local.remove([ANSWER_KEY]);
        return true;
      }
    }

    setStatus(`Error: Claude timed out`);
    return false;
  }

  function normalizeText(text) {
    return (text || '').toLowerCase().trim().replace(/\s+/g, ' ');
  }

  async function applyAnswers(blockMeta, aiAnswers) {
    const answerMap = {};
    for (const item of aiAnswers) {
      answerMap[item.question] = item.answer || [];
    }

    for (let i = 0; i < blockMeta.length; i++) {
      const { block } = blockMeta[i];
      const qNum = i + 1;
      let rawAns = answerMap[qNum];
      if (!rawAns) continue;

      const answersArr = Array.isArray(rawAns) ? rawAns : [rawAns];
      
      const inputs = [...block.querySelectorAll('input[type="radio"],input[type="checkbox"]')];
      const labels = [...block.querySelectorAll('label')].map(l => (l.innerText || '').replace(/\s+/g, ' ').trim());

      answersArr.forEach(ansText => {
        let matchedIndex = labels.findIndex(l => l === ansText);
        
        if (matchedIndex === -1) {
          const normAns = normalizeText(ansText);
          matchedIndex = labels.findIndex(l => normalizeText(l) === normAns);
        }
        
        if (matchedIndex !== -1 && inputs[matchedIndex]) {
          const inp = inputs[matchedIndex];
          if (inp.type === 'radio' || !inp.checked) {
            inp.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
            inp.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
            inp.click();
            inp.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }
      });
      
      await delay(250);
    }
  }

  // DOM Parsers
  function findBlocks() {
    const seen = new Set(), results = [];
    for (const sel of [
      '[data-testid="part-Submission_MultipleChoiceQuestion"]',
      '[data-testid="part-Submission_CheckboxQuestion"]',
      '[data-testid*="Question"]', 
      '.rc-FormPartsQuestion'
    ]) {
      document.querySelectorAll(sel).forEach(n => { if (!seen.has(n)) { seen.add(n); results.push(n); } });
    }
    if (results.length) return results;
    
    document.querySelectorAll('input[type="radio"],input[type="checkbox"]').forEach(inp => {
      let p = inp;
      for (let i = 0; i < 10; i++) {
        p = p?.parentElement; if (!p) break;
        if (p.querySelectorAll('input[type="radio"],input[type="checkbox"]').length >= 2) {
          if (!seen.has(p)) { seen.add(p); results.push(p); } break;
        }
      }
    });
    
    return results;
  }

  function getType(b) {
    if (b.querySelector('input[type="checkbox"]')) return 'checkbox';
    return 'radio';
  }

  function getQuestion(b) {
    const legend = b.querySelector('[data-testid="legend"]');
    const cml = legend?.querySelector('.rc-CML');
    const fromLegend = ((cml || legend || null)?.innerText || '').replace(/^\d+\.\s*/, '').replace(/\d+\s*points?\s*/gi, '').replace(/\s+/g, ' ').trim();
    if (fromLegend) return fromLegend.slice(0, 1200);
    const fallback = b.querySelector('h1,h2,h3,h4,h5,p,label');
    return (fallback?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 1200);
  }

  function getOptions(b) {
    const opts = b.querySelectorAll('.rc-Option');
    if (opts.length >= 2) return [...opts].map(o => (o.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    return [...b.querySelectorAll('label')].map(l => (l.innerText || '').replace(/\s+/g, ' ').trim()).filter(t => t.length > 0 && t.length < 500);
  }

  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

})();
