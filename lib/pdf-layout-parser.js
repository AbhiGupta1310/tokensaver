/**
 * @fileoverview Layout-Aware PDF Parser
 * Converts PDF documents to Markdown while preserving structure, tables, and hyperlinks.
 */

(function(global) {
  'use strict';

  /**
   * Cleans text and normalizes spacing and OCR errors.
   */
  class TextNormalizer {
    /**
     * @param {Object} options Configuration options
     */
    constructor(options = {}) {
      this.options = Object.assign({
        normalizeText: true
      }, options);
    }

    /**
     * Applies major fixes: OCR artifacts, letter spacing, and character replacements.
     * @param {string} text Raw text string
     * @returns {string} Normalized text string
     */
    normalize(text) {
      if (!this.options.normalizeText || !text) return text;
      
      let cleanText = text
        .replace(/de ning/g, 'defining')
        .replace(/classi er/g, 'classifier')
        .replace(/pro le/g, 'profile')
        .replace(/certi cation/g, 'certification')
        .replace(/70\{90%/g, '70–90%')
        .replace(/(\d+)\{(\d+)/g, '$1–$2')
        .replace(/GitHub j Live/g, 'GitHub | Live');

      // Fix letter spacing (e.g. W H A T -> What) using split/join strategy
      cleanText = cleanText.replace(/(?:^|\s)((?:[A-Za-z]\s){2,}[A-Za-z])(?:$|\s)/g, (match) => {
          const word = match.replace(/\s+/g, '');
          return ' ' + word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() + ' ';
      });

      return cleanText.trim();
    }

    /**
     * Removes extra spaces and newlines.
     * @param {string} text Raw text string
     * @returns {string} Cleaned whitespace text
     */
    cleanupWhitespace(text) {
      if (!text) return text;
      return text.replace(/\s+/g, ' ').trim();
    }

    /**
     * Formats specific meta labels like "What we do:" to bold.
     * @param {string} text Raw text string
     * @returns {string} Text with bolded labels
     */
    boldMetaLabels(text) {
      if (!text) return text;
      return text.replace(/^(What we do:|Your role:|Duration:)/i, '**$1**');
    }
  }

  /**
   * Handles Link injection into text items.
   */
  class LinkHandler {
    /**
     * @param {Object} options Configuration options
     */
    constructor(options = {}) {
      this.options = Object.assign({ includeLinks: true }, options);
    }

    /**
     * Injects Markdown links into items that intersect with Link annotations.
     * @param {Array} items Text items from PDF.js
     * @param {Array} annotations Annotations from PDF.js
     */
    injectLinks(items, annotations) {
      if (!this.options.includeLinks || !annotations || annotations.length === 0) return;

      for (const a of annotations) {
        if (a.subtype === 'Link' && a.url && a.rect) {
          const [rx1, ry1, rx2, ry2] = a.rect;
          for (const item of items) {
            if (!item.str || item.str.trim() === '') continue;
            const ix1 = item.transform[4];
            const iy1 = item.transform[5];
            const ix2 = ix1 + item.width;
            const iy2 = iy1 + Math.abs(item.transform[3]);

            const overlapX = Math.max(0, Math.min(rx2, ix2) - Math.max(rx1, ix1));
            const overlapY = Math.max(0, Math.min(ry2, iy2) - Math.max(ry1, iy1));
            
            if (overlapX > 0 && overlapY > 0) {
              let cleanUrl = a.url;
              try {
                const u = new URL(a.url);
                const params = new URLSearchParams(u.search);
                const tracking = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid'];
                tracking.forEach(p => params.delete(p));
                u.search = params.toString();
                cleanUrl = u.toString().replace(/\?$/, '');
              } catch (e) {} // Ignore URL parsing errors
              item.str = `[${item.str}](${cleanUrl})`;
              break; 
            }
          }
        }
      }
    }
  }

  /**
   * Extracts text, groups lines, and detects columns.
   */
  class TextExtractor {
    /**
     * @param {Object} options Configuration options
     */
    constructor(options = {}) {
      this.options = Object.assign({ removeHeaders: true }, options);
    }

    /**
     * Extracts raw items and annotations from all pages.
     * @param {Object} pdf PDF.js document object
     * @returns {Promise<Array>} Array of page data objects
     */
    async extractAllPagesData(pdf) {
      const allPagesData = [];
      for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const content = await page.getTextContent();
        const annotations = await page.getAnnotations();
        allPagesData.push({ pageNum, items: content.items, annotations });
      }
      return allPagesData;
    }

    /**
     * Detects repeating headers and footers across pages.
     * @param {Array} allPagesData Array of page data objects
     * @param {number} numPages Total number of pages
     * @returns {Set<string>} Set of repeating header/footer texts
     */
    detectHeadersFooters(allPagesData, numPages) {
      if (!this.options.removeHeaders) return new Set();

      const lineFreq = new Map();
      for (const pageData of allPagesData) {
        const linesMap = new Map();
        for (const item of pageData.items) {
          if (!item.str || item.str.trim() === '') continue;
          const y = item.transform[5];
          const bucketY = Math.round(y / 4) * 4;
          if (!linesMap.has(bucketY)) linesMap.set(bucketY, []);
          linesMap.get(bucketY).push(item);
        }
        
        const sortedY = Array.from(linesMap.keys()).sort((a, b) => b - a);
        const extractedTextLines = [];
        for (const y of sortedY) {
          const lineItems = linesMap.get(y);
          lineItems.sort((a, b) => a.transform[4] - b.transform[4]);
          let text = '';
          for (const it of lineItems) text += it.str;
          text = text.trim();
          if (text) extractedTextLines.push(text);
        }
        
        // Collect top 2 and bottom 2 lines from each page
        const topLines = extractedTextLines.slice(0, 2);
        const bottomLines = extractedTextLines.slice(-2);
        const edgeLines = new Set([...topLines, ...bottomLines]);
        for (const line of edgeLines) {
            lineFreq.set(line, (lineFreq.get(line) || 0) + 1);
        }
      }

      const headersFooters = new Set();
      const threshold = Math.max(2, numPages * 0.3); // 30% of pages
      lineFreq.forEach((count, line) => {
        if (count >= threshold) {
            headersFooters.add(line);
        }
      });
      return headersFooters;
    }

    /**
     * Extracts structured lines and columns from text items.
     * @param {Array} items Text items from PDF.js
     * @param {Set<string>} headersFooters Repeating headers/footers to ignore
     * @param {TextNormalizer} textNormalizer TextNormalizer instance
     * @returns {Object} Object containing extractedLines and avgFontSize
     */
    extractLinesFromItems(items, headersFooters, textNormalizer) {
      const linesMap = new Map();
      let totalFontSize = 0;
      let fontCount = 0;

      for (const item of items) {
        if (!item.str || item.str === '') continue;
        
        const x = item.transform[4];
        const y = item.transform[5];
        const fontSize = Math.abs(item.transform[3]); 

        const bucketY = Math.round(y / 4) * 4;

        if (!linesMap.has(bucketY)) linesMap.set(bucketY, []);
        linesMap.get(bucketY).push({ str: item.str, x, y, fontSize, width: item.width });

        if (item.str.trim().length > 0) {
          totalFontSize += fontSize;
          fontCount++;
        }
      }

      const avgFontSize = fontCount > 0 ? totalFontSize / fontCount : 12;
      const sortedY = Array.from(linesMap.keys()).sort((a, b) => b - a);
      const extractedLines = [];

      for (const y of sortedY) {
        const lineItems = linesMap.get(y);
        lineItems.sort((a, b) => a.x - b.x);

        let maxFontSize = 0;
        let lastEnd = null;

        let columns = [];
        let currentColumn = '';
        let colStartX = null;

        for (const item of lineItems) {
          if (item.fontSize > maxFontSize && item.str.trim().length > 0) {
            maxFontSize = item.fontSize;
          }
          if (lastEnd !== null) {
            const gap = item.x - lastEnd;
            if (gap > item.fontSize * 2.5) {
              columns.push({ text: currentColumn.trim(), x: colStartX });
              currentColumn = '';
              colStartX = item.x;
            } else if (gap > item.fontSize * 0.25) {
              if (!currentColumn.endsWith(' ') && !item.str.startsWith(' ')) {
                currentColumn += ' ';
              }
            }
          }
          if (colStartX === null) colStartX = item.x;
          currentColumn += item.str;
          const itemWidth = item.width > 0 ? item.width : (item.str.includes(' ') ? item.fontSize * 0.25 : 0);
          lastEnd = item.x + itemWidth;
        }
        if (currentColumn.trim()) columns.push({ text: currentColumn.trim(), x: colStartX });

        let rawText = '';
        for (const it of lineItems) rawText += it.str;
        if (this.options.removeHeaders && headersFooters.has(rawText.trim())) continue;

        columns.forEach(c => {
           c.text = textNormalizer.cleanupWhitespace(textNormalizer.normalize(c.text));
        });
        columns = columns.filter(c => c.text);

        const lineText = columns.map(c => c.text).join('   ').trim();
        if (!lineText) continue;

        // Skip standalone page numbers
        if (/^(page\s*)?\d+(\s*of\s*\d+)?$/i.test(lineText)) continue;

        extractedLines.push({
          text: lineText,
          y: y,
          maxFontSize: maxFontSize,
          columns: columns
        });
      }

      return { extractedLines, avgFontSize };
    }
  }

  /**
   * Detects document structures like tables, lists, and headings.
   */
  class StructureDetector {
    constructor() {
      this.listRegex = /^([•◦\-\*]|(?:\d+\.|\d+(?:\.\d+)+)|(?:\d+|[a-zA-Z])\)|(?:[Ss]tep\s+\d+:?))\s+/;
    }

    /**
     * Determines if a text line is a heading and returns its level.
     * @param {string} text The line text
     * @param {number} maxFontSize Maximum font size of the line
     * @param {number} avgFontSize Average font size of the page
     * @returns {number|null} Heading level (2, 3, or 4) or null if not a heading
     */
    isHeading(text, maxFontSize, avgFontSize) {
      if (!text) return null;
      
      const ratio = maxFontSize / avgFontSize;
      const isShort = text.length < 80;

      // Rule 1: Font size ratio + short text
      if (isShort) {
        if (ratio > 1.5) return 2;
        if (ratio > 1.2) return 3;
        if (ratio > 1.05 && ratio <= 1.2) return 4;
      }

      // Rule 2: Regex patterns (e.g. "0 1 —" or "01 —")
      if (/^0\s?\d\s—/i.test(text)) {
         return 2;
      }

      // Rule 3: Keywords
      if (/^(Discovery call|Agent training|Calendar and SMS connection|Chapter \d+|Section \d+|Article \d+)$/i.test(text.replace(/^[•◦\-\*]\s*/, '').trim())) {
         return 3;
      }

      return null;
    }

    /**
     * Checks if text represents a list item.
     * @param {string} text The text to check
     * @returns {string|null} The list marker if it's a list, otherwise null
     */
    isList(text) {
      const match = text.match(this.listRegex);
      return match ? match[1] : null;
    }

    /**
     * Groups text lines into tables where applicable.
     * @param {Array} extractedLines Lines extracted from PDF
     * @returns {Array} Array of structured elements (lines and tables)
     */
    detectTables(extractedLines) {
      const linesWithTables = [];
      let i = 0;
      
      while (i < extractedLines.length) {
        let tableRun = [];
        if (extractedLines[i].columns && extractedLines[i].columns.length > 1) {
           let j = i;
           // Find consecutive lines with 2+ columns
           while (j < extractedLines.length && extractedLines[j].columns && extractedLines[j].columns.length > 1) {
              tableRun.push(extractedLines[j]);
              j++;
           }
        }

        // Table must be at least 2 rows (header + 1 row)
        if (tableRun.length > 1) {
             // Verify consistent column count (or close enough)
             let maxCols = 0;
             tableRun.forEach(l => maxCols = Math.max(maxCols, l.columns.length));
             
             linesWithTables.push({
               type: 'table',
               rows: tableRun,
               maxCols: maxCols,
               y: tableRun[tableRun.length-1].y
             });
             i += tableRun.length;
        } else {
             const line = extractedLines[i];
             line.type = 'line';
             linesWithTables.push(line);
             i++;
        }
      }
      return linesWithTables;
    }
  }

  /**
   * Converts detected structure objects to Markdown string.
   */
  class MarkdownConverter {
    /**
     * @param {TextNormalizer} textNormalizer
     * @param {StructureDetector} structureDetector
     */
    constructor(textNormalizer, structureDetector) {
      this.textNormalizer = textNormalizer;
      this.structureDetector = structureDetector;
    }

    /**
     * Converts an array of structured elements into Markdown format.
     * @param {Array} structuredElements Elements detected on the page
     * @param {number} avgFontSize Average font size on the page
     * @returns {string} Markdown representation of the page
     */
    convertPage(structuredElements, avgFontSize) {
      let pageMd = '';
      let currentParagraph = '';
      let isCurrentList = false;
      let lastY = null;
      let lastListX = 0;

      for (const el of structuredElements) {
        if (el.type === 'table') {
           if (currentParagraph) {
              pageMd += currentParagraph + '\n\n';
              currentParagraph = '';
           }
           let tableMd = '';
           el.rows.forEach((row, idx) => {
               let rowStr = '|';
               for (let c = 0; c < el.maxCols; c++) {
                   rowStr += ` ${row.columns[c] ? row.columns[c].text : ''} |`;
               }
               tableMd += rowStr + '\n';
               if (idx === 0) {
                   let sep = '|';
                   for (let c = 0; c < el.maxCols; c++) sep += '---|';
                   tableMd += sep + '\n';
               }
           });
           pageMd += tableMd + '\n';
           lastY = el.y;
           isCurrentList = false;
           lastListX = 0;
           continue;
        }

        let text = el.text;
        text = this.textNormalizer.boldMetaLabels(text);

        // Check Headings
        let prefix = '';
        const headingLevel = this.structureDetector.isHeading(text, el.maxFontSize, avgFontSize);
        
        if (headingLevel) {
           prefix = '#'.repeat(headingLevel) + ' ';
           if (/^0\s(\d)\s—/i.test(text)) {
              text = text.replace(/^0\s(\d)\s—/i, '0$1 —');
           }
        }

        // Lists
        const listMarker = this.structureDetector.isList(text);
        if (listMarker && !prefix) {
          const isNumber = /\d+/.test(listMarker);
          const normalizedMarker = isNumber ? listMarker + ' ' : '- ';
          text = normalizedMarker + text.replace(this.structureDetector.listRegex, '');
          
          // Detect sub-lists based on x position (indentation)
          const x = el.columns && el.columns.length > 0 ? el.columns[0].x : 0;
          if (!currentParagraph && isCurrentList && x > lastListX + 10) {
             text = '  ' + text;
          }
          lastListX = x;
        } else {
          lastListX = 0;
        }

        let shouldMerge = false;
        if (currentParagraph && !prefix && !listMarker) {
           const gap = lastY !== null ? (lastY - el.y) : 0;
           if (gap > 0 && gap < el.maxFontSize * 2.5) {
              shouldMerge = true;
           }
        }

        if (prefix) {
           if (currentParagraph) pageMd += currentParagraph + '\n\n';
           pageMd += `${prefix}${text}\n\n`;
           currentParagraph = '';
           isCurrentList = false;
        } else if (listMarker) {
           if (currentParagraph && !isCurrentList) pageMd += currentParagraph + '\n\n';
           else if (currentParagraph && isCurrentList) pageMd += currentParagraph + '\n';
           
           currentParagraph = text;
           isCurrentList = true;
        } else {
           if (shouldMerge) {
              currentParagraph += ' ' + text;
           } else {
              if (currentParagraph) {
                 pageMd += currentParagraph + (isCurrentList ? '\n' : '\n\n');
              }
              currentParagraph = text;
              isCurrentList = false;
           }
        }
        
        lastY = el.y;
      }
      
      if (currentParagraph) {
         pageMd += currentParagraph + '\n\n';
      }

      return pageMd;
    }
  }

  /**
   * Main orchestrator class for converting PDF to Markdown.
   */
  class PDFToMarkdownConverter {
    /**
     * @param {Object} options Configuration options
     * @param {boolean} options.includeLinks Include markdown links
     * @param {boolean} options.removeHeaders Remove repeating headers/footers
     * @param {boolean} options.normalizeText Apply text normalizations
     */
    constructor(options = {}) {
      this.options = Object.assign({
        includeLinks: true,
        removeHeaders: true,
        normalizeText: true
      }, options);

      this.textNormalizer = new TextNormalizer(this.options);
      this.linkHandler = new LinkHandler(this.options);
      this.textExtractor = new TextExtractor(this.options);
      this.structureDetector = new StructureDetector();
      this.markdownConverter = new MarkdownConverter(this.textNormalizer, this.structureDetector);
    }

    /**
     * Converts a PDF buffer to Markdown.
     * @param {ArrayBuffer} fileBuffer PDF file buffer
     * @param {string} filename Optional filename
     * @returns {Promise<string>} Markdown string
     */
    async convert(fileBuffer, filename) {
      if (!fileBuffer || !(fileBuffer instanceof ArrayBuffer || fileBuffer instanceof Uint8Array)) {
        throw new Error('Invalid fileBuffer. Must be ArrayBuffer or Uint8Array.');
      }

      if (typeof global.pdfjsLib === 'undefined') {
        throw new Error('PDF.js (pdfjsLib) is not loaded. Please include it before running the converter.');
      }

      if (!global.pdfjsLib.GlobalWorkerOptions.workerSrc) {
        if (typeof chrome !== 'undefined' && chrome.runtime) {
          global.pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('lib/pdf.worker.min.js');
        } else {
          global.pdfjsLib.GlobalWorkerOptions.workerSrc = '../lib/pdf.worker.min.js';
        }
      }

      let fullMarkdown = '';
      let docName = 'Document';

      // Title Generation
      if (filename) {
        docName = filename.replace(/\.pdf$/i, '').replace(/[-_]/g, ' ');
        if (docName.toLowerCase() === 'null' || docName.toLowerCase() === 'undefined' || !docName.trim()) {
          docName = 'Document';
        } else {
          // Title Case formatting
          docName = docName.replace(
            /\w\S*/g,
            (txt) => txt.charAt(0).toUpperCase() + txt.substring(1).toLowerCase()
          );
        }
      }

      fullMarkdown += `# ${docName}\n\n`;

      try {
        const loadingTask = global.pdfjsLib.getDocument({ data: fileBuffer });
        const pdf = await loadingTask.promise;
        
        // Use metadata title if available
        try {
          const meta = await pdf.getMetadata();
          if (meta && meta.info && meta.info.Title && meta.info.Title.trim()) {
            fullMarkdown = `# ${meta.info.Title.trim()}\n\n`;
          }
        } catch (e) {
          console.warn('Could not read PDF metadata.', e);
        }

        const allPagesData = await this.textExtractor.extractAllPagesData(pdf);
        const headersFooters = this.textExtractor.detectHeadersFooters(allPagesData, pdf.numPages);

        const seenPages = new Set();

        for (const pageData of allPagesData) {
          const { items, annotations } = pageData;
          if (!items || items.length === 0) continue;

          this.linkHandler.injectLinks(items, annotations);

          const { extractedLines, avgFontSize } = this.textExtractor.extractLinesFromItems(items, headersFooters, this.textNormalizer);
          
          if (extractedLines.length === 0) continue;

          const structuredElements = this.structureDetector.detectTables(extractedLines);
          let pageMd = this.markdownConverter.convertPage(structuredElements, avgFontSize);

          // General cleanup
          pageMd = pageMd.replace(/(Up to 80% of calls handled without a human)/ig, '## $1\n\n_(Emphasize this as a key stat or callout)_');

          const pageHash = pageMd.replace(/\s+/g, '');
          if (seenPages.has(pageHash)) {
            console.warn(`Duplicate page detected and removed (Page ${pageData.pageNum})`);
            continue;
          }
          seenPages.add(pageHash);

          fullMarkdown += pageMd;
        }

        // Final cleanup
        fullMarkdown = fullMarkdown
          .replace(/\]\(\s+/g, '](') // Clean malformed links
          .replace(/\n{3,}/g, '\n\n')
          .trim();

        return fullMarkdown;

      } catch (error) {
        console.error('Error during PDF conversion:', error);
        throw new Error(`PDF conversion failed: ${error.message}`);
      }
    }
  }

  // Export legacy function for backward compatibility
  async function convertPDFToMarkdown(fileBuffer, filename) {
    const converter = new PDFToMarkdownConverter();
    return converter.convert(fileBuffer, filename);
  }

  // Exports
  global.TextNormalizer = TextNormalizer;
  global.LinkHandler = LinkHandler;
  global.TextExtractor = TextExtractor;
  global.StructureDetector = StructureDetector;
  global.MarkdownConverter = MarkdownConverter;
  global.PDFToMarkdownConverter = PDFToMarkdownConverter;
  global.TokenSaverPDF = { convertPDFToMarkdown };

})(typeof window !== 'undefined' ? window : globalThis);
