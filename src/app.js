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

// Explicit clean routes for multi-page restaurant suite
app.get(['/', '/index', '/index.html'], (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));
app.get(['/menu', '/menu.html'], (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'menu.html')));
app.get(['/order', '/order.html'], (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'order.html')));
app.get(['/track', '/track.html'], (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'track.html')));
app.get(['/about', '/about.html'], (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'about.html')));
app.get(['/admin', '/admin.html'], (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin', 'index.html')));

// In-memory status map for tracking fallback
const activeOrderStatuses = new Map();

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
          vendor_name: 'CRAVERS GRILL & SMOKEHOUSE'
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
    system: 'Cravers Gourmet Food & Smokehouse Engine',
    timestamp: new Date().toISOString(),
    demoMode: IS_DEMO_MODE,
    hasGoogleSheetWebhook: !!process.env.GOOGLE_SHEET_WEBHOOK_URL,
    hasSupabase: !!process.env.SUPABASE_URL,
    hasTelegram: !!process.env.TELEGRAM_BOT_TOKEN
  });
});

// 2. Food & Treats Order Endpoint
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
      deliveryZone,
      notes,
      reference
    } = req.body;

    if (!customerName || !customerPhone || !items || !items.length) {
      return res.status(400).json({ error: 'Missing required order details or empty tray.' });
    }

    const itemsSummary = items
      .map(it => `• ${it.quantity}x ${it.name} ${it.extras ? `(${it.extras})` : ''} - ₦${(it.price * it.quantity).toLocaleString()}`)
      .join('\n');

    const finalRef = reference || `FOOD_${Date.now()}`;
    const securityPin = Math.floor(1000 + Math.random() * 9000).toString();
    const sealNumber = `SEAL-${Math.floor(1000 + Math.random() * 9000)}`;

    const orderPayload = {
      type: 'FOOD_ORDER',
      reference: finalRef,
      securityPin,
      sealNumber,
      riderName: 'Sunday Oladipo (Cravers Fleet #04)',
      riderPhone: '08149640122',
      riderBikePlate: 'OS-492-BKT (Bajaj Boxer 150)',
      customerName,
      customerPhone,
      customerEmail: customerEmail || '',
      fulfillmentType: fulfillmentType || 'DELIVERY',
      address: fulfillmentType === 'PICKUP' ? 'Store Pickup' : (address || 'Not provided'),
      deliveryZone: deliveryZone || 'Standard Zone',
      items,
      itemsSummary,
      subtotal: Number(subtotal) || Number(totalAmount),
      deliveryFee: Number(deliveryFee) || 0,
      amount: Number(totalAmount) || 0,
      paymentStatus: 'PAID',
      status: 'PREPARING', // Initial kitchen state
      notes: notes || '',
      createdAt: new Date().toISOString()
    };

    activeOrderStatuses.set(finalRef, {
      ...orderPayload,
      status: 'PREPARING',
      updatedAt: new Date().toISOString()
    });

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

// 3. Live Order & Delivery Route Tracking
app.get(['/api/orders/track/:ref', '/orders/track/:ref'], async (req, res) => {
  try {
    const { ref } = req.params;
    if (!ref) {
      return res.status(400).json({ error: 'Missing order reference' });
    }

    // 1. Check in-memory status
    if (activeOrderStatuses.has(ref)) {
      return res.json({
        success: true,
        order: activeOrderStatuses.get(ref)
      });
    }

    // 2. Check Supabase
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY;
    if (supabaseUrl && supabaseKey) {
      try {
        const queryUrl = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/food_orders?reference=eq.${encodeURIComponent(ref)}&select=*`;
        const sbRes = await fetch(queryUrl, {
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`
          }
        });
        if (sbRes.ok) {
          const rows = await sbRes.json();
          if (rows && rows.length > 0) {
            const r = rows[0];
            const fallbackPin = (Math.abs(ref.split('').reduce((acc, c) => acc + c.charCodeAt(0), 1000)) % 9000 + 1000).toString();
            const orderData = {
              reference: r.reference,
              securityPin: r.security_pin || fallbackPin,
              sealNumber: r.seal_number || `SEAL-${fallbackPin}`,
              riderName: r.rider_name || 'Sunday Oladipo (Cravers Fleet #04)',
              riderPhone: r.rider_phone || '08149640122',
              riderBikePlate: r.rider_bike_plate || 'OS-492-BKT (Bajaj Boxer 150)',
              customerName: r.customer_name,
              customerPhone: r.customer_phone,
              fulfillmentType: r.fulfillment_type,
              deliveryZone: r.delivery_zone || 'Designated Route Corridor',
              address: r.delivery_address,
              items: r.items,
              itemsSummary: r.items_summary,
              amount: r.total_amount,
              paymentStatus: r.payment_status,
              status: r.status || 'PREPARING',
              createdAt: r.created_at
            };
            activeOrderStatuses.set(ref, orderData);
            return res.json({ success: true, order: orderData });
          }
        }
      } catch (err) {
        console.warn('[Tracking Supabase]', err.message);
      }
    }

    // 3. Check local records
    const { orders } = getStoredRecords();
    const local = orders.find(o => o.reference === ref);
    if (local) {
      return res.json({
        success: true,
        order: {
          ...local,
          status: 'PREPARING'
        }
      });
    }

    // 4. Default / Simulated Live Demo Tracker (for testing any reference)
    const demoPin = (Math.abs(ref.split('').reduce((acc, c) => acc + c.charCodeAt(0), 1000)) % 9000 + 1000).toString();
    res.json({
      success: true,
      simulated: true,
      order: {
        reference: ref,
        securityPin: demoPin,
        sealNumber: `SEAL-${demoPin}`,
        customerName: 'Valued Food Lover',
        customerPhone: '08149640122',
        fulfillmentType: 'DELIVERY',
        address: 'Prime Commercial Hub, Osogbo',
        deliveryZone: 'Olaiya / Gbongan Road Route',
        items: [
          { name: 'Double Sausage Chicken Shawarma (Suya Hot)', quantity: 2, price: 4000 },
          { name: 'Signature Chapman Mocktail', quantity: 2, price: 1800 }
        ],
        amount: 11600,
        paymentStatus: 'PAID',
        status: 'DISPATCHED',
        riderName: 'Sunday Oladipo (Cravers Fleet #04)',
        riderPhone: '08149640122',
        riderBikePlate: 'OS-492-BKT (Bajaj Boxer 150)',
        estimatedMinutes: '12 - 18 mins',
        createdAt: new Date(Date.now() - 15 * 60 * 1000).toISOString()
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Vendor Status Update Endpoint (e.g. PREPARING -> DISPATCHED -> DELIVERED)
app.post(['/api/orders/status', '/orders/status'], async (req, res) => {
  try {
    const { reference, status } = req.body;
    if (!reference || !status) {
      return res.status(400).json({ error: 'Missing reference or status' });
    }

    const validStatuses = ['RECEIVED', 'PREPARING', 'DISPATCHED', 'DELIVERED'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    if (activeOrderStatuses.has(reference)) {
      const order = activeOrderStatuses.get(reference);
      order.status = status;
      order.updatedAt = new Date().toISOString();
      activeOrderStatuses.set(reference, order);
    }

    // Update in Supabase if available
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_ANON_KEY;
    if (supabaseUrl && supabaseKey) {
      try {
        const patchUrl = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/food_orders?reference=eq.${encodeURIComponent(reference)}`;
        await fetch(patchUrl, {
          method: 'PATCH',
          headers: {
            'apikey': supabaseKey,
            'Authorization': `Bearer ${supabaseKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ status })
        });
      } catch (e) {
        console.warn('[Status Patch Error]', e.message);
      }
    }

    res.json({ success: true, reference, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Paystack Transaction Initialize
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

// 6. Paystack Webhook
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
        status: 'PREPARING',
        notes: metadata.notes
      };

      activeOrderStatuses.set(data.reference, orderPayload);

      await Promise.all([
        syncToGoogleSheet(orderPayload),
        syncToSupabase(orderPayload),
        dispatchNotifications('FOOD_ORDER', metadata)
      ]);
    }
  }

  res.sendStatus(200);
});

// 7. Admin Data Records
app.get(['/api/records', '/records'], (req, res) => {
  const records = getStoredRecords();
  res.json(records);
});

module.exports = app;
