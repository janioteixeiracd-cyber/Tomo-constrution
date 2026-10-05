/** Mostra o Markdown simples das respostas da IA (títulos, listas, negrito, itálico) sem usar innerHTML. */
export function renderMarkdown(el: HTMLElement, md: string): void {
  el.replaceChildren();
  let list: HTMLElement | null = null;
  let para: string[] = [];
  const flushPara = () => {
    if (!para.length) return;
    const p = document.createElement('p');
    para.forEach((line, i) => {
      if (i) p.append(document.createElement('br'));
      inline(p, line);
    });
    el.append(p);
    para = [];
  };
  for (const raw of md.replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd();
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    const li = /^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/.exec(line);
    if (!line.trim()) {
      flushPara();
      list = null;
    } else if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushPara();
      list = null;
      el.append(document.createElement('hr'));
    } else if (h) {
      flushPara();
      list = null;
      const t = document.createElement(h[1].length <= 2 ? 'h3' : 'h4');
      inline(t, h[2]);
      el.append(t);
    } else if (li) {
      flushPara();
      const tag = li[1] ? 'OL' : 'UL';
      if (!list || list.tagName !== tag) {
        list = document.createElement(tag.toLowerCase());
        el.append(list);
      }
      const item = document.createElement('li');
      inline(item, li[2]);
      list.append(item);
    } else {
      list = null;
      para.push(line);
    }
  }
  flushPara();
}

function inline(parent: HTMLElement, text: string) {
  const re = /\*\*(.+?)\*\*|__(.+?)__|\*(?!\s)(.+?)\*|`([^`]+)`/g;
  let last = 0;
  for (let m; (m = re.exec(text)); ) {
    if (m.index > last) parent.append(text.slice(last, m.index));
    const tag = m[1] ?? m[2] ? 'strong' : m[3] ? 'em' : 'code';
    const node = document.createElement(tag);
    if (tag === 'code') node.textContent = m[4];
    else inline(node, m[1] ?? m[2] ?? m[3]);
    parent.append(node);
    last = m.index + m[0].length;
  }
  if (last < text.length) parent.append(text.slice(last));
}
