require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const { initializeTransaction, verifyTransaction, verifyWebhookSignature, IS_DEMO_MODE } = require('./services/paystack');
const { syncToGoogleSheet, getStoredRecords } = require('./services/googleSheets');
const { dispatchNotifications } = require('./services/notifications');

const app = express();

// Enable CORS
app.use(cors());

// Capture raw body for Paystack webhook signature verification
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

// Serve static UI templates and admin portal
app.use(express.static(path.join(__dirname, '..', 'public')));

// 1. Health Endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'online',
    timestamp: new Date().toISOString(),
    demoMode: IS_DEMO_MODE,
    hasGoogleSheetWebhook: !!process.env.GOOGLE_SHEET_WEBHOOK_URL,
    hasTelegram: !!process.env.TELEGRAM_BOT_TOKEN
  });
});

// 2. Availability Checker
app.get('/api/availability', (req, res) => {
  const { date, stylist } = req.query;
  const { bookings } = getStoredRecords();

  const bookedSlots = bookings
    .filter(b => b.date === date && (!stylist || b.stylist === stylist || b.stylist === 'Any'))
    .map(b => b.timeSlot);

  const defaultSlots = [
    '09:00 AM', '10:30 AM', '12:00 PM', 
    '01:30 PM', '03:00 PM', '04:30 PM', '06:00 PM'
  ];

  const slots = defaultSlots.map(time => ({
    time,
    available: !bookedSlots.includes(time)
  }));

  res.json({ date, slots });
});

// 3. Beauty / Lash Booking
app.post('/api/bookings/create', async (req, res) => {
  try {
    const {
      serviceName,
      stylist,
      date,
      timeSlot,
      customerName,
      customerPhone,
      customerEmail,
      depositAmount,
      notes,
      reference
    } = req.body;

    if (!customerName || !customerPhone || !serviceName || !date || !timeSlot) {
      return res.status(400).json({ error: 'Missing required booking fields.' });
    }

    const bookingPayload = {
      type: 'BEAUTY_BOOKING',
      reference: reference || `LASH_${Date.now()}`,
      serviceName,
      stylist: stylist || 'Any Stylist',
      date,
      timeSlot,
      customerName,
      customerPhone,
      customerEmail: customerEmail || '',
      amount: Number(depositAmount) || 5000,
      paymentStatus: 'PAID',
      notes: notes || '',
      createdAt: new Date().toISOString()
    };

    const sheetSync = await syncToGoogleSheet(bookingPayload);
    const notificationResult = await dispatchNotifications('BEAUTY_BOOKING', bookingPayload);

    res.json({
      success: true,
      message: 'Booking confirmed and processed.',
      booking: bookingPayload,
      sheetSync,
      notifications: notificationResult
    });
  } catch (error) {
    console.error('[API] Booking error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 4. Food & Treats Order
app.post('/api/orders/create', async (req, res) => {
  try {
    const {
      customerName,
      customerPhone,
      customerEmail,
      fulfillmentType,
      address,
      items,
      totalAmount,
      notes,
      reference
    } = req.body;

    if (!customerName || !customerPhone || !items || !items.length) {
      return res.status(400).json({ error: 'Missing required order fields or empty cart.' });
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
      amount: Number(totalAmount) || 0,
      paymentStatus: 'PAID',
      notes: notes || '',
      createdAt: new Date().toISOString()
    };

    const sheetSync = await syncToGoogleSheet(orderPayload);
    const notificationResult = await dispatchNotifications('FOOD_ORDER', orderPayload);

    res.json({
      success: true,
      message: 'Order placed and sent to kitchen.',
      order: orderPayload,
      sheetSync,
      notifications: notificationResult
    });
  } catch (error) {
    console.error('[API] Order error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 5. Paystack Initialize
app.post('/api/paystack/initialize', async (req, res) => {
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

// 6. Paystack Webhook
app.post('/api/paystack/webhook', async (req, res) => {
  const signature = req.headers['x-paystack-signature'];
  const isValid = verifyWebhookSignature(req.rawBody, signature);

  if (!isValid) {
    return res.status(401).send('Invalid webhook signature');
  }

  const event = req.body;
  if (event.event === 'charge.success') {
    const data = event.data;
    const metadata = data.metadata || {};

    if (metadata.orderType === 'BEAUTY_BOOKING') {
      await syncToGoogleSheet({
        type: 'BEAUTY_BOOKING',
        reference: data.reference,
        serviceName: metadata.serviceName,
        stylist: metadata.stylist,
        date: metadata.date,
        timeSlot: metadata.timeSlot,
        customerName: metadata.customerName,
        customerPhone: metadata.customerPhone,
        customerEmail: data.customer.email,
        amount: data.amount / 100,
        paymentStatus: 'PAID',
        notes: metadata.notes
      });
      await dispatchNotifications('BEAUTY_BOOKING', metadata);
    } else if (metadata.orderType === 'FOOD_ORDER') {
      await syncToGoogleSheet({
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
      });
      await dispatchNotifications('FOOD_ORDER', metadata);
    }
  }

  res.sendStatus(200);
});

// 7. Admin Data Records
app.get('/api/records', (req, res) => {
  const records = getStoredRecords();
  res.json(records);
});

module.exports = app;
