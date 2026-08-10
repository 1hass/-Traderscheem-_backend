const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();

// 1. CORS - allow your frontend domain. Use * only for testing
app.use(cors({
  origin: '*', // change to 'https://traderscheem.duckdns.org' for production
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// 2. Postgres connection
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error("FATAL: DATABASE_URL is not set in.env");
  process.exit(1); // crash early so you know
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost')
   ? false
    : { rejectUnauthorized: false }
});

// Test DB on startup
async function initDb() {
  try {
    await pool.query('SELECT 1');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        full_name VARCHAR(255),
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255),
        balance NUMERIC(12, 2) DEFAULT 0.00,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log("Database connected & 'users' table ready!");
  } catch (err) {
    console.error("Database connection error:", err.message);
    process.exit(1); // stop server if DB is down
  }
}

// 3. HEALTH CHECK - so frontend knows if backend is up
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected' });
  } catch {
    res.status(500).json({ status: 'error', db: 'disconnected' });
  }
});

// 4. USER REGISTRATION ENDPOINT
app.post('/register', async (req, res) => {
  const { fullName, email, password } = req.body;

  if (!email ||!password) {
    return res.status(400).json({ success: false, message: "Email and password are required" });
  }

  try {
    const insertQuery = `
      INSERT INTO users (full_name, email, password, balance)
      VALUES ($1, $2, $3, 0.00)
      ON CONFLICT (email) DO NOTHING
      RETURNING id, full_name, email, balance;
    `;

    const result = await pool.query(insertQuery, [fullName || 'User', email, password]);

    if (result.rowCount === 0) {
      // email already exists
      return res.status(409).json({ success: false, message: "Email already registered" });
    }

    console.log(`User registered in DB: ${email}`);
    return res.status(201).json({
      success: true,
      message: "Account created successfully!",
      user: { fullName: fullName || 'User', email }
    });

  } catch (err) {
    console.error("Database issue during registration:", err.message);
    return res.status(500).json({
      success: false,
      message: "Server error. Please try again later."
    });
  }
});

// 5. DEPOSIT - M-PESA STK PUSH
app.post('/stkpush', async (req, res) => {
  const { phone, amount } = req.body;
  if (!phone ||!amount) return res.status(400).json({ success: false, message: "Phone and amount required" });

  const formattedPhone = phone.startsWith('0')? '254' + phone.slice(1) : phone;

  try {
    const auth = Buffer.from(`${process.env.CONSUMER_KEY}:${process.env.CONSUMER_SECRET}`).toString('base64');
    const tokenRes = await axios.get('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
      headers: { Authorization: `Basic ${auth}` }
    });
    const token = tokenRes.data.access_token;

    const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, -3);
    const password = Buffer.from(`${process.env.SHORTCODE}${process.env.PASSKEY}${timestamp}`).toString('base64');

    await axios.post('https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest', {
      BusinessShortCode: process.env.SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: amount,
      PartyA: formattedPhone,
      PartyB: process.env.SHORTCODE,
      PhoneNumber: formattedPhone,
      CallBackURL: `https://traderscheem.duckdns.org/callback`,
      AccountReference: "TradersCheem",
      TransactionDesc: "Deposit"
    }, {
      headers: { Authorization: `Bearer ${token}` }
    });

    res.json({ success: true, message: "STK Push sent. Check your phone for PIN" });
  } catch (error) {
    console.error("STK Push error:", error.response?.data || error.message);
    res.status(500).json({ success: false, error: error.response?.data || error.message });
  }
});

// 6. M-PESA CALLBACK
app.post('/callback', express.json(), (req, res) => {
  console.log("M-PESA Callback:", JSON.stringify(req.body));
  res.json({ ResultCode: 0, ResultDesc: "Accepted" });
});

// 7. BALANCE ENDPOINTS
app.post('/api/deposit/success', async (req, res) => {
  const { email, amount } = req.body;
  if (!email ||!amount) return res.status(400).json({ error: "Email and amount are required" });

  try {
    const KES_TO_USD_RATE = 130;
    const depositAmount = parseFloat((Number(amount) / KES_TO_USD_RATE).toFixed(4));

    const updateQuery = `
      UPDATE users SET balance = balance + $2 WHERE email = $1
      RETURNING balance;
    `;

    const result = await pool.query(updateQuery, [email, depositAmount]);
    if (result.rowCount === 0) return res.status(404).json({ error: "User not found" });

    res.json({ success: true, balance: result.rows[0].balance });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error updating balance" });
  }
});

app.get('/api/user/balance', async (req, res) => {
  const { email } = req.query;
  if (!email) return res.status(400).json({ error: "Email param required" });

  try {
    const result = await pool.query('SELECT balance FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.json({ balance: "0.00" });
    res.json({ balance: Number(result.rows[0].balance).toFixed(2) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});

const PORT = process.env.PORT || 10000;

// Start server only after DB is ready
initDb().then(() => {
  app.listen(PORT, '0.0.0.0', () => console.log(`Server listening on port ${PORT}`));
});
