const fs = require('fs');
const path = require('path');

const srcPath = path.join(__dirname, 'node_modules/@llamaindex/liteparse-wasm/pkg/liteparse_wasm.js');
const destPath = path.join(__dirname, '../lib/liteparse_wasm.js');

let content = fs.readFileSync(srcPath, 'utf8');

// 1. Remove ES6 exports
content = content.replace('export class LiteParse {', 'class LiteParse {');
content = content.replace('export function __wasm_start() {', 'function __wasm_start {'); // wait! Let's check exact syntax in grep search
// Let's replace 'export function __wasm_start()' with 'function __wasm_start()'
content = content.replace('export function __wasm_start() {', 'function __wasm_start() {');
content = content.replace('export function searchItems(items, options) {', 'function searchItems(items, options) {');

// 2. Replace the WASM path resolver
const oldUrlResolver = `    if (module_or_path === undefined) {
        module_or_path = new URL('liteparse_wasm_bg.wasm', import.meta.url);
    }`;

const newUrlResolver = `    if (module_or_path === undefined) {
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
            module_or_path = chrome.runtime.getURL('lib/liteparse_wasm_bg.wasm');
        } else {
            module_or_path = 'liteparse_wasm_bg.wasm';
        }
    }`;

content = content.replace(oldUrlResolver, newUrlResolver);

// 3. Remove default/sync exports at bottom and expose global object
const oldExports = 'export { initSync, __wbg_init as default };';
const newExports = `
globalThis.liteparseWasm = {
  LiteParse,
  __wasm_start,
  searchItems,
  initSync,
  init: __wbg_init
};
`;

content = content.replace(oldExports, newExports);

fs.writeFileSync(destPath, content, 'utf8');
console.log('Successfully transformed and copied liteparse_wasm.js');
