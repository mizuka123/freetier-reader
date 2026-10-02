const XML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

export function escapeXml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);
}

function titleOf(text) {
  const firstLine = text.split(/\r?\n/)[0].trim();
  return firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine || '(no text)';
}

function contentHtml(post) {
  const body = escapeXml(post.text).replace(/\r?\n/g, '<br>');
  return `<p>${body}</p><p><a href="${escapeXml(post.link)}">View on X</a></p>`;
}

/**
 * @param {{ username: string, selfUrl: string, posts: Array<{link: string, text: string, created_at: string}> }} args
 */
export function buildAtom({ username, selfUrl, posts }) {
  const updated = posts[0]?.created_at ?? new Date(0).toISOString();
  const profile = `https://x.com/${encodeURIComponent(username)}`;
  const entries = posts.map((p) => `
  <entry>
    <id>${escapeXml(p.link)}</id>
    <title>${escapeXml(titleOf(p.text))}</title>
    <link rel="alternate" href="${escapeXml(p.link)}"/>
    <updated>${escapeXml(p.created_at)}</updated>
    <author><name>@${escapeXml(username)}</name></author>
    <content type="html">${escapeXml(contentHtml(p))}</content>
  </entry>`).join('');

  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${escapeXml(profile)}</id>
  <title>@${escapeXml(username)} on X</title>
  <link rel="alternate" href="${escapeXml(profile)}"/>
  <link rel="self" href="${escapeXml(selfUrl)}"/>
  <updated>${escapeXml(updated)}</updated>${entries}
</feed>
`;
}
