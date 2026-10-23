const app = require('./app');
const { IS_DEMO_MODE } = require('./services/paystack');

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🚀 Business Booking & Ordering Engine running on port ${PORT}`);
  console.log(`👉 Hub & Showroom:        http://localhost:${PORT}`);
  console.log(`👉 Beauty / Lash Portal:  http://localhost:${PORT}/beauty`);
  console.log(`👉 Food & Snacks Portal:  http://localhost:${PORT}/food`);
  console.log(`👉 Vendor Admin Portal:   http://localhost:${PORT}/admin`);
  console.log(`⚡ Demo Mode Active:      ${IS_DEMO_MODE ? 'YES (Simulated Paystack)' : 'NO (Live Keys)'}`);
  console.log(`=======================================================`);
});
