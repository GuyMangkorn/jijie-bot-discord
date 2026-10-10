// Only the current message's invocation text is consumed; reply authors are metadata.
export function getJijiPrompt(message, botId, { replyAuthorId } = {}) {
  if (typeof message.content !== 'string') return null;
  let text = message.content.trim();
  const named = text.startsWith('จีจี้');
  if (named) text = text.slice('จีจี้'.length);
  const mentions = [`<@${botId}>`, `<@!${botId}>`];
  const mentioned = mentions.some(mention => text.includes(mention));
  if (!named && !mentioned && replyAuthorId !== botId) return null;
  for (const mention of mentions) text = text.split(mention).join('');
  return text.trim();
}
