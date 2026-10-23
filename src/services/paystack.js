const crypto = require('crypto');

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY || 'sk_test_demo_mode';
const IS_DEMO_MODE = !PAYSTACK_SECRET || PAYSTACK_SECRET.includes('demo');

/**
 * Initialize a Paystack transaction
 * @param {Object} params
 * @param {string} params.email
 * @param {number} params.amountInKobo (e.g. 500000 = 5,000 NGN)
 * @param {string} params.callbackUrl
 * @param {Object} params.metadata
 */
async function initializeTransaction({ email, amountInKobo, callbackUrl, metadata = {} }) {
  if (IS_DEMO_MODE) {
    const mockRef = `DEMO_REF_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    return {
      success: true,
      data: {
        authorization_url: `${callbackUrl || '/'}?reference=${mockRef}&status=success&simulated=true`,
        access_code: `mock_code_${Date.now()}`,
        reference: mockRef,
        isSimulated: true
      }
    };
  }

  const response = await fetch('https://api.paystack.co/transaction/initialize', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${PAYSTACK_SECRET}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      email,
      amount: amountInKobo,
      callback_url: callbackUrl,
      metadata
    })
  });

  const data = await response.json();
  if (!response.ok || !data.status) {
    throw new Error(data.message || 'Failed to initialize Paystack transaction');
  }

  return {
    success: true,
    data: data.data
  };
}

/**
 * Verify a transaction by reference
 * @param {string} reference
 */
async function verifyTransaction(reference) {
  if (IS_DEMO_MODE || reference.startsWith('DEMO_REF_')) {
    return {
      success: true,
      status: 'success',
      reference,
      amount: 500000,
      currency: 'NGN',
      isSimulated: true,
      paidAt: new Date().toISOString()
    };
  }

  const response = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${PAYSTACK_SECRET}`,
      'Content-Type': 'application/json'
    }
  });

  const data = await response.json();
  if (!response.ok || !data.status) {
    throw new Error(data.message || 'Payment verification failed');
  }

  return {
    success: data.data.status === 'success',
    status: data.data.status,
    reference: data.data.reference,
    amount: data.data.amount,
    currency: data.data.currency,
    customer: data.data.customer,
    metadata: data.data.metadata,
    paidAt: data.data.paid_at
  };
}

/**
 * Verify Webhook Signature from Paystack
 * @param {string|Buffer} rawBody
 * @param {string} signature
 */
function verifyWebhookSignature(rawBody, signature) {
  if (IS_DEMO_MODE) return true;
  const hash = crypto
    .createHmac('sha512', PAYSTACK_SECRET)
    .update(rawBody)
    .digest('hex');
  return hash === signature;
}

module.exports = {
  initializeTransaction,
  verifyTransaction,
  verifyWebhookSignature,
  IS_DEMO_MODE
};
