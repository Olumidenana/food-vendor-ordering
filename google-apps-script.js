/**
 * GOOGLE APPS SCRIPT FOR BUSINESS ORDER & BOOKING SYNC
 * 
 * Instructions for Business Owner:
 * 1. Open Google Sheets (create a new sheet or use existing).
 * 2. Click "Extensions" > "Apps Script".
 * 3. Delete any default code and paste this entire file.
 * 4. Click "Deploy" (top right) > "New deployment".
 * 5. Select type: "Web app".
 *    - Description: "Booking System Receiver"
 *    - Execute as: "Me"
 *    - Who has access: "Anyone"
 * 6. Click "Deploy", authorize permissions, and copy the Web App URL.
 * 7. Paste that URL into your backend's GOOGLE_SHEET_WEBHOOK_URL.
 */

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    
    // Check if headers exist, if not, create them
    if (sheet.getLastRow() === 0) {
      if (data.type === 'BEAUTY_BOOKING') {
        sheet.appendRow([
          'Timestamp',
          'Reference',
          'Client Name',
          'Phone Number',
          'Service',
          'Stylist / Tech',
          'Appointment Date',
          'Time Slot',
          'Amount Paid (NGN)',
          'Payment Status',
          'Notes'
        ]);
        sheet.getRange(1, 1, 1, 11).setFontWeight('bold').setBackground('#FCE7F3');
      } else {
        // Food Order
        sheet.appendRow([
          'Timestamp',
          'Reference',
          'Customer Name',
          'Phone Number',
          'Fulfillment Type',
          'Delivery Address',
          'Order Items Summary',
          'Amount Paid (NGN)',
          'Payment Status',
          'Delivery Notes'
        ]);
        sheet.getRange(1, 1, 1, 10).setFontWeight('bold').setBackground('#FEF3C7');
      }
    }

    const now = Utilities.formatDate(new Date(), 'GMT+1', 'yyyy-MM-dd HH:mm:ss');

    if (data.type === 'BEAUTY_BOOKING') {
      sheet.appendRow([
        now,
        data.reference || 'N/A',
        data.customerName || '',
        data.customerPhone || '',
        data.serviceName || '',
        data.stylist || 'Any Stylist',
        data.date || '',
        data.timeSlot || '',
        data.amount || 0,
        data.paymentStatus || 'PAID',
        data.notes || ''
      ]);
    } else {
      // Food Order
      sheet.appendRow([
        now,
        data.reference || 'N/A',
        data.customerName || '',
        data.customerPhone || '',
        data.fulfillmentType || 'DELIVERY',
        data.address || 'Pickup at Store',
        data.itemsSummary || '',
        data.amount || 0,
        data.paymentStatus || 'PAID',
        data.notes || ''
      ]);
    }

    return ContentService.createTextOutput(JSON.stringify({
      status: 'success',
      message: 'Row added successfully'
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({
      status: 'error',
      message: error.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}
