const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        balance NUMERIC(12, 2) DEFAULT 0.00
      );
    `);
    console.log("Database connected & 'users' table ready!");
  } catch (err) {
    console.error("Database connection error:", err);
  }
}

initDb();

const PORT = process.env.PORT || 10000;

// DEPOSIT - M-PESA STK PUSH
app.post('/stkpush', async (req, res) => {
  const { phone, amount } = req.body;
  
  // Format phone: 2547XXXXXXXX
  const formattedPhone = phone.startsWith('0') ? '254' + phone.slice(1) : phone;
  
  try {
    // 1. Get Access Token
    const auth = Buffer.from(
  `${process.env.CONSUMER_KEY}:${process.env.CONSUMER_SECRET}`
).toString('base64');
    const tokenRes = await axios.get('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
      headers: { Authorization: `Basic ${auth}` }
    });
    const token = tokenRes.data.access_token;

    // 2. STK Push
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, -3);
    const password = Buffer.from(
  `${process.env.SHORTCODE}${process.env.PASSKEY}${timestamp}`
).toString('base64');
    
    const stkRes = await axios.post('https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest', {
      BusinessShortCode: process.env.SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: amount,
      PartyA: formattedPhone,
      PartyB: process.env.SHORTCODE,
      PhoneNumber: formattedPhone,
      CallBackURL: "https://traderscheem.duckdns.org/callback",
      AccountReference: "TradersCheem",
      TransactionDesc: "Deposit"
    }, {
      headers: { Authorization: `Bearer ${token}` }
    });

    res.json({ success: true, message: "STK Push sent. Check your phone for PIN" });
  } catch (error) {
  console.error("Daraja Error Status:", error.response?.status);
console.error("Daraja Error Data:", error.response?.data);
console.error("Daraja Error Message:", error.message);

  res.status(500).json({
    success: false,
    error: error.response?.data || error.message
  });
  }
});
app.post('/callback', (req, res) => {
  console.log('M-Pesa callback:', req.body);
  res.json({
    ResultCode: 0,
    ResultDesc: "Accepted"
  });
});
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
