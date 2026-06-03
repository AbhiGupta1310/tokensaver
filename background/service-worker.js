// ── Background Service Worker ─────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  // Initialize storage defaults
  chrome.storage.local.get(['pdfEnabled', 'alertsEnabled'], (data) => {
    const defaults = {};
    if (typeof data.pdfEnabled === 'undefined') defaults.pdfEnabled = true;
    if (typeof data.alertsEnabled === 'undefined') defaults.alertsEnabled = true;
    if (Object.keys(defaults).length) chrome.storage.local.set(defaults);
  });

  console.log('TokenSaver: Claude Optimizer installed ✅');
});

// Handle messages from content scripts / popup
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'USAGE_UPDATE') {
    // Store latest usage
    chrome.storage.local.set({
      lastUsageUpdate: {
        messageCount: msg.messageCount,
        tokensUsed: msg.tokensUsed,
        timestamp: Date.now(),
      }
    });

    // Update badge
    const pct = Math.round((msg.messageCount / 18.2) * 100);
    const badgeText = pct >= 100 ? '!!' : pct >= 75 ? pct + '%' : '';
    const badgeColor = pct >= 90 ? '#f43f5e' : pct >= 75 ? '#f59e0b' : '#7c6aff';

    chrome.action.setBadgeText({ text: badgeText });
    chrome.action.setBadgeBackgroundColor({ color: badgeColor });
  }

  if (msg.type === 'NOTIFY') {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon48.png'),
      title: msg.title || 'TokenSaver',
      message: msg.message || '',
    });
  }


  return true;
});

// Watch for tab navigation to claude.ai
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url?.includes('claude.ai')) {
    // Content script auto-injects via manifest — nothing to do here.
    // But we can reset the badge on new page loads.
    chrome.action.setBadgeText({ text: '', tabId });
  }
});
