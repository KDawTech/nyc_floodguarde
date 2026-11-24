/**
 * ============================================================================
 * NYC FloodGuard 2.0 — Secure Markdown Renderer for AI Assistant Responses
 * File: markdownRenderer.js
 *
 * Uses `marked` (GFM) + `DOMPurify` to convert Gemini Markdown output into
 * clean, sanitized HTML with headings, bold text, bullet lists, numbered
 * lists, inline code, and safe external links — eliminating raw `**` tokens
 * while preventing XSS.
 * ============================================================================
 */
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({
  gfm: true,
  breaks: true
});

const ALLOWED_TAGS = [
  'p',
  'br',
  'strong',
  'em',
  'b',
  'i',
  'code',
  'pre',
  'ul',
  'ol',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'blockquote',
  'hr',
  'a',
  'span'
];

const ALLOWED_ATTR = ['href', 'target', 'rel'];

function escapePlainHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Cleans malformed dangling Markdown emphasis artifacts before parsing so
 * users never see raw `**` markers in rendered assistant replies.
 */
function normalizeMarkdownInput(rawText) {
  let text = String(rawText ?? '').replace(/\r\n/g, '\n').trim();
  if (!text) return '';

  // Ensure headings have a space after # if the model omitted it (e.g. "##Summary")
  text = text.replace(/^(#{1,4})([^\s#])/gm, '$1 $2');

  // If a line has an odd number of `**` tokens, strip the stray unmatched marker
  text = text
    .split('\n')
    .map((line) => {
      const matches = line.match(/\*\*/g);
      if (matches && matches.length % 2 === 1) {
        return line.replace(/\*\*/g, '');
      }
      return line;
    })
    .join('\n');

  return text;
}

/**
 * Renders untrusted Markdown text into sanitized HTML safe for innerHTML.
 */
export function renderAssistantMarkdown(rawText) {
  const normalized = normalizeMarkdownInput(rawText);
  if (!normalized) return '';

  const rawHtml = marked.parse(normalized, { async: false });

  // Browser environment: full DOMPurify sanitization
  if (typeof window !== 'undefined' && typeof DOMPurify?.sanitize === 'function') {
    const clean = DOMPurify.sanitize(String(rawHtml), {
      ALLOWED_TAGS,
      ALLOWED_ATTR,
      ALLOW_DATA_ATTR: false
    });

    // Enforce safe external link attributes
    const tmp = document.createElement('div');
    tmp.innerHTML = clean;
    tmp.querySelectorAll('a').forEach((anchor) => {
      const href = (anchor.getAttribute('href') || '').trim();
      if (!/^https?:\/\//i.test(href)) {
        anchor.replaceWith(document.createTextNode(anchor.textContent || ''));
        return;
      }
      anchor.setAttribute('target', '_blank');
      anchor.setAttribute('rel', 'noopener noreferrer');
    });

    return tmp.innerHTML;
  }

  // Non-browser fallback (e.g., Node verification tests without DOM)
  return String(rawHtml)
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/<img\b[^>]*>/gi, '')
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '') || `<p>${escapePlainHtml(normalized)}</p>`;
}
