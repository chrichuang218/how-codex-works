// Syntax colouring for the few languages the course uses. Loaded only when a
// chapter contains such a block; the text and the copied content stay unchanged.
import hljs from 'highlight.js/lib/core';
import json from 'highlight.js/lib/languages/json';
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import bash from 'highlight.js/lib/languages/bash';
import powershell from 'highlight.js/lib/languages/powershell';
import diff from 'highlight.js/lib/languages/diff';
import ini from 'highlight.js/lib/languages/ini';
import markdown from 'highlight.js/lib/languages/markdown';

hljs.registerLanguage('json', json);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('powershell', powershell);
hljs.registerLanguage('diff', diff);
hljs.registerLanguage('ini', ini);
hljs.registerLanguage('markdown', markdown);
hljs.registerAliases(['ts'], { languageName: 'typescript' });
hljs.registerAliases(['js'], { languageName: 'javascript' });
hljs.registerAliases(['toml'], { languageName: 'ini' });

export const languages = ['json', 'ts', 'typescript', 'js', 'javascript', 'bash', 'powershell', 'diff', 'toml', 'markdown'];

export function highlight(code) {
  const language = code.className.match(/language-(\S+)/)?.[1];
  if (!language || !hljs.getLanguage(language) || code.dataset.highlighted) return;
  const text = code.textContent;
  code.innerHTML = hljs.highlight(text, { language, ignoreIllegals: true }).value;
  // Guard against any change to the visible text, which readers copy and checks compare.
  if (code.textContent !== text) code.textContent = text;
  code.dataset.highlighted = 'true';
  code.classList.add('hljs');
}
