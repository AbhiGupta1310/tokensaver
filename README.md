# ⚡ TokenSaver — Claude Optimizer Extension

An ultra-minimal, highly optimized Chrome extension for developers and power users who use Claude daily. TokenSaver silently tracks your usage, saves massive amounts of tokens with local PDF conversion, and lets you seamlessly hand off your entire conversation to ChatGPT or Gemini when you hit your Claude message limit.

---

## 🚀 Features

### 📊 Clean, Unobtrusive Usage Tracking
- **Native Integration:** A pixel-perfect, ultra-minimal session usage bar injected seamlessly into Claude's UI. It disappears dynamically when you navigate to settings so it never gets in your way.
- **Smart Estimation:** Calculates real-time usage percentages, remaining messages, and reset times based on Claude's model limits.

### 🔀 Flawless LLM Handoff (ChatGPT & Gemini)
- **100% Context Preservation:** Bypasses DOM limits by communicating directly with Claude's internal API to instantly grab your complete, un-truncated chat history.
- **Noise Filtering:** Intelligently strips out Claude's internal "Thoughts" and unsupported artifact fallback text, ensuring your transferred context is pristine.
- **One-Click Switch:** Easily hand off your entire conversation to ChatGPT or Google Gemini right from the extension popup when Claude puts you in a timeout.

### 📄 Local PDF → Markdown Conversion (80–90% Token Savings)
- **Auto-Intercept:** Detects when you upload a PDF to Claude and silently converts it to clean Markdown directly in your browser.
- **Massive Savings:** Uploading Markdown instead of raw PDFs saves 80–90% of your context window and token usage.
- **Privacy First:** All PDF parsing happens 100% locally on your machine using `pdf.js` — no external servers or APIs.

---

## 📦 Installation (Manual Install)

*Since the extension is not yet available on the Chrome Web Store, you can easily install it manually in less than a minute!*

**Step-by-Step Instructions:**
1. Download the ZIP of this repository by clicking the green **Code > Download ZIP** button at the top of this page.
2. Extract/unzip the downloaded file to a folder on your computer.
3. Open Google Chrome and navigate to `chrome://extensions/` in your URL bar.
4. Turn on **Developer mode** using the toggle switch in the top right corner.
5. Click the **"Load unpacked"** button that appears in the top left.
6. Select the extracted `claude-optimizer-extension` folder.
7. Click the puzzle piece icon in Chrome and **Pin** the TokenSaver extension to your toolbar for easy access!

---

## 💡 How to Use

Once installed, TokenSaver integrates seamlessly into your workflow:

1. **Keep an Eye on Usage:** Open [Claude.ai](https://claude.ai) and start chatting. You will notice a new, minimal progress bar injected near your text input. It tracks your message count, tokens, and estimated reset time automatically.
2. **Save Tokens on PDFs:** Drag and drop a PDF file into Claude's chat window, or use the file upload button. The extension will intercept the PDF, convert it to clean Markdown locally, and inject it into your chat (saving you up to 90% of token usage!).
3. **Seamless LLM Handoff:** Hit Claude's message limit? No problem. Click the TokenSaver extension icon in your Chrome toolbar. Click **"Switch to ChatGPT"** or **"Switch to Gemini"** to instantly carry over your entire conversation context and continue working in a new tab.

---

## 🔧 How It Works Under the Hood

### Usage Tracking
The content script (`content/claude-monitor.js`) uses a highly optimized `MutationObserver` to watch Claude's React DOM state. It calculates token estimates and dynamically mounts/unmounts an elegant UI indicator that matches Claude's native design system.

### PDF Interception
The extension intercepts file uploads at the page level. When a `.pdf` file is dropped, it reads the binary stream locally, extracts the layout and text using `pdf.js`, converts it to optimized Markdown, and injects it directly into Claude's text editor.

### API-Level History Extraction
Instead of relying on fragile web scraping, TokenSaver uses your active session to query Claude's `api/organizations/.../chat_conversations/{chatId}` endpoint. It perfectly extracts your full history while filtering out `tool_use` noise and "Thought" blocks before passing the clean text to ChatGPT or Gemini.

---

## 🤝 Contributing

Pull requests are highly encouraged! 
- Found a bug? Open an issue.
- Want to add support for another LLM platform? PRs welcome!

---

## 📄 License

MIT License. Use freely, build upon it, and save those tokens!
