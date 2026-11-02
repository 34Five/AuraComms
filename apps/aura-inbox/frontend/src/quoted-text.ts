export type MessagePart = { quoted: boolean; text: string };

// Keep inline replies visible. Only marked quote runs and their attribution fold.
export function splitQuotedText(text: string): MessagePart[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const quoted = lines.map(line => /^[\t ]*>/.test(line));
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*On\s+\S/i.test(lines[i]) || quoted[i]) continue;
    for (let end = i; end < Math.min(lines.length, i + 6); end++) {
      if (quoted[end]) break;
      if (!/\bwrote:\s*$/i.test(lines[end])) continue;
      let next = end + 1;
      while (next < lines.length && !lines[next].trim()) next++;
      if (quoted[next]) for (let j = i; j < next; j++) quoted[j] = true;
      break;
    }
  }
  // Blank lines between quoted paragraphs belong to the same collapsed block.
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() || !quoted[i - 1]) continue;
    let next = i;
    while (next < lines.length && !lines[next].trim()) next++;
    if (quoted[next]) for (let j = i; j < next; j++) quoted[j] = true;
  }
  const parts: MessagePart[] = [];
  for (let i = 0; i < lines.length; i++) {
    const last = parts.at(-1);
    if (last && last.quoted === quoted[i]) last.text += '\n' + lines[i];
    else parts.push({ quoted: quoted[i], text: lines[i] });
  }
  return parts.map(part => ({ ...part, text: part.text.replace(/^\n+|\n+$/g, '') }))
    .filter(part => part.text.length > 0);
}

// Accept only a sanitized DOM fragment. Preserve HTML-only reply boundaries as > lines.
export function fragmentToText(fragment: ParentNode): string {
  const render = (node: Node): string => {
    if (node.nodeType === 3) return node.textContent ?? '';
    if (node.nodeType !== 1) return '';
    const element = node as Element;
    const tag = element.tagName.toLowerCase();
    if (tag === 'br') return '\n';
    const content = Array.from(element.childNodes, render).join('');
    const isQuote = tag === 'blockquote' || ['gmail_quote','yahoo_quoted','protonmail_quote']
      .some(name => element.classList.contains(name));
    if (isQuote) return '\n' + content.trim().split('\n').map(line => '> ' + line).join('\n') + '\n';
    if (tag === 'li') return '\n• ' + content.trim() + '\n';
    if (['div','p','pre','tr','ul','ol'].includes(tag)) return '\n' + content + '\n';
    if (['td','th'].includes(tag)) return content + ' ';
    return content;
  };
  return Array.from(fragment.childNodes, render).join('').replace(/\n{3,}/g,'\n\n').trim();
}
