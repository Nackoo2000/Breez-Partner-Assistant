export function buildTelegramLink(chatId, messageId, topicId) {
  if (!String(chatId).startsWith('-100')) return null;
  const channelId = String(chatId).slice(4);
  let url = `tg://privatepost?channel=${channelId}&post=${messageId}`;
  if (topicId && String(topicId) !== '0') url += `&thread=${topicId}`;
  return url;
}
