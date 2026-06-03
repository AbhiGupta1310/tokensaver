// ── Minimal PDF text extractor ────────────────────────────────────
// This is a lightweight pure-JS PDF text extractor for extensions.
// No external dependencies needed.

(function (global) {
  'use strict';

  /**
   * Extract raw text from a PDF ArrayBuffer
   * @param {ArrayBuffer} buffer
   * @returns {string} extracted text
   */
  function extractPDFText(buffer) {
    const uint8 = new Uint8Array(buffer);
    const decoder = new TextDecoder('latin1');
    const raw = decoder.decode(uint8);

    let text = '';

    // Method 1: BT/ET content streams
    const btBlocks = raw.match(/BT[\s\S]*?ET/g) || [];
    for (const block of btBlocks) {
      // Tf, Tj, TJ operators
      const tjs = block.match(/\(([^)]*)\)\s*Tj/g) || [];
      for (const tj of tjs) {
        const m = tj.match(/\(([^)]*)\)/);
        if (m) text += decodeOctal(m[1]) + ' ';
      }

      // Array-form TJ: [(text) -120 (more) ] TJ
      const tjArrays = block.match(/\[[\s\S]*?\]\s*TJ/g) || [];
      for (const arr of tjArrays) {
        const parts = arr.match(/\(([^)]*)\)/g) || [];
        for (const p of parts) {
          text += decodeOctal(p.slice(1, -1));
        }
        text += ' ';
      }
    }

    // Method 2: Hex strings in streams
    const hexStrings = raw.match(/<[0-9A-Fa-f\s]+>/g) || [];
    for (const hex of hexStrings) {
      const clean = hex.replace(/[<>\s]/g, '');
      if (clean.length > 4 && clean.length % 2 === 0) {
        try {
          let str = '';
          for (let i = 0; i < clean.length; i += 2) {
            const code = parseInt(clean.substr(i, 2), 16);
            if (code >= 32 && code < 127) str += String.fromCharCode(code);
          }
          if (str.length > 2 && /[a-zA-Z]{2,}/.test(str)) text += str + ' ';
        } catch (e) {}
      }
    }

    // Method 3: Grab all readable text from streams
    if (text.trim().length < 100) {
      const streams = raw.match(/stream\r?\n([\s\S]*?)\r?\nendstream/g) || [];
      for (const stream of streams) {
        const readable = stream
          .replace(/[^\x20-\x7E\n\r\t]/g, ' ')
          .replace(/\s{3,}/g, ' ')
          .trim();
        if (readable.length > 50 && /[a-zA-Z]{3,}/.test(readable)) {
          text += ' ' + readable;
        }
      }
    }

    // Clean up
    text = text
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, ' ')
      .replace(/\\\(/g, '(')
      .replace(/\\\)/g, ')')
      .replace(/\\(\d{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)))
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return text;
  }

  function decodeOctal(str) {
    return str.replace(/\\(\d{3})/g, (_, oct) => {
      const code = parseInt(oct, 8);
      return code >= 32 && code < 127 ? String.fromCharCode(code) : ' ';
    });
  }

  /**
   * Convert extracted text to Markdown
   * @param {string} text
   * @param {string} filename
   * @returns {string} markdown
   */
  function textToMarkdown(text, filename) {
    const title = (filename || 'Document').replace(/\.pdf$/i, '').replace(/[-_]/g, ' ');
    let md = `# ${title}\n\n`;

    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 1);
    let paraLines = [];

    const flushPara = () => {
      if (paraLines.length) {
        md += paraLines.join(' ') + '\n\n';
        paraLines = [];
      }
    };

    for (const line of lines) {
      const isHeader =
        (line.length < 80 && line === line.toUpperCase() && /[A-Z]/.test(line) && line.length > 2) ||
        /^(Chapter|Section|Part|Article)\s+\d+/i.test(line) ||
        /^\d+\.\s+[A-Z]/.test(line);

      const isBullet = /^[•\-\*\+]\s/.test(line) || /^\d+[.)] /.test(line);

      if (isHeader) {
        flushPara();
        const level = line.length < 30 ? '## ' : '### ';
        md += level + line + '\n\n';
      } else if (isBullet) {
        flushPara();
        md += `- ${line.replace(/^[•\-\*\+]\s*/, '').replace(/^\d+[.)]\s*/, '')}\n`;
      } else {
        paraLines.push(line);
        if (paraLines.join(' ').length > 500) flushPara();
      }
    }
    flushPara();

    return md.replace(/\n{3,}/g, '\n\n').trim();
  }

  // Expose globally
  global.PDFParser = { extractPDFText, textToMarkdown };

})(typeof window !== 'undefined' ? window : globalThis);
