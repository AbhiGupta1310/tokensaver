// ── Page Interceptor (runs in MAIN world) ─────────────────────────
// Intercepts fetch calls to track Claude API usage accurately.
// Communicates with the content script via CustomEvents.

(function () {
  'use strict';

  const _fetch = window.fetch;
  let cachedLimitData = null;

  window.addEventListener('__tokensaver_ready', () => {
    if (cachedLimitData) {
      window.dispatchEvent(new CustomEvent('__tokensaver_message_limit', { detail: cachedLimitData }));
    }
  });

  window.fetch = async function (resource, init) {
    const url = typeof resource === 'string'
      ? resource
      : (resource instanceof Request ? resource.url : '');
    const method = (
      init?.method ||
      (resource instanceof Request ? resource.method : 'GET') ||
      'GET'
    ).toUpperCase();

    // Detect when user sends a message (completion endpoint)
    const isMessageSend = method === 'POST' && (
      url.includes('/completion') ||
      (url.includes('/chat_conversations') && init?.body)
    );

    if (isMessageSend) {
      try {
        window.dispatchEvent(new CustomEvent('__tokensaver_msg_sent'));
      } catch (e) { /* ignore */ }
    }

    let response;
    try {
      response = await _fetch.apply(this, arguments);
    } catch (err) {
      throw err;
    }

    // Intercept JSON responses for initial usage data on load
    if (response.headers.get('content-type')?.includes('application/json')) {
      try {
        const cloned = response.clone();
        cloned.json().then(data => {
          const found = findMessageLimit(data);
          if (found) {
            cachedLimitData = { message_limit: found };
            window.dispatchEvent(new CustomEvent('__tokensaver_message_limit', { detail: cachedLimitData }));
          } else if (data && data.five_hour && data.five_hour.utilization !== undefined) {
            cachedLimitData = { usage_endpoint: data };
            window.dispatchEvent(new CustomEvent('__tokensaver_message_limit', { detail: cachedLimitData }));
          }
        }).catch(e => {});
      } catch(e) {}
    }

    // Intercept SSE Stream for message limits (during active chat)
    if (isMessageSend && response.body && response.headers.get('content-type')?.includes('text/event-stream')) {
      const clonedResponse = response.clone();
      parseSSEStream(clonedResponse.body).catch(e => console.error("TokenSaver Stream Error:", e));
    }

    // Detect rate limiting
    if (isMessageSend && (response.status === 429 || response.status === 403)) {
      try {
        window.dispatchEvent(new CustomEvent('__tokensaver_rate_limit'));
      } catch (e) { /* ignore */ }
    }

    return response;
  };

  // --- Initial Page Load Data Extraction ---
  function findMessageLimit(obj, depth = 0) {
    if (depth > 10 || !obj || typeof obj !== 'object') return null;
    if (obj.message_limit && typeof obj.message_limit === 'object') return obj.message_limit;
    if (obj.type === 'message_limit' && obj.remaining !== undefined) return obj;
    for (let key of Object.keys(obj)) {
      const res = findMessageLimit(obj[key], depth + 1);
      if (res) return res;
    }
    return null;
  }

  function extractInitialLimits() {
    try {
      if (window.__remixContext) {
        const found = findMessageLimit(window.__remixContext);
        if (found) {
           cachedLimitData = { message_limit: found };
           window.dispatchEvent(new CustomEvent('__tokensaver_message_limit', { detail: cachedLimitData }));
        }
      }
    } catch(e) {}
  }

  // Attempt extraction shortly after load
  setTimeout(extractInitialLimits, 500);
  setTimeout(extractInitialLimits, 2000);

  async function parseSSEStream(stream) {
    const reader = stream.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Keep incomplete line in buffer

        let currentEvent = null;

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i].trim();
          
          if (line.startsWith('event:')) {
            currentEvent = line.substring(6).trim();
          } else if (line.startsWith('data:')) {
            const dataStr = line.substring(5).trim();
            if (currentEvent === 'message_limit' || dataStr.includes('"message_limit"')) {
              try {
                const data = JSON.parse(dataStr);
                cachedLimitData = data;
                window.dispatchEvent(new CustomEvent('__tokensaver_message_limit', { detail: data }));
              } catch (e) {
                // Ignore parsing errors
              }
            }
          }
        }
      }
    } catch (e) {
      // Stream reading error
    }
  }
})();
