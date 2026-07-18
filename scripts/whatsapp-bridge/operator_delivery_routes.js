import { OperatorReceiptError } from './operator_delivery_receipts.js';

function errorStatus(error) {
  if (!(error instanceof OperatorReceiptError)) return 500;
  if (error.code.includes('_store_') || error.code.includes('_confirmation_')) {
    return 500;
  }
  return 400;
}

function errorResponse(response, error) {
  const code = error instanceof OperatorReceiptError
    ? error.code
    : 'operator_delivery_internal_error';
  return response.status(errorStatus(error)).json({ error: code });
}

export function registerOperatorDeliveryRoutes({
  app,
  store,
  isConnected,
  sendOperatorMessage,
}) {
  if (!app || typeof app.post !== 'function'
      || !store || typeof store.begin !== 'function'
      || typeof store.receipt !== 'function'
      || typeof store.confirm !== 'function'
      || typeof isConnected !== 'function'
      || typeof sendOperatorMessage !== 'function') {
    throw new TypeError('operator delivery route dependencies are invalid');
  }

  app.post('/operator-receipt', (request, response) => {
    try {
      return response.json(store.receipt(request.body));
    } catch (error) {
      return errorResponse(response, error);
    }
  });

  app.post('/operator-send', async (request, response) => {
    if (!isConnected()) {
      return response.status(503).json({ error: 'operator_delivery_not_connected' });
    }
    let prepared;
    try {
      prepared = store.begin(request.body);
    } catch (error) {
      return errorResponse(response, error);
    }
    if (prepared.action === 'REPLAY') {
      return response.json(prepared.receipt);
    }
    if (prepared.action === 'CONFLICT' || prepared.action === 'AMBIGUOUS') {
      return response.status(409).json(prepared.receipt);
    }
    try {
      const sent = await sendOperatorMessage({
        chatId: request.body.chat_id,
        replyTo: request.body.reply_to,
        message: request.body.message,
        messageId: prepared.messageId,
      });
      const providerMessageId = sent?.key?.id;
      const receipt = store.confirm(
        request.body.effect_key_digest,
        providerMessageId,
      );
      return response.status(receipt.status === 'EXACT' ? 200 : 409).json(receipt);
    } catch (error) {
      if (error instanceof OperatorReceiptError) {
        return errorResponse(response, error);
      }
      return response.status(503).json({ error: 'operator_delivery_send_failed' });
    }
  });
}
