const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();

// 1. CORS Configuration
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

// 2. Postgres Connection
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error("FATAL: DATABASE_URL is not set in .env");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false }
});

// Database Initialization
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
    process.exit(1);
  }
}

// 3. HEALTH CHECK
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected' });
  } catch {
    res.status(500).json({ status: 'error', db: 'disconnected' });
  }
});

// 4. USER REGISTRATION
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

    const result = await pool.query(insertQuery, [fullName || 'User', email, password]);

    if (result.rowCount === 0) {
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

// 5. PESAPAL V3 ORDER PROCESSOR (Route aligned with frontend)
app.post('/stkpush', async (req, res) => {
  const { phone, amount, email } = req.body;

  if (!amount) {
    return res.status(400).json({ success: false, message: "Amount is required" });
  }

  try {
    // A. Fetch Pesapal Authentication Token
    const authRes = await axios.post('https://pay.pesapal.com/v3/api/Auth/RequestToken', {
      consumer_key: process.env.PESAPAL_CONSUMER_KEY,
      consumer_secret: process.env.PESAPAL_CONSUMER_SECRET
    }, {
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
    });

    const token = authRes.data.token;

    // B. Submit Order to Pesapal
    const orderData = {
      id: `ORDER_${Date.now()}`,
      currency: "KES",
      amount: parseFloat(amount),
      description: "Account Deposit - TradersCheem",
      callback_url: "https://traderscheem.duckdns.org/trade.html",
      notification_id: process.env.PESAPAL_NOTIFICATION_ID,
      billing_address: {
        email_address: email || "trader@traderscheem.com",
        phone_number: phone || "",
        first_name: "Trader",
        last_name: "User"
      }
    };

    const orderRes = await axios.post('https://pay.pesapal.com/v3/api/Transactions/SubmitOrderRequest', orderData, {
      headers: { 
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });

    // Send iframe url back to frontend modal
    res.json({ 
      success: true, 
      redirect_url: orderRes.data.redirect_url,
      order_tracking_id: orderRes.data.order_tracking_id 
    });

  } catch (error) {
    console.error("Pesapal API Error:", error.response?.data || error.message);
    res.status(500).json({ 
      success: false, 
      message: "Failed to connect to Pesapal", 
      details: error.response?.data || error.message 
    });
  }
});

// 6. PESAPAL IPN CALLBACK
app.post('/callback', (req, res) => {
  console.log("Pesapal Callback received:", JSON.stringify(req.body));
  res.json({ status: "200", message: "Notification Received" });
});

// 7. BALANCE ENDPOINTS
app.post('/api/deposit/success', async (req, res) => {
  const { email, amount } = req.body;
  if (!email || !amount) return res.status(400).json({ error: "Email and amount are required" });

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

// 8. START EXPRESS SERVER
const PORT = process.env.PORT || 10000;

initDb().then(() => {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running and listening on port ${PORT}`);
  });
});
