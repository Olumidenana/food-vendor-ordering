const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

// On Vercel, persistent disk is read-only; use /tmp fallback
const LOCAL_STORE_PATH = process.env.VERCEL
  ? path.join('/tmp', 'records.json')
  : path.join(__dirname, '..', '..', 'data', 'records.json');

// In-memory cache fallback for serverless execution
let memoryStore = { bookings: [], orders: [] };

// Ensure data directory exists
function ensureLocalStore() {
  try {
    const dir = path.dirname(LOCAL_STORE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(LOCAL_STORE_PATH)) {
      fs.writeFileSync(LOCAL_STORE_PATH, JSON.stringify(memoryStore, null, 2));
    }
  } catch (err) {
    // If filesystem is restricted, rely on memoryStore
  }
}

/**
 * Save entry to local backup storage
 */
function saveLocalBackup(type, entry) {
  try {
    ensureLocalStore();
    if (type === 'BEAUTY_BOOKING') {
      memoryStore.bookings.unshift(entry);
    } else {
      memoryStore.orders.unshift(entry);
    }

    if (fs.existsSync(LOCAL_STORE_PATH)) {
      const raw = fs.readFileSync(LOCAL_STORE_PATH, 'utf-8');
      const store = JSON.parse(raw);
      if (type === 'BEAUTY_BOOKING') {
        store.bookings.unshift(entry);
      } else {
        store.orders.unshift(entry);
      }
      fs.writeFileSync(LOCAL_STORE_PATH, JSON.stringify(store, null, 2));
    }
  } catch (err) {
    console.warn('[Storage] Notice on local file write (using in-memory):', err.message);
  }
}

/**
 * Get all stored records (for admin dashboard)
 */
function getStoredRecords() {
  ensureLocalStore();
  try {
    if (fs.existsSync(LOCAL_STORE_PATH)) {
      const raw = fs.readFileSync(LOCAL_STORE_PATH, 'utf-8');
      const parsed = JSON.parse(raw);
      return {
        bookings: parsed.bookings && parsed.bookings.length ? parsed.bookings : memoryStore.bookings,
        orders: parsed.orders && parsed.orders.length ? parsed.orders : memoryStore.orders
      };
    }
  } catch (err) {
    // fallback to memoryStore
  }
  return memoryStore;
}

/**
 * Sync with Google Sheets
 */
async function syncToGoogleSheet(payload) {
  // Always save locally/in-memory first for reliability
  saveLocalBackup(payload.type, payload);

  const webhookUrl = process.env.GOOGLE_SHEET_WEBHOOK_URL;
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY;

  let sheetSynced = false;

  // 1. Try Apps Script Webhook
  if (webhookUrl && webhookUrl.startsWith('http')) {
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (response.ok) {
        console.log('[GoogleSheets] Successfully synced via Apps Script Webhook.');
        sheetSynced = true;
      } else {
        console.warn('[GoogleSheets] Webhook responded with status:', response.status);
      }
    } catch (err) {
      console.error('[GoogleSheets] Webhook error:', err.message);
    }
  }

  // 2. Try Google Sheets API with Service Account (if configured)
  if (!sheetSynced && sheetId && clientEmail && privateKey) {
    try {
      const auth = new google.auth.JWT({
        email: clientEmail,
        key: privateKey.replace(/\\n/g, '\n'),
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
      });

      const sheets = google.sheets({ version: 'v4', auth });
      const now = new Date().toISOString();

      let rowValues = [];
      if (payload.type === 'BEAUTY_BOOKING') {
        rowValues = [
          now,
          payload.reference || 'N/A',
          payload.customerName || '',
          payload.customerPhone || '',
          payload.serviceName || '',
          payload.stylist || 'Any',
          payload.date || '',
          payload.timeSlot || '',
          payload.amount || 0,
          payload.paymentStatus || 'PAID',
          payload.notes || ''
        ];
      } else {
        rowValues = [
          now,
          payload.reference || 'N/A',
          payload.customerName || '',
          payload.customerPhone || '',
          payload.fulfillmentType || 'DELIVERY',
          payload.address || 'Pickup',
          payload.itemsSummary || '',
          payload.amount || 0,
          payload.paymentStatus || 'PAID',
          payload.notes || ''
        ];
      }

      await sheets.spreadsheets.values.append({
        spreadsheetId: sheetId,
        range: 'A:Z',
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [rowValues]
        }
      });

      console.log('[GoogleSheets] Successfully appended row via official Sheets API.');
      sheetSynced = true;
    } catch (err) {
      console.error('[GoogleSheets] Sheets API error:', err.message);
    }
  }

  return {
    success: true,
    localSaved: true,
    sheetSynced
  };
}

module.exports = {
  syncToGoogleSheet,
  getStoredRecords
};
