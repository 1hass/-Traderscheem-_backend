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
    // 1. Create table with full_name and password columns
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        full_name VARCHAR(255),
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255),
        balance NUMERIC(12, 2) DEFAULT 0.00
      );
    `);
    
    // 2. Add missing columns automatically if table already existed
    await pool.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name VARCHAR(255);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS password VARCHAR(255);
    `);
    
    console.log("Database connected & 'users' table ready!");
  } catch (err) {
    console.error("Database connection error:", err);
  }
}

initDb();

const PORT = process.env.PORT || 10000;

// USER REGISTRATION ENDPOINT
app.post('/register', async (req, res) => {
  const { fullName, email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ success: false, message: "Email and password are required" });
  }

  try {
    const insertQuery = `
      INSERT INTO users (full_name, email, password, balance)
      VALUES ($1, $2, $3, 0.00)
      ON CONFLICT (email) DO NOTHING
      RETURNING id, full_name, email, balance;
    `;

    const result = await pool.query(insertQuery, [fullName, email, password]);

    // If user already exists
    if (result.rows.length === 0) {
      return res.status(200).json({
        success: true,
        message: "Account already exists, logging in...",
        user: { fullName, email }
      });
    }

    console.log(`New user registered: ${email}`);
    res.status(200).json({
      success: true,
      message: "Account created successfully!",
      user: result.rows[0]
    });

  } catch (err) {
    console.error("Registration database error:", err);
    res.status(500).json({ success: false, message: "Server error creating account" });
  }
});

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

// Endpoint to update user balance with KES to USD conversion
app.post('/api/deposit/success', async (req, res) => {
  const { email, amount } = req.body;

  if (!email || !amount) {
    return res.status(400).json({ error: "Email and amount are required" });
  }

  try {
    const KES_TO_USD_RATE = 130; 
    const usdAmount = Number(amount) / KES_TO_USD_RATE;
    const depositAmount = parseFloat(usdAmount.toFixed(4));

    const updateQuery = `
      INSERT INTO users (email, balance)
      VALUES ($1, $2)
      ON CONFLICT (email)
      DO UPDATE SET balance = users.balance + EXCLUDED.balance
      RETURNING balance;
    `;

    const result = await pool.query(updateQuery, [email, depositAmount]);
    const newBalance = result.rows[0].balance;

    console.log(`Updated balance for ${email}: $${newBalance} (${amount} KES -> $${depositAmount} USD)`);
    res.json({ success: true, balance: newBalance });
  } catch (err) {
    console.error("Failed to update deposit balance:", err);
    res.status(500).json({ error: "Database error updating balance" });
  }
});

// Endpoint to retrieve a user's current balance for the frontend
app.get('/api/user/balance', async (req, res) => {
  const { email } = req.query;

  if (!email) {
    return res.status(400).json({ error: "Email query param is required" });
  }

  try {
    const result = await pool.query('SELECT balance FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.json({ balance: "0.00" });
    }
    res.json({ balance: Number(result.rows[0].balance).toFixed(2) });
  } catch (err) {
    console.error("Failed to fetch balance:", err);
    res.status(500).json({ error: "Database error" });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
