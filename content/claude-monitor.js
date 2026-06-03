// ── Claude Monitor Content Script ────────────────────────────────
// Injects into claude.ai to track usage and intercept PDF uploads.
// Runs in ISOLATED world. Receives events from page-interceptor.js (MAIN world).

(function () {
  'use strict';

  // ── Constants ─────────────────────────────────────────────────
  const MAX_POINTS = 225; // Equivalent to 45 Sonnet messages
  const COST = { opus: 25, sonnet: 5, haiku: 1 };
  const RESET_HOURS = 5; // Claude resets roughly every 5 hours
  const STORAGE_KEY_DAILY = 'dailyUsage';
  const STORAGE_KEY_WEEKLY = 'weeklyUsage';

  // ── State ─────────────────────────────────────────────────────
  let pdfEnabled = true;
  let dailyUsage = { date: '', pointsUsed: 0, rateLimited: false, firstMsgTime: null, resetTime: null, apiRemaining: null, apiLimit: null };
  let weeklyUsage = {}; // { "Mon Jun 01 2026": 25, ... }
  let conversationHistory = [];
  let scanDebounceTimer = null;
  let indicatorInjected = false;
  let indicatorUpdateInterval = null;

  // ── Load settings ─────────────────────────────────────────────
  chrome.storage.local.get(['pdfEnabled', STORAGE_KEY_DAILY, STORAGE_KEY_WEEKLY], (data) => {
    if (typeof data.pdfEnabled !== 'undefined') pdfEnabled = data.pdfEnabled;

    const today = new Date().toDateString();
    if (data[STORAGE_KEY_DAILY] && data[STORAGE_KEY_DAILY].date === today) {
      dailyUsage = data[STORAGE_KEY_DAILY];
      // Migrate old data if present
      if (typeof dailyUsage.pointsUsed === 'undefined') {
        dailyUsage.pointsUsed = (dailyUsage.messagesSent || 0) * COST.sonnet;
      }
    } else {
      dailyUsage = { date: today, pointsUsed: 0, rateLimited: false, firstMsgTime: null, resetTime: null, apiRemaining: null, apiLimit: null };
    }

    if (data[STORAGE_KEY_WEEKLY]) {
      weeklyUsage = data[STORAGE_KEY_WEEKLY];
      cleanOldWeeklyData();
    }

    init();
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.pdfEnabled) pdfEnabled = changes.pdfEnabled.newValue;
  });

  // ── Message listener ──────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'GET_USAGE') {
      const msgs = Math.round(dailyUsage.pointsUsed / COST.sonnet);
      sendResponse({
        messageCount: msgs,
        tokensUsed: msgs * 1000,
        rateLimited: dailyUsage.rateLimited,
        apiPercent: getUsagePercent()
      });
    }
    if (msg.type === 'GET_CONVERSATION') {
      getConversationHistoryAPI().then(history => {
        sendResponse({ conversation: history });
      });
      return true;
    }
    if (msg.type === 'SET_PDF_ENABLED') {
      pdfEnabled = msg.enabled;
    }
    if (msg.type === 'INJECT_PROMPT') {
      injectPromptText(msg.text);
      sendResponse({ ok: true });
    }
    return true;
  });

  // ── Init ──────────────────────────────────────────────────────
  function init() {
    listenForFetchEvents();
    startDOMObserver();
    interceptFileInput();
    interceptDropZone();

    if (document.readyState === 'complete') {
      setTimeout(onPageReady, 800);
    } else {
      window.addEventListener('load', () => setTimeout(onPageReady, 800));
    }

    // SPA nav handling
    const origPush = history.pushState;
    history.pushState = function (...args) {
      origPush.apply(this, args);
      setTimeout(onPageReady, 1500);
      fetchInitialUsageExplicitly();
    };
    const origReplace = history.replaceState;
    history.replaceState = function (...args) {
      origReplace.apply(this, args);
      setTimeout(onPageReady, 1500);
      fetchInitialUsageExplicitly();
    };
    window.addEventListener('popstate', () => {
      setTimeout(onPageReady, 1500);
      fetchInitialUsageExplicitly();
    });

    fetchInitialUsageExplicitly();
    
    // Poll every 60s for real-time rolling window updates
    setInterval(fetchInitialUsageExplicitly, 60000);
  }

  function fetchInitialUsageExplicitly() {
    let orgId = localStorage.getItem('lastActiveOrg');
    if (!orgId) {
      const match = document.cookie.match(/(?:^|;\s*)lastActiveOrg=([^;]*)/);
      if (match) orgId = match[1];
    }
    
    if (orgId) {
      fetchUsage(orgId);
    } else {
      fetch('https://claude.ai/api/organizations')
        .then(r => r.json())
        .then(orgs => {
          if (orgs && orgs.length > 0) {
            fetchUsage(orgs[0].uuid);
          }
        }).catch(e => {});
    }
  }

  function fetchUsage(orgId) {
    fetch(`https://claude.ai/api/organizations/${orgId}/usage`)
      .then(r => r.json())
      .then(data => {
         if (data && data.five_hour && typeof data.five_hour.utilization === 'number') {
            onMessageLimitData({ usage_endpoint: data });
         }
      })
      .catch(e => {});
  }

  function onPageReady() {
    injectUsageIndicator();
    injectSidebarCard();
    checkRateLimitBanner();
    extractConversationHistory();
  }

  // ── Fetch Event Listeners ─────────────────────────────────────
  function listenForFetchEvents() {
    window.addEventListener('__tokensaver_msg_sent', () => onMessageSent());
    window.addEventListener('__tokensaver_rate_limit', () => onRateLimited());
    window.addEventListener('__tokensaver_message_limit', (e) => onMessageLimitData(e.detail));

    // Request cached data from page-interceptor if it already loaded
    window.dispatchEvent(new CustomEvent('__tokensaver_ready'));
  }

  function onMessageSent() {
    const today = new Date().toDateString();
    if (dailyUsage.date !== today) {
      dailyUsage = { date: today, pointsUsed: 0, rateLimited: false, firstMsgTime: null, resetTime: null, apiRemaining: null, apiLimit: null };
    }
    if (!dailyUsage.firstMsgTime) {
      dailyUsage.firstMsgTime = Date.now();
    }
    
    const model = detectModelName();
    dailyUsage.pointsUsed += COST[model];

    // Update weekly
    weeklyUsage[today] = (weeklyUsage[today] || 0) + COST[model];

    persistAll();
    updateIndicator();
    checkThresholds();
  }

  function onRateLimited() {
    dailyUsage.rateLimited = true;
    if (dailyUsage.pointsUsed < MAX_POINTS) {
      dailyUsage.pointsUsed = MAX_POINTS;
    }

    // Try to parse reset time from banner
    parseResetTimeFromDOM();

    // If no reset time found, estimate
    if (!dailyUsage.resetTime && dailyUsage.firstMsgTime) {
      dailyUsage.resetTime = dailyUsage.firstMsgTime + (RESET_HOURS * 60 * 60 * 1000);
    } else if (!dailyUsage.resetTime) {
      dailyUsage.resetTime = Date.now() + (RESET_HOURS * 60 * 60 * 1000);
    }

    const today = new Date().toDateString();
    weeklyUsage[today] = dailyUsage.pointsUsed;

    persistAll();
    updateIndicator();
  }

  function onMessageLimitData(data) {
    if (!data) return;
    
    // Handle the /usage endpoint format
    if (data.usage_endpoint) {
       const fiveHour = data.usage_endpoint.five_hour;
       if (fiveHour && typeof fiveHour.utilization === 'number') {
          // utilization is literally the percentage (e.g., 14.0 = 14%)
          dailyUsage.apiPercent = fiveHour.utilization;
          dailyUsage.pointsUsed = Math.round((fiveHour.utilization / 100) * MAX_POINTS);
          dailyUsage.apiRemaining = null;
          if (fiveHour.resets_at) {
             dailyUsage.resetTime = new Date(fiveHour.resets_at).getTime();
          }
       }
       const sevenDay = data.usage_endpoint.seven_day;
       if (sevenDay && typeof sevenDay.utilization === 'number') {
          const today = new Date().toDateString();
          weeklyUsage[today] = sevenDay.utilization * COST.sonnet;
       }
       persistAll();
       updateIndicator();
       return;
    }

    if (!data.message_limit) return;
    let ml = data.message_limit;
    
    let resetsAt = ml.resets_at;
    if (!resetsAt && ml.windows) {
       const keys = Object.keys(ml.windows);
       if (keys.length > 0) resetsAt = ml.windows[keys[0]].resets_at;
    }
    
    if (resetsAt) {
      if (resetsAt < 10000000000) resetsAt = resetsAt * 1000;
      dailyUsage.resetTime = resetsAt;
    }

    if (typeof ml.remaining === 'number') {
       dailyUsage.apiRemaining = ml.remaining;
       dailyUsage.apiLimit = ml.limit || 45; 
       dailyUsage.pointsUsed = Math.max(0, (dailyUsage.apiLimit - ml.remaining) * COST.sonnet); 
    } else {
       let foundRemaining = null;
       if (ml.windows) {
         for (const key of Object.keys(ml.windows)) {
            if (typeof ml.windows[key].remaining === 'number') {
               foundRemaining = ml.windows[key].remaining;
               break;
            }
         }
       }
       if (foundRemaining !== null) {
          dailyUsage.apiRemaining = foundRemaining;
          dailyUsage.apiLimit = ml.limit || 45;
          dailyUsage.pointsUsed = Math.max(0, (dailyUsage.apiLimit - foundRemaining) * COST.sonnet);
       }
    }
    
    persistAll();
    updateIndicator();
  }

  function parseResetTimeFromDOM() {
    const bodyText = document.body.innerText || '';
    // Match "until 6:40 PM" or "until 18:40"
    const match = bodyText.match(/until\s+(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    if (match) {
      let hours = parseInt(match[1], 10);
      const mins = parseInt(match[2], 10);
      const ampm = match[3];
      if (ampm) {
        if (ampm.toUpperCase() === 'PM' && hours < 12) hours += 12;
        if (ampm.toUpperCase() === 'AM' && hours === 12) hours = 0;
      }
      const now = new Date();
      const reset = new Date(now);
      reset.setHours(hours, mins, 0, 0);
      if (reset <= now) reset.setDate(reset.getDate() + 1);
      dailyUsage.resetTime = reset.getTime();
    }
  }

  function persistAll() {
    chrome.storage.local.set({
      [STORAGE_KEY_DAILY]: dailyUsage,
      [STORAGE_KEY_WEEKLY]: weeklyUsage
    });
    const msgs = Math.round(dailyUsage.pointsUsed / COST.sonnet);
    chrome.runtime.sendMessage({
      type: 'USAGE_UPDATE',
      messageCount: msgs,
      tokensUsed: msgs * 1000,
      apiPercent: getUsagePercent()
    });
  }

  function cleanOldWeeklyData() {
    const now = new Date();
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - 7);
    for (const dateStr of Object.keys(weeklyUsage)) {
      if (new Date(dateStr) < cutoff) delete weeklyUsage[dateStr];
    }
  }

  function getWeeklyPercent() {
    const totalPtsThisWeek = Object.values(weeklyUsage).reduce((a, b) => a + b, 0);
    const maxWeekly = MAX_POINTS * 7; 
    return Math.min(100, Math.round((totalPtsThisWeek / maxWeekly) * 100));
  }

  // ── Rate Limit Banner Detection ───────────────────────────────
  function checkRateLimitBanner() {
    const bodyText = document.body.innerText || '';
    if (
      bodyText.includes('out of free messages') ||
      bodyText.includes('You are out of free') ||
      bodyText.includes('message limit')
    ) {
      if (!dailyUsage.rateLimited) onRateLimited();
    }
  }

  // ── DOM Observer ──────────────────────────────────────────────
  function startDOMObserver() {
    const debouncedCheck = () => {
      if (scanDebounceTimer) clearTimeout(scanDebounceTimer);
      scanDebounceTimer = setTimeout(() => {
        const bar = document.getElementById('ts-indicator');
        const inputArea = findInputArea();
        
        let shouldInject = false;
        if (!bar) {
          shouldInject = true;
        } else if (inputArea && bar.parentElement !== inputArea.parentElement) {
          shouldInject = true;
        }
        
        if (shouldInject) {
          indicatorInjected = false;
          injectUsageIndicator();
        } else if (bar) {
          bar.style.display = inputArea ? 'flex' : 'none';
          updateIndicator(); 
        }
        
        checkRateLimitBanner();
      }, 500);
    };
    const observer = new MutationObserver(debouncedCheck);
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ── Conversation History ──────────────────────────────────────

  async function getOrgId() {
    let orgId = localStorage.getItem('lastActiveOrg');
    if (!orgId) {
      const match = document.cookie.match(/(?:^|;\s*)lastActiveOrg=([^;]*)/);
      if (match) orgId = match[1];
    }
    if (orgId) return orgId;
    
    try {
      const r = await fetch('https://claude.ai/api/organizations');
      const orgs = await r.json();
      if (orgs && orgs.length > 0) return orgs[0].uuid;
    } catch(e) {}
    return null;
  }

  async function getConversationHistoryAPI() {
    const match = window.location.pathname.match(/\/chat\/([a-f0-9\-]+)/);
    const chatId = match ? match[1] : null;
    
    if (chatId) {
      const orgId = await getOrgId();
      if (orgId) {
        try {
          const res = await fetch(`https://claude.ai/api/organizations/${orgId}/chat_conversations/${chatId}`);
          if (res.ok) {
            const data = await res.json();
            if (data && Array.isArray(data.chat_messages)) {
              const history = data.chat_messages.map(m => {
                const role = m.sender === 'human' ? 'user' : 'assistant';
                let text = '';
                
                if (Array.isArray(m.content)) {
                  text = m.content
                    .filter(c => c.type === 'text' && c.text)
                    .map(c => c.text.trim())
                    .join('\n\n');
                } else if (m.text) {
                  text = m.text;
                }
                
                text = text.replace(/```[\s\S]*?This block is not supported on your current device yet\.[\s\S]*?```\n?/gi, '').trim();
                text = text.replace(/This block is not supported on your current device yet\./gi, '').trim();
                
                return { role, content: text };
              }).filter(m => m.content.length > 0);
              
              conversationHistory = history;
              return history;
            }
          }
        } catch (e) {
          console.warn('TokenSaver: API history fetch failed, falling back to DOM', e);
        }
      }
    }
    
    extractConversationHistory();
    return conversationHistory;
  }

  function extractConversationHistory() {
    const selectors = [
      '.font-user-message, .font-claude-message',
      '[data-message-author]',
      '[data-testid*="human-turn"], [data-testid*="user-turn"], [data-testid*="assistant-turn"], [data-testid*="ai-turn"]',
      '[data-role="user"], [data-role="assistant"]',
    ];
    let messages = [];
    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      if (els.length > 0) { messages = Array.from(els); break; }
    }
    
    if (messages.length === 0) {
      const t = document.querySelectorAll('[class*="turn"], [class*="Turn"]');
      if (t.length > 0) messages = Array.from(t);
    }

    if (messages.length > 0) {
      conversationHistory = messages.map((node, i) => {
        const tid = node.getAttribute('data-testid') || '';
        const r = node.getAttribute('data-role') || node.getAttribute('data-message-author') || '';
        const cls = node.className || '';
        
        let isHuman = i % 2 === 0;
        if (tid.includes('human') || tid.includes('user') || r === 'user' || cls.includes('user')) isHuman = true;
        else if (tid.includes('assistant') || tid.includes('ai') || r === 'assistant' || cls.includes('claude')) isHuman = false;
        
        return { role: isHuman ? 'user' : 'assistant', content: (node.innerText || '').trim() };
      });
    } else {
      // Intelligent fallback: Parse the raw text using Claude's screen-reader markers
      const mainContainer = document.querySelector('.flex-1.overflow-y-auto') || 
                            document.querySelector('.mx-auto.max-w-3xl') || 
                            document.querySelector('main');
      if (mainContainer && mainContainer.innerText.trim().length > 50) {
        let text = mainContainer.innerText;
        
        // Remove TokenSaver UI from the bottom
        text = text.replace(/Sonnet.*?optimizer.*?SESSION.*?wk.*?$/is, '');
        text = text.replace(/optimizer\s*·\s*SESSION[\s\S]*?$/is, '');
        
        const parts = text.split(/(You said:|Claude responded:)/);
        const parsedMsgs = [];
        let currentRole = 'user';
        let currentContent = '';
        
        for (let i = 0; i < parts.length; i++) {
          const p = parts[i];
          if (p === 'You said:') {
            if (currentContent.trim()) parsedMsgs.push({ role: currentRole, content: currentContent.trim() });
            currentRole = 'user';
            currentContent = '';
          } else if (p === 'Claude responded:') {
            if (currentContent.trim()) parsedMsgs.push({ role: currentRole, content: currentContent.trim() });
            currentRole = 'assistant';
            currentContent = '';
          } else {
            currentContent += p;
          }
        }
        if (currentContent.trim()) parsedMsgs.push({ role: currentRole, content: currentContent.trim() });

        conversationHistory = parsedMsgs.map(m => {
          // Clean up Claude's tool usage noise
          let cleanTxt = m.content
            .replace(/^(?:Searched the web|Ran \d+ commands|viewed a file|click to expand).*$/gim, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
          return { role: m.role, content: cleanTxt };
        }).filter(m => m.content.length > 0);
      } else {
        conversationHistory = [];
      }
    }
  }

  // ══════════════════════════════════════════════════════════════
  // ── USAGE INDICATOR (pixel-perfect match) ─────────────────────
  // ══════════════════════════════════════════════════════════════

  function injectUsageIndicator() {
    if (indicatorInjected && document.getElementById('ts-indicator')) return;
    document.getElementById('ts-indicator')?.remove();

    const pct = getUsagePercent();
    const modelName = detectModelName();
    const remainingPts = Math.max(0, MAX_POINTS - dailyUsage.pointsUsed);
    const remainingMsgs = Math.floor(remainingPts / COST[modelName]);
    const timeLeft = getTimeLeftStr();
    const wkPct = getWeeklyPercent();
    const dayTime = getDayTimeStr();

    const bar = document.createElement('div');
    bar.id = 'ts-indicator';
    bar.className = 'ts-indicator';

    bar.innerHTML = `
      <div class="ts-left">
        <span class="ts-dot" id="ts-dot"></span>
        <span class="ts-label">optimizer</span>
        <span class="ts-sep">·</span>
        <span class="ts-session">SESSION</span>
        <span class="ts-pct" id="ts-pct">${pct}%</span>
      </div>
      <div class="ts-bar-wrap">
        <div class="ts-track">
          <div class="ts-fill" id="ts-fill" style="width:${pct}%"></div>
          <div class="ts-thumb" id="ts-thumb" style="left:${pct}%"></div>
        </div>
      </div>
      <div class="ts-right">
        <span class="ts-msgs" id="ts-msgs">~${remainingMsgs} msgs</span>
        <span class="ts-model-badge" id="ts-model">${modelName}</span>
        <span class="ts-meta-sep">·</span>
        <span class="ts-meta" id="ts-time">${timeLeft}</span>
        <span class="ts-meta-sep">|</span>
        <span class="ts-meta" id="ts-week">wk ${wkPct}%</span>
        <span class="ts-meta-sep">·</span>
        <span class="ts-meta" id="ts-day">${dayTime}</span>
      </div>
    `;

    // Try to inject near the input area
    const inputArea = findInputArea();
    if (inputArea) {
      const parent = inputArea.parentElement;
      if (parent) {
        parent.insertBefore(bar, inputArea.nextSibling);
        bar.classList.add('ts-indicator-inline');
        bar.style.display = 'flex';
      } else {
        document.body.appendChild(bar);
        bar.style.display = 'none';
      }
    } else {
      document.body.appendChild(bar);
      bar.style.display = 'none';
    }

    indicatorInjected = true;

    // Update time fields every 30 seconds
    if (indicatorUpdateInterval) clearInterval(indicatorUpdateInterval);
    indicatorUpdateInterval = setInterval(() => {
      const timeEl = document.getElementById('ts-time');
      const dayEl = document.getElementById('ts-day');
      if (timeEl) timeEl.textContent = getTimeLeftStr();
      if (dayEl) dayEl.textContent = getDayTimeStr();
    }, 30000);
  }

  function findInputArea() {
    const editor = document.querySelector(
      'div.ProseMirror[contenteditable="true"], .ProseMirror, ' +
      '[contenteditable="true"][role="textbox"], [contenteditable="true"]'
    );
    if (!editor) return null;

    let el = editor;
    for (let i = 0; i < 10; i++) {
      el = el.parentElement;
      if (!el || el === document.body) break;
      if (el.tagName === 'FORM') return el;
      const btns = el.querySelectorAll('button');
      const hasEditor = el.querySelector('[contenteditable="true"]');
      if (btns.length >= 2 && hasEditor && el.offsetHeight > 50 && el.offsetHeight < 350) {
        return el;
      }
    }
    return editor.closest('form') || editor.parentElement?.parentElement || null;
  }

  function getUsagePercent() {
    if (dailyUsage.rateLimited) return 100;
    
    if (typeof dailyUsage.apiRemaining === 'number' && typeof dailyUsage.apiLimit === 'number') {
       const used = dailyUsage.apiLimit - dailyUsage.apiRemaining;
       return Math.min(100, Math.max(0, Math.round((used / dailyUsage.apiLimit) * 100)));
    }
    
    return Math.min(100, Math.round((dailyUsage.pointsUsed / MAX_POINTS) * 100));
  }

  function detectModelName() {
    const btns = document.querySelectorAll('button, [role="button"]');
    for (const b of btns) {
      const t = (b.innerText || '').toLowerCase();
      if (t.includes('opus')) return 'opus';
      if (t.includes('haiku')) return 'haiku';
      if (t.includes('sonnet')) return 'sonnet';
    }
    return 'sonnet';
  }

  function getTimeLeftStr() {
    if (dailyUsage.resetTime) {
      const now = Date.now();
      const diff = dailyUsage.resetTime - now;
      if (diff <= 0) return '0m';
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      return h > 0 ? `${h}h ${m}m` : `${m}m`;
    }
    if (dailyUsage.firstMsgTime) {
      const elapsed = Date.now() - dailyUsage.firstMsgTime;
      const remaining = (RESET_HOURS * 3600000) - elapsed;
      if (remaining <= 0) return '0m';
      const h = Math.floor(remaining / 3600000);
      const m = Math.floor((remaining % 3600000) / 60000);
      return h > 0 ? `${h}h ${m}m` : `${m}m`;
    }
    return '—';
  }

  function getDayTimeStr() {
    const now = new Date();
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const day = days[now.getDay()];
    const h = now.getHours();
    const m = String(now.getMinutes()).padStart(2, '0');
    return `${day} ${h}:${m}`;
  }

  function updateIndicator() {
    const pct = getUsagePercent();
    const modelName = detectModelName();
    let remainingMsgs = 0;
    if (typeof dailyUsage.apiRemaining === 'number') {
       remainingMsgs = dailyUsage.apiRemaining;
    } else {
       const remainingPts = Math.max(0, MAX_POINTS - dailyUsage.pointsUsed);
       remainingMsgs = Math.floor(remainingPts / COST[modelName]);
    }
    const wkPct = getWeeklyPercent();

    const pctEl = document.getElementById('ts-pct');
    const msgsEl = document.getElementById('ts-msgs');
    const fillEl = document.getElementById('ts-fill');
    const thumbEl = document.getElementById('ts-thumb');
    const weekEl = document.getElementById('ts-week');
    const timeEl = document.getElementById('ts-time');
    const modelEl = document.getElementById('ts-model');

    if (!pctEl) {
      indicatorInjected = false;
      injectUsageIndicator();
      return;
    }

    pctEl.textContent = pct + '%';
    msgsEl.textContent = `~${remainingMsgs} msgs`;
    fillEl.style.width = pct + '%';
    thumbEl.style.left = pct + '%';
    if (weekEl) weekEl.textContent = `wk ${wkPct}%`;
    if (timeEl) timeEl.textContent = getTimeLeftStr();
    if (modelEl) modelEl.textContent = modelName;
  }


  // ── Threshold alerts ─────────────────────────────────────────
  let alerted75 = false, alerted90 = false;

  function checkThresholds() {
    const pct = getUsagePercent();
    chrome.storage.local.get(['alertsEnabled'], (data) => {
      if (data.alertsEnabled === false) return;
      if (pct >= 75 && !alerted75) { alerted75 = true; showToast('⚠️ 75% of session used', 'Consider switching soon'); }
      if (pct >= 90 && !alerted90) { alerted90 = true; showToast('🚨 90% of session used!', 'Open extension to switch to ChatGPT', true); }
    });
  }

  function showToast(title, sub, urgent = false) {
    const t = document.createElement('div');
    t.className = 'ts-toast' + (urgent ? ' ts-toast-urgent' : ' ts-toast-warn');
    t.innerHTML = `<div class="ts-toast-title">${title}</div><div class="ts-toast-sub">${sub}</div>`;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add('ts-toast-show'));
    setTimeout(() => { t.classList.remove('ts-toast-show'); setTimeout(() => t.remove(), 300); }, 5000);
  }

  // ══════════════════════════════════════════════════════════════
  // ── PDF INTERCEPTOR ───────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════

  function interceptFileInput() {
    const watch = () => {
      document.querySelectorAll('input[type="file"]').forEach(input => {
        if (input.dataset.tsPatched) return;
        input.dataset.tsPatched = '1';
        input.addEventListener('change', async (e) => {
          if (!pdfEnabled) return;
          const pdfs = Array.from(e.target.files || []).filter(f =>
            f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
          if (!pdfs.length) return;
          e.stopImmediatePropagation();
          e.preventDefault();
          for (const pdf of pdfs) await handlePDFConversion(pdf);
        }, true);
      });
    };
    watch();
    new MutationObserver(watch).observe(document.body, { childList: true, subtree: true });
  }

  function interceptDropZone() {
    let overlay = null;
    document.addEventListener('dragenter', (e) => {
      if (!pdfEnabled || overlay) return;
      if (!Array.from(e.dataTransfer?.types || []).includes('Files')) return;

      overlay = document.createElement('div');
      overlay.id = 'ts-drag-overlay';
      overlay.className = 'ts-drag-overlay';
      overlay.innerHTML = `<div class="ts-drag-content"><div class="ts-drag-icon">📄</div><div class="ts-drag-text">Drop PDF to convert to Markdown</div><div class="ts-drag-sub">Saves ~80-90% tokens vs raw PDF upload</div></div>`;

      overlay.addEventListener('dragover', ev => { ev.preventDefault(); ev.stopPropagation(); ev.dataTransfer.dropEffect = 'copy'; }, true);
      overlay.addEventListener('dragleave', ev => { if (!overlay.contains(ev.relatedTarget)) removeOverlay(); }, true);
      overlay.addEventListener('drop', async ev => {
        ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation();
        removeOverlay();
        const pdfs = Array.from(ev.dataTransfer?.files || []).filter(f =>
          f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
        if (!pdfs.length) { const t = showConversionToast('ℹ️ Only PDF files are intercepted'); setTimeout(() => t.remove(), 3000); return; }
        for (const pdf of pdfs) await handlePDFConversion(pdf);
      }, true);

      document.body.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add('ts-drag-active'));
    }, false);

    function removeOverlay() {
      if (overlay) { overlay.classList.remove('ts-drag-active'); const el = overlay; overlay = null; setTimeout(() => el.remove(), 200); }
    }
    document.addEventListener('dragend', removeOverlay, false);
  }

  async function handlePDFConversion(file) {
    const toast = showConversionToast(`Converting ${file.name}…`);
    try {
      const md = await convertPDFToMarkdown(file);
      injectTextIntoEditor(md);
      const origTok = Math.round(file.size / 4);
      const mdTok = Math.round(md.length / 4);
      const saved = Math.max(0, origTok - mdTok);
      chrome.storage.local.get('usage', d => {
        const u = d.usage || {};
        chrome.storage.local.set({ usage: { ...u, tokensSaved: (u.tokensSaved || 0) + saved } });
      });
      toast.update(`✅ Saved ~${Math.round(saved / 1000)}k tokens! (PDF → MD)`);
    } catch (err) {
      console.error('TokenSaver: PDF error', err);
      toast.update('❌ ' + (err.message || 'PDF conversion failed'));
    }
    setTimeout(() => toast.remove(), 4000);
  }

  // ══════════════════════════════════════════════════════════════
  // ── PDF → MARKDOWN CONVERTER ──────────────────────────────────
  // ══════════════════════════════════════════════════════════════

  async function convertPDFToMarkdown(file) {
    const buffer = await file.arrayBuffer();
    return await TokenSaverPDF.convertPDFToMarkdown(buffer, file.name);
  }

  // ══════════════════════════════════════════════════════════════
  // ── EDITOR INJECTION ──────────────────────────────────────────
  // ══════════════════════════════════════════════════════════════

  function findEditor() {
    return document.querySelector('div.ProseMirror[contenteditable="true"]') ||
      document.querySelector('.ProseMirror') ||
      document.querySelector('[contenteditable="true"][role="textbox"]') ||
      document.querySelector('[contenteditable="true"]');
  }

  function injectTextIntoEditor(text) {
    const ed = findEditor();
    if (!ed) return;
    ed.focus();
    
    // Simulate paste event for ProseMirror to handle natively
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/plain', text);
    const event = new ClipboardEvent('paste', {
      clipboardData: dataTransfer,
      bubbles: true,
      cancelable: true
    });
    ed.dispatchEvent(event);
  }

  function injectPromptText(text) {
    const ed = findEditor();
    if (!ed) return;
    ed.focus();

    // Select all existing content
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(ed);
    sel.removeAllRanges();
    sel.addRange(range);

    // Simulate paste to overwrite
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/plain', text);
    const event = new ClipboardEvent('paste', {
      clipboardData: dataTransfer,
      bubbles: true,
      cancelable: true
    });
    ed.dispatchEvent(event);
  }

  // ── Toast helper ──────────────────────────────────────────────
  function showConversionToast(msg) {
    const t = document.createElement('div');
    t.className = 'ts-convert-toast';
    t.innerHTML = `<span class="ts-convert-dot"></span><span class="ts-convert-msg">${msg}</span>`;
    document.body.appendChild(t);
    requestAnimationFrame(() => t.classList.add('ts-convert-show'));
    return {
      update: m => { const s = t.querySelector('.ts-convert-msg'); if (s) s.textContent = m; const d = t.querySelector('.ts-convert-dot'); if (d) d.style.animation = 'none'; },
      remove: () => { t.classList.remove('ts-convert-show'); setTimeout(() => t.remove(), 300); },
    };
  }

})();
