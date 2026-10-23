/**
 * Notification Service: Telegram Bot & WhatsApp
 */

/**
 * Format message for Telegram / WhatsApp
 */
function formatMessage(type, data) {
  const currency = '₦';
  const formattedAmount = (data.amount || 0).toLocaleString();

  if (type === 'BEAUTY_BOOKING') {
    return `
✨ <b>NEW APPOINTMENT BOOKED!</b> ✨
━━━━━━━━━━━━━━━━━━━━
💇 <b>Service:</b> ${data.serviceName}
📅 <b>Date:</b> ${data.date}
⏰ <b>Time Slot:</b> ${data.timeSlot}
👤 <b>Stylist/Tech:</b> ${data.stylist || 'Any'}
━━━━━━━━━━━━━━━━━━━━
<b>Customer Details:</b>
• <b>Name:</b> ${data.customerName}
• <b>Phone:</b> ${data.customerPhone}
• <b>Email:</b> ${data.customerEmail || 'N/A'}
• <b>Notes:</b> ${data.notes || 'None'}
━━━━━━━━━━━━━━━━━━━━
💰 <b>Deposit Paid:</b> ${currency}${formattedAmount} (${data.paymentStatus || 'PAID'})
🔖 <b>Ref:</b> <code>${data.reference || 'N/A'}</code>
`.trim();
  }

  // Food Order
  return `
🍔 <b>NEW FOOD ORDER RECEIVED!</b> 🍔
━━━━━━━━━━━━━━━━━━━━
📦 <b>Fulfillment:</b> ${data.fulfillmentType === 'PICKUP' ? '🏃 PICKUP AT STORE' : '🛵 DOORSTEP DELIVERY'}
📍 <b>Address:</b> ${data.address || 'In-store pickup'}
━━━━━━━━━━━━━━━━━━━━
🍽️ <b>Items:</b>
${data.itemsSummary || 'Standard order'}
━━━━━━━━━━━━━━━━━━━━
<b>Customer Details:</b>
• <b>Name:</b> ${data.customerName}
• <b>Phone:</b> ${data.customerPhone}
• <b>Special Instructions:</b> ${data.notes || 'None'}
━━━━━━━━━━━━━━━━━━━━
💰 <b>Total Paid:</b> ${currency}${formattedAmount} (${data.paymentStatus || 'PAID'})
🔖 <b>Ref:</b> <code>${data.reference || 'N/A'}</code>
`.trim();
}

/**
 * Send alert via Telegram Bot
 */
async function sendTelegramAlert(type, data) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log('[Notification] Telegram Bot Token/Chat ID not configured. Skipping live alert.');
    return { sent: false, reason: 'unconfigured' };
  }

  try {
    const text = formatMessage(type, data);
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML'
      })
    });

    const result = await response.json();
    if (!result.ok) {
      console.error('[Notification] Telegram API error:', result.description);
      return { sent: false, error: result.description };
    }

    console.log('[Notification] Telegram notification sent successfully.');
    return { sent: true };
  } catch (err) {
    console.error('[Notification] Telegram dispatch error:', err.message);
    return { sent: false, error: err.message };
  }
}

/**
 * Generate a prefilled WhatsApp link for instant contact
 */
function generateWhatsAppDeepLink(phone, message) {
  if (!phone) return null;
  const cleanPhone = phone.replace(/[^0-9]/g, '');
  return `https://wa.me/${cleanPhone}?text=${encodeURIComponent(message)}`;
}

/**
 * Dispatch WhatsApp notification (if gateway API configured)
 */
async function sendWhatsAppAlert(type, data) {
  const apiUrl = process.env.WHATSAPP_API_URL;
  const token = process.env.WHATSAPP_API_TOKEN;
  const vendorPhone = process.env.WHATSAPP_VENDOR_PHONE || data.customerPhone;

  // Plain text version for WhatsApp
  const plainText = formatMessage(type, data)
    .replace(/<[^>]*>/g, '')
    .replace(/━━━━━━━━━━━━━━━━━━━━/g, '-----------------');

  // If external gateway is configured
  if (apiUrl && token && vendorPhone) {
    try {
      await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          to: vendorPhone,
          message: plainText
        })
      });
      console.log('[Notification] WhatsApp alert sent via Gateway API.');
      return { sent: true, mode: 'api' };
    } catch (err) {
      console.error('[Notification] WhatsApp gateway error:', err.message);
    }
  }

  // Fallback: return ready-to-click deep link
  const deepLink = generateWhatsAppDeepLink(data.customerPhone || vendorPhone, plainText);
  return {
    sent: false,
    mode: 'deeplink',
    deepLink
  };
}

/**
 * Master notification dispatcher
 */
async function dispatchNotifications(type, data) {
  const [telegramResult, whatsappResult] = await Promise.all([
    sendTelegramAlert(type, data),
    sendWhatsAppAlert(type, data)
  ]);

  return {
    telegram: telegramResult,
    whatsapp: whatsappResult
  };
}

module.exports = {
  dispatchNotifications,
  generateWhatsAppDeepLink,
  formatMessage
};
