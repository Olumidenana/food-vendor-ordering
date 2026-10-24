require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const { initializeTransaction, verifyTransaction, verifyWebhookSignature, IS_DEMO_MODE } = require('./services/paystack');
const { syncToGoogleSheet, getStoredRecords } = require('./services/googleSheets');
const { dispatchNotifications } = require('./services/notifications');

const app = express();

app.use(cors());

// Capture raw body for Paystack signature verification
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// Serve static assets
app.use(express.static(path.join(__dirname, '..', 'public')));

// Explicit clean routes
app.get(['/admin', '/admin.html'], (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'index.html'));
});

/**
 * Synchronize food order to Supabase table `food_orders`
 */
async function syncToSupabase(order) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;

  if (supabaseUrl && supabaseKey) {
    try {
      const url = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/food_orders`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'apikey': supabaseKey,
          'Authorization': `Bearer ${supabaseKey}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=representation'
        },
        body: JSON.stringify({
          reference: order.reference,
          customer_name: order.customerName,
          customer_phone: order.customerPhone,
          customer_email: order.customerEmail || '',
          fulfillment_type: order.fulfillmentType,
          delivery_address: order.address,
          items: order.items,
          items_summary: order.itemsSummary,
          subtotal: order.subtotal || order.amount,
          delivery_fee: order.deliveryFee || 0,
          total_amount: order.amount,
          payment_status: 'PAID',
          notes: order.notes || '',
          vendor_name: 'CRAVERS GRILL & SHAWARMA'
        })
      });

      if (!res.ok) {
        const errText = await res.text();
        console.warn('[Supabase Food Sync] Response error:', errText);
      } else {
        console.log('[Supabase Food Sync] Successfully stored order in PostgreSQL.');
      }
    } catch (err) {
      console.warn('[Supabase Food Sync] Network error:', err.message);
    }
  }
}

// 1. Health Endpoint
app.get(['/api/health', '/health'], (req, res) => {
  res.json({
    status: 'online',
    system: 'Cravers Food & Grill Engine',
    timestamp: new Date().toISOString(),
    demoMode: IS_DEMO_MODE,
    hasGoogleSheetWebhook: !!process.env.GOOGLE_SHEET_WEBHOOK_URL,
    hasSupabase: !!process.env.SUPABASE_URL,
    hasTelegram: !!process.env.TELEGRAM_BOT_TOKEN
  });
});

// 2. Food & Treats Order Endpoint (supports both /api/orders/create and /orders/create)
app.post(['/api/orders/create', '/orders/create'], async (req, res) => {
  try {
    const {
      customerName,
      customerPhone,
      customerEmail,
      fulfillmentType,
      address,
      items,
      subtotal,
      deliveryFee,
      totalAmount,
      notes,
      reference
    } = req.body;

    if (!customerName || !customerPhone || !items || !items.length) {
      return res.status(400).json({ error: 'Missing required order details or empty tray.' });
    }

    const itemsSummary = items
      .map(it => `• ${it.quantity}x ${it.name} ${it.extras ? `(${it.extras})` : ''} - ₦${(it.price * it.quantity).toLocaleString()}`)
      .join('\n');

    const orderPayload = {
      type: 'FOOD_ORDER',
      reference: reference || `FOOD_${Date.now()}`,
      customerName,
      customerPhone,
      customerEmail: customerEmail || '',
      fulfillmentType: fulfillmentType || 'DELIVERY',
      address: fulfillmentType === 'PICKUP' ? 'Store Pickup' : (address || 'Not provided'),
      items,
      itemsSummary,
      subtotal: Number(subtotal) || Number(totalAmount),
      deliveryFee: Number(deliveryFee) || 0,
      amount: Number(totalAmount) || 0,
      paymentStatus: 'PAID',
      notes: notes || '',
      createdAt: new Date().toISOString()
    };

    // Parallel sync to Google Sheets, Supabase, and Notifications
    const [sheetSync] = await Promise.all([
      syncToGoogleSheet(orderPayload),
      syncToSupabase(orderPayload),
      dispatchNotifications('FOOD_ORDER', orderPayload).catch(e => console.warn('[Notification Error]:', e.message))
    ]);

    res.json({
      success: true,
      message: 'Kitchen ticket generated and logged successfully.',
      order: orderPayload,
      sheetSync
    });
  } catch (error) {
    console.error('[API] Food Order error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 3. Paystack Transaction Initialize
app.post(['/api/paystack/initialize', '/paystack/initialize'], async (req, res) => {
  try {
    const { email, amount, metadata, callbackUrl } = req.body;
    const amountInKobo = Math.round(Number(amount) * 100);

    const initResult = await initializeTransaction({
      email,
      amountInKobo,
      metadata,
      callbackUrl
    });

    res.json(initResult);
  } catch (err) {
    console.error('[API] Paystack init error:', err);
    res.status(500).json({ error: err.message });
  }
});

// 4. Paystack Webhook
app.post(['/api/paystack/webhook', '/paystack/webhook'], async (req, res) => {
  const signature = req.headers['x-paystack-signature'];
  const isValid = verifyWebhookSignature(req.rawBody, signature);

  if (!isValid) {
    return res.status(401).send('Invalid webhook signature');
  }

  const event = req.body;
  if (event.event === 'charge.success') {
    const data = event.data;
    const metadata = data.metadata || {};

    if (metadata.orderType === 'FOOD_ORDER') {
      const orderPayload = {
        type: 'FOOD_ORDER',
        reference: data.reference,
        customerName: metadata.customerName,
        customerPhone: metadata.customerPhone,
        customerEmail: data.customer.email,
        fulfillmentType: metadata.fulfillmentType,
        address: metadata.address,
        itemsSummary: metadata.itemsSummary,
        amount: data.amount / 100,
        paymentStatus: 'PAID',
        notes: metadata.notes
      };

      await Promise.all([
        syncToGoogleSheet(orderPayload),
        syncToSupabase(orderPayload),
        dispatchNotifications('FOOD_ORDER', metadata)
      ]);
    }
  }

  res.sendStatus(200);
});

// 5. Admin Data Records
app.get(['/api/records', '/records'], (req, res) => {
  const records = getStoredRecords();
  res.json(records);
});

module.exports = app;
