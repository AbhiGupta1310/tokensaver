// ── Popup JS ──────────────────────────────────────────────────────

const TOTAL_MSGS = 45;   // Max messages in a session (approximate limit for Sonnet)
const AVG_TOKENS = 1000;   // Avg tokens per message

// Quick templates
const TEMPLATES = [
  { icon: '🐛', label: 'Debug this code', text: 'Debug this code. Identify the issue, explain why it fails, and provide a corrected version with explanation.' },
  { icon: '📝', label: 'Summarize', text: 'Summarize the following in 3 bullet points, using plain language:' },
  { icon: '🔍', label: 'Explain concept', text: 'Explain [concept] simply. Use an analogy, a 2-sentence summary, and one practical example.' },
  { icon: '⚡', label: 'Refactor code', text: 'Refactor this code for readability, performance, and best practices. Show a diff-style before/after.' },
];

// ── State ──────────────────────────────────────────────────────────
let state = {
  messageCount: 0,
  tokensUsed: 0,
  tokensSaved: 0,
  sessions: [],
  pdfEnabled: true,
  apiKey: '',
  lastOptimized: '',
  apiPercent: null,
};

let convertedMarkdown = '';

// ── Init ───────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadState();
  renderUsage();
  // renderSessionHistory();
  // renderTemplates();
  setupTabs();
  setupFileHandlers();
  setupSettings();
  // setupPromptInput();
  setupButtons();
  checkClaudeTab();
});

function setupButtons() {
  document.getElementById('btn-switch-chatgpt').addEventListener('click', () => handleSwitch('chatgpt'));
  document.getElementById('btn-switch-gemini').addEventListener('click', () => handleSwitch('gemini'));
  document.getElementById('drop-zone').addEventListener('click', () => document.getElementById('pdf-input').click());
  // document.getElementById('optimize-btn').addEventListener('click', optimizePrompt);
  // document.getElementById('btn-copy-optimized').addEventListener('click', copyOptimized);
  // document.getElementById('btn-inject-claude').addEventListener('click', injectIntoClaudeInput);
  // document.getElementById('btn-save-key').addEventListener('click', saveApiKey);
  // document.getElementById('btn-reset-stats').addEventListener('click', resetStats);
}

async function loadState() {
  const data = await chrome.storage.local.get(['usage', 'dailyUsage', 'sessions', 'pdfEnabled', 'apiKey']);

  // Prefer dailyUsage (cumulative) over per-conversation usage
  const today = new Date().toDateString();
  if (data.dailyUsage && data.dailyUsage.date === today) {
    state.messageCount = data.dailyUsage.messagesSent || 0;
    state.tokensUsed = (data.dailyUsage.messagesSent || 0) * 1000;
    state.rateLimited = data.dailyUsage.rateLimited || false;
  } else if (data.usage) {
    state.messageCount = data.usage.messageCount || 0;
    state.tokensUsed = data.usage.tokensUsed || 0;
  }

  if (data.usage) {
    state.tokensSaved = data.usage.tokensSaved || 0;
  }

  if (data.sessions) state.sessions = data.sessions;
  if (typeof data.pdfEnabled !== 'undefined') state.pdfEnabled = data.pdfEnabled;
  if (data.apiKey) {
    state.apiKey = data.apiKey;
    // document.getElementById('api-key-input').value = data.apiKey;
  }
  document.getElementById('toggle-pdf').checked = state.pdfEnabled;
  document.getElementById('set-pdf').checked = state.pdfEnabled;
}

async function saveState() {
  await chrome.storage.local.set({
    usage: {
      messageCount: state.messageCount,
      tokensUsed: state.tokensUsed,
      tokensSaved: state.tokensSaved,
    },
    sessions: state.sessions,
    pdfEnabled: state.pdfEnabled,
  });
}

// ── Usage Rendering ───────────────────────────────────────────────
function renderUsage() {
  const pct = state.apiPercent !== null 
    ? Math.min(100, Math.max(0, Math.round(state.apiPercent)))
    : Math.min(100, Math.round((state.messageCount / TOTAL_MSGS) * 100));

  const pctEl = document.getElementById('usage-pct');
  const fillEl = document.getElementById('progress-fill');

  pctEl.textContent = pct + '%';
  fillEl.style.width = pct + '%';
  
  // Calculate remaining accurately based on pct if possible
  let remainingMsgs = TOTAL_MSGS - state.messageCount;
  if (state.apiPercent !== null) {
    remainingMsgs = Math.round(TOTAL_MSGS * (1 - (state.apiPercent / 100)));
  }

  document.getElementById('session-msgs').textContent = `~${state.messageCount} / ${TOTAL_MSGS} msgs`;
  document.getElementById('tokens-used').textContent = fmtNum(state.tokensUsed) + ' tokens used';
  document.getElementById('tokens-left').textContent = '~' + fmtNum(Math.max(0, remainingMsgs * AVG_TOKENS)) + ' left';

  document.getElementById('stat-msgs').textContent = state.messageCount;
  // document.getElementById('stat-tokens').textContent = fmtNum(state.tokensUsed);
  document.getElementById('stat-saved').textContent = fmtNum(state.tokensSaved);

  // Color states
  pctEl.classList.remove('warn', 'danger');
  fillEl.classList.remove('warn', 'danger');

  if (pct >= 90) {
    pctEl.classList.add('danger');
    fillEl.classList.add('danger');
    document.querySelectorAll('.handoff-btn').forEach(b => b.classList.add('ready'));
  } else if (pct >= 75) {
    pctEl.classList.add('warn');
    fillEl.classList.add('warn');
  }
}

function renderSessionHistory() {
  const el = document.getElementById('session-history');
  const today = getTodaySessions();

  if (today.length === 0) {
    el.innerHTML = '<div style="text-align:center;padding:12px;color:var(--text3);font-size:11px">No sessions yet today</div>';
    return;
  }

  el.innerHTML = today.map((s, i) => {
    const pct = Math.min(100, Math.round((s.messages / TOTAL_MSGS) * 100));
    return `
      <div class="session-item">
        <span class="session-label" style="font-family:JetBrains Mono,monospace;font-size:9px">${s.time}</span>
        <div class="session-bar"><div class="session-fill" style="width:${pct}%"></div></div>
        <span class="session-pct">${pct}%</span>
      </div>
    `;
  }).join('');
}

function getTodaySessions() {
  const today = new Date().toDateString();
  return state.sessions.filter(s => s.date === today);
}

// ── Tabs ──────────────────────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      const id = 'tab-' + tab.dataset.tab;
      document.getElementById(id)?.classList.add('active');
    });
  });
}

// ── Check if on Claude tab ────────────────────────────────────────
async function checkClaudeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const onClaude = tab?.url?.includes('claude.ai');
  const dot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');

  if (onClaude) {
    dot.style.background = 'var(--green)';
    dot.style.boxShadow = '0 0 6px var(--green)';
    statusText.textContent = 'on claude.ai';

    // Pull latest data from content script
    try {
      const resp = await chrome.tabs.sendMessage(tab.id, { type: 'GET_USAGE' });
      if (resp) {
        state.messageCount = resp.messageCount;
        state.tokensUsed = resp.tokensUsed;
        if (typeof resp.apiPercent === 'number') state.apiPercent = resp.apiPercent;
        await saveState();
        renderUsage();
        renderSessionHistory();
      }
    } catch (e) {
      // Content script not injected yet
    }
  } else {
    dot.style.background = 'var(--text3)';
    dot.style.boxShadow = 'none';
    statusText.textContent = 'not on claude.ai';
  }
}

// ── Switch LLM ────────────────────────────────────────────────────
async function handleSwitch(platform = 'chatgpt') {
  const btns = document.querySelectorAll('.handoff-btn');
  btns.forEach(b => { b.style.opacity = '0.5'; b.style.pointerEvents = 'none'; });

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    let fullContext = '';
    if (tab?.url?.includes('claude.ai')) {
      const resp = await chrome.tabs.sendMessage(tab.id, { type: 'GET_CONVERSATION' });
      if (resp?.conversation && resp.conversation.length > 0) {
        const transcript = resp.conversation.map(m => `${m.role.toUpperCase()}:\n${m.content}`).join('\n\n');
        fullContext = `Here is the transcript of my previous conversation with Claude. Please read and remember this context, as I will now continue the conversation with you here:\n\n---\n\n${transcript}`;
      }
    }

    const payload = fullContext || 
      `Continue from my previous Claude conversation. I had ${state.messageCount} messages in my session.`;

    // Always copy to clipboard as a backup
    await navigator.clipboard.writeText(payload);

    let url = 'https://chatgpt.com/';
    if (platform === 'gemini') url = 'https://gemini.google.com/app';

    chrome.storage.local.set({ 
      pendingHandoff: { platform, payload, timestamp: Date.now() } 
    }, () => {
      chrome.tabs.create({ url });
    });

    saveCurrentSession();
    setTimeout(() => renderUsage(), 2000);
  } catch (e) {
    alert('Handoff error: ' + e.message);
  } finally {
    btns.forEach(b => { b.style.opacity = '1'; b.style.pointerEvents = 'auto'; });
  }
}

async function summarizeConversation(messages) {
  const apiKey = state.apiKey;
  if (!apiKey) {
    // Fallback: manual summary
    const preview = messages.slice(-6).map(m => `${m.role.toUpperCase()}: ${m.content.slice(0, 200)}`).join('\n');
    return `Continue our conversation. Here's the recent context:\n\n${preview}`;
  }

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-3-5-haiku-latest',
        max_tokens: 512,
        messages: [{
          role: 'user',
          content: `Summarize this conversation concisely for handoff to another AI assistant. Capture key topics, decisions, code snippets, and any unresolved questions. Be specific. Max 300 words.\n\nConversation:\n${messages.map(m => `${m.role}: ${m.content}`).join('\n\n')}`,
        }],
      }),
    });
    const data = await res.json();
    const summary = data.content?.[0]?.text || '';
    return `Context from my previous Claude conversation:\n\n${summary}\n\nPlease continue helping me from where we left off.`;
  } catch {
    const preview = messages.slice(-6).map(m => `${m.role.toUpperCase()}: ${m.content.slice(0, 200)}`).join('\n');
    return `Continue our conversation. Recent context:\n\n${preview}`;
  }
}

function saveCurrentSession() {
  const now = new Date();
  state.sessions.push({
    date: now.toDateString(),
    time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    messages: state.messageCount,
    tokens: state.tokensUsed,
  });
  // Reset session
  state.messageCount = 0;
  state.tokensUsed = 0;
  saveState();
}

// ── PDF Handling ──────────────────────────────────────────────────
function setupFileHandlers() {
  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('pdf-input');

  dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file?.type === 'application/pdf') processPDF(file);
    else showNotif('pdf-notif', 'error', '❌ Please drop a PDF file');
  });

  fileInput.addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) processPDF(file);
  });

  document.getElementById('toggle-pdf').addEventListener('change', async e => {
    state.pdfEnabled = e.target.checked;
    document.getElementById('set-pdf').checked = state.pdfEnabled;
    await chrome.storage.local.set({ pdfEnabled: state.pdfEnabled });
    // Notify content script
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url?.includes('claude.ai')) {
      chrome.tabs.sendMessage(tab.id, { type: 'SET_PDF_ENABLED', enabled: state.pdfEnabled });
    }
  });

  document.getElementById('copy-md-btn').addEventListener('click', () => {
    if (convertedMarkdown) {
      navigator.clipboard.writeText(convertedMarkdown);
      document.getElementById('copy-md-btn').textContent = '✅ COPIED';
      setTimeout(() => { document.getElementById('copy-md-btn').textContent = 'COPY MD'; }, 2000);
    }
  });
}

async function processPDF(file) {
  const loader = document.getElementById('pdf-loader');
  const result = document.getElementById('convert-result');
  loader.classList.add('show');
  result.classList.remove('show');

  try {
    const buffer = await file.arrayBuffer();
    const markdown = await TokenSaverPDF.convertPDFToMarkdown(buffer, file.name);
    convertedMarkdown = markdown;

    const originalSize = file.size;
    const mdSize = new Blob([markdown]).size;
    const saving = Math.round((1 - mdSize / originalSize) * 100);
    const tokOrig = Math.round(originalSize / 4);
    const tokMd = Math.round(mdSize / 4);

    document.getElementById('result-stats').textContent =
      `PDF: ~${fmtNum(tokOrig)} tokens → Markdown: ~${fmtNum(tokMd)} tokens  |  ${saving > 0 ? saving : 0}% smaller`;
    document.getElementById('result-preview').textContent = markdown.slice(0, 400) + (markdown.length > 400 ? '\n…' : '');

    state.tokensSaved += Math.max(0, tokOrig - tokMd);
    document.getElementById('stat-saved').textContent = fmtNum(state.tokensSaved);
    await saveState();

    loader.classList.remove('show');
    result.classList.add('show');
    showNotif('pdf-notif', 'success', `✅ Converted! ~${saving > 0 ? saving : 0}% token reduction`);
  } catch (e) {
    loader.classList.remove('show');
    showNotif('pdf-notif', 'error', '❌ Error reading PDF: ' + e.message);
  }
}


// ── Prompt Optimizer ──────────────────────────────────────────────
function setupPromptInput() {
  const ta = document.getElementById('prompt-input');
  ta.addEventListener('input', () => {
    document.getElementById('char-count').textContent = ta.value.length + ' chars';
  });
}

async function optimizePrompt() {
  const input = document.getElementById('prompt-input').value.trim();
  if (!input) { showNotif('prompt-notif', 'error', '❌ Enter a prompt first'); return; }
  if (input.length < 10) { showNotif('prompt-notif', 'error', '❌ Prompt too short to optimize'); return; }

  const btn = document.getElementById('optimize-btn');
  btn.classList.add('loading');
  btn.disabled = true;
  document.getElementById('optimized-card').classList.remove('show');

  try {
    const optimized = await callOptimize(input);

    const origTokens = Math.round(input.length / 4);
    const newTokens = Math.round(optimized.length / 4);
    const saving = Math.round((1 - newTokens / origTokens) * 100);

    document.getElementById('optimized-text').textContent = optimized;
    document.getElementById('opt-savings').textContent = `${saving > 0 ? saving : 0}% smaller`;
    document.getElementById('optimized-card').classList.add('show');

    state.tokensSaved += Math.max(0, origTokens - newTokens);
    await saveState();
    renderUsage();

    state.lastOptimized = optimized;
  } catch (e) {
    showNotif('prompt-notif', 'error', '❌ ' + e.message);
  }

  btn.classList.remove('loading');
  btn.disabled = false;
}

async function callOptimize(prompt) {
  const apiKey = state.apiKey;

  if (apiKey) {
    // Use real Claude API
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-3-5-haiku-latest',
        max_tokens: 512,
        messages: [{
          role: 'user',
          content: `You are a prompt engineer. Rewrite this prompt to be more concise, specific, and token-efficient while preserving the exact intent. Remove filler words, redundancy, and vague phrasing. Keep it under 60% of original length if possible. Output ONLY the rewritten prompt, no explanation.\n\nOriginal: ${prompt}`,
        }],
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.content?.[0]?.text?.trim() || prompt;
  }

  // Fallback: rule-based optimization
  return ruleBasedOptimize(prompt);
}

function ruleBasedOptimize(text) {
  return text
    .replace(/\b(can you please|could you please|would you be able to|I would like you to|I want you to|please help me to)\b/gi, '')
    .replace(/\b(in detail|in great detail|thoroughly|comprehensively|exhaustively)\b/gi, '')
    .replace(/\b(and also|as well as|in addition to)\b/gi, 'and')
    .replace(/\b(basically|essentially|actually|really|very|quite|just|simply)\b/gi, '')
    .replace(/\bunderstand and explain\b/gi, 'explain')
    .replace(/\bhelp me (to )?understand\b/gi, 'explain')
    .replace(/I want to know about\b/gi, 'Explain')
    .replace(/\s{2,}/g, ' ')
    .replace(/^\s+/, '')
    .replace(/\?$/, '')
    .trim()
    .replace(/^./, c => c.toUpperCase()) + '.';
}

function copyOptimized() {
  if (state.lastOptimized) {
    navigator.clipboard.writeText(state.lastOptimized);
    showNotif('prompt-notif', 'success', '✅ Copied to clipboard!');
  }
}

async function injectIntoClaudeInput() {
  if (!state.lastOptimized) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.includes('claude.ai')) {
    showNotif('prompt-notif', 'error', '❌ Open Claude.ai first');
    return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'INJECT_PROMPT', text: state.lastOptimized });
    showNotif('prompt-notif', 'success', '✅ Injected into Claude input!');
    window.close();
  } catch (e) {
    showNotif('prompt-notif', 'error', '❌ Could not inject. Refresh Claude tab.');
  }
}

// ── Templates ────────────────────────────────────────────────────
function renderTemplates() {
  const el = document.getElementById('templates');
  el.innerHTML = '';
  TEMPLATES.forEach(t => {
    const btn = document.createElement('button');
    btn.style.cssText = "display:flex;align-items:center;gap:8px;padding:8px 10px;background:var(--bg3);border:1px solid var(--border);border-radius:7px;color:var(--text2);font-size:11px;cursor:pointer;text-align:left;transition:all 0.15s;width:100%";
    btn.innerHTML = `
      <span>${t.icon}</span>
      <span style="font-weight:500;color:var(--text)">${t.label}</span>
      <span style="flex:1"></span>
      <span style="font-size:10px;color:var(--text3)">USE →</span>
    `;
    btn.addEventListener('click', () => useTemplate(t.text));
    el.appendChild(btn);
  });
}

function useTemplate(text) {
  document.getElementById('prompt-input').value = text;
  document.getElementById('char-count').textContent = text.length + ' chars';
  // Switch to prompt tab
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  // document.querySelector('[data-tab="prompt"]').classList.add('active');
  // document.getElementById('tab-prompt').classList.add('active');
}

// ── Settings ──────────────────────────────────────────────────────
function setupSettings() {
  document.getElementById('set-pdf').addEventListener('change', async e => {
    state.pdfEnabled = e.target.checked;
    document.getElementById('toggle-pdf').checked = state.pdfEnabled;
    await chrome.storage.local.set({ pdfEnabled: state.pdfEnabled });
  });
}

async function saveApiKey() {
  // const key = document.getElementById('api-key-input').value.trim();
  if (!key.startsWith('sk-ant-') && key !== '') {
    alert('Invalid API key format. Should start with sk-ant-');
    return;
  }
  state.apiKey = key;
  await chrome.storage.local.set({ apiKey: key });
  const btn = document.querySelector('#tab-settings button');
  const orig = btn.textContent;
  btn.textContent = '✅ SAVED';
  setTimeout(() => btn.textContent = orig, 2000);
}

async function resetStats() {
  if (!confirm('Reset all session data?')) return;
  state.messageCount = 0;
  state.tokensUsed = 0;
  state.tokensSaved = 0;
  state.sessions = [];
  await saveState();
  renderUsage();
  renderSessionHistory();
}

// ── Utils ──────────────────────────────────────────────────────────
function fmtNum(n) {
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

function showNotif(id, type, msg) {
  const el = document.getElementById(id);
  el.className = `notif-box ${type} show`;
  el.textContent = msg;
  setTimeout(() => el.classList.remove('show'), 4000);
}

// Listen for messages from content script
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'USAGE_UPDATE') {
    state.messageCount = msg.messageCount;
    state.tokensUsed = msg.tokensUsed;
    if (typeof msg.apiPercent === 'number') state.apiPercent = msg.apiPercent;
    renderUsage();
    renderSessionHistory();
  }
});
