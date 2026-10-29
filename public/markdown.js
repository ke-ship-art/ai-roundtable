export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function inlineMarkdown(value) {
  const code = [];
  let source = String(value).replace(/`([^`\n]+)`/g, (_match, content) => {
    const index = code.push(`<code>${escapeHtml(content)}</code>`) - 1;
    return `\u0000CODE${index}\u0000`;
  });
  source = escapeHtml(source)
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^_])_([^_\n]+)_(?!_)/g, '$1<em>$2</em>');
  return source.replace(/\u0000CODE(\d+)\u0000/g, (_match, index) => code[Number(index)]);
}

/**
 * A deliberately small Markdown subset. Input is escaped before generated tags
 * are inserted, so model output cannot inject scripts, event handlers or HTML.
 */
export function renderMarkdown(value) {
  const lines = String(value ?? '').replaceAll('\r\n', '\n').split('\n');
  const output = [];
  let code = null;
  let list = null;

  const closeList = () => {
    if (!list) return;
    output.push(`</${list}>`);
    list = null;
  };

  for (const line of lines) {
    const fence = line.match(/^\s*```([^`]*)$/);
    if (fence) {
      closeList();
      if (code) {
        output.push(`<pre><code>${escapeHtml(code.lines.join('\n'))}</code></pre>`);
        code = null;
      } else {
        code = { language: fence[1].trim(), lines: [] };
      }
      continue;
    }
    if (code) {
      code.lines.push(line);
      continue;
    }

    const unordered = line.match(/^\s*[-+*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      const wanted = unordered ? 'ul' : 'ol';
      if (list !== wanted) {
        closeList();
        list = wanted;
        output.push(`<${wanted}>`);
      }
      output.push(`<li>${inlineMarkdown((unordered || ordered)[1])}</li>`);
      continue;
    }
    closeList();

    if (!line.trim()) {
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length + 2;
      output.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      output.push(`<blockquote>${inlineMarkdown(quote[1])}</blockquote>`);
      continue;
    }
    output.push(`<p>${inlineMarkdown(line)}</p>`);
  }
  closeList();
  if (code) output.push(`<pre><code>${escapeHtml(code.lines.join('\n'))}</code></pre>`);
  return output.join('');
}
