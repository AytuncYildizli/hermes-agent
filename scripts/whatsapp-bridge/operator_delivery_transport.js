const MESSAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export function createBoundedMessageStore(limit = 512) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 4096) {
    throw new RangeError('message store limit must be between 1 and 4096');
  }
  const messages = new Map();

  function remember(message) {
    const id = message?.key?.id;
    if (typeof id !== 'string' || !id) return;
    messages.delete(id);
    messages.set(id, message);
    while (messages.size > limit) {
      messages.delete(messages.keys().next().value);
    }
  }

  function get(id) {
    if (typeof id !== 'string' || !messages.has(id)) return null;
    return messages.get(id);
  }

  return { get, remember };
}

export function isGovernedOperatorEcho(store, message) {
  if (!store || typeof store.confirmProviderEcho !== 'function') return false;
  const key = message?.key;
  if (!key || typeof key.id !== 'string' || !key.id) return false;
  return store.confirmProviderEcho({
    messageId: key.id,
    chatId: key.remoteJid,
    fromMe: key.fromMe,
  }) === true;
}

export function createOperatorMessageSender({
  messageStore,
  sendWithTimeout,
  trackSentMessageId,
}) {
  if (!messageStore || typeof messageStore.get !== 'function'
      || typeof messageStore.remember !== 'function'
      || typeof sendWithTimeout !== 'function'
      || typeof trackSentMessageId !== 'function') {
    throw new TypeError('operator message sender dependencies are invalid');
  }
  return async function sendOperatorMessage({
    chatId,
    replyTo,
    message,
    messageId,
  }) {
    if (typeof chatId !== 'string' || !chatId
        || typeof replyTo !== 'string' || !replyTo
        || typeof message !== 'string' || !message
        || typeof messageId !== 'string' || !MESSAGE_ID_RE.test(messageId)) {
      throw new TypeError('operator message request is invalid');
    }
    const quoted = messageStore.get(replyTo) || {
      key: {
        id: replyTo,
        remoteJid: chatId,
        fromMe: false,
      },
      message: { conversation: '' },
    };
    trackSentMessageId({
      key: { id: messageId, remoteJid: chatId, fromMe: true },
    });
    const sent = await sendWithTimeout(
      chatId,
      { text: message },
      { messageId, quoted },
    );
    trackSentMessageId(sent);
    messageStore.remember(sent);
    return sent;
  };
}
