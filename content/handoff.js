// ── Handoff Auto-Paste ─────────────────────────────────────────────

console.log('TokenSaver Handoff Script Loaded');

chrome.storage.local.get('pendingHandoff', (data) => {
  if (!data.pendingHandoff) return;
  
  const { platform, payload, timestamp } = data.pendingHandoff;
  
  // Ignore if this handoff is older than 2 minutes (prevents accidental pastings much later)
  if (Date.now() - timestamp > 120000) return;

  console.log('TokenSaver: Found pending handoff for', platform);

  // Clear it immediately so it doesn't fire again on reload
  chrome.storage.local.remove('pendingHandoff');

  // Start checking for the input box
  const checkInterval = setInterval(() => {
    if (platform === 'chatgpt') {
      const textarea = document.querySelector('#prompt-textarea');
      if (textarea) {
        clearInterval(checkInterval);
        console.log('TokenSaver: Found ChatGPT textarea, injecting...');
        
        if (textarea.tagName === 'TEXTAREA') {
          // Use React native setter
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
          if (nativeInputValueSetter) {
            nativeInputValueSetter.call(textarea, payload);
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
          } else {
            textarea.value = payload;
          }
        } else if (textarea.isContentEditable) {
          // ChatGPT's new rich text editor
          textarea.focus();
          document.execCommand('insertText', false, payload);
        } else {
          textarea.textContent = payload;
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
        textarea.focus();
      }
    } else if (platform === 'gemini') {
      const editor = document.querySelector('rich-textarea div[contenteditable="true"]') || document.querySelector('div[role="textbox"]');
      if (editor) {
        clearInterval(checkInterval);
        console.log('TokenSaver: Found Gemini editor, injecting...');
        editor.focus();
        document.execCommand('insertText', false, payload);
        editor.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
  }, 500);

  // Stop polling after 15 seconds if nothing is found
  setTimeout(() => {
    clearInterval(checkInterval);
    console.log('TokenSaver: Handoff timeout (could not find input box)');
  }, 15000);
});
