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

// 5. PESAPAL V3 ORDER PROCESSOR (ALL AFRICA REGIONAL MAPPING)
app.post('/stkpush', async (req, res) => {
  const { phone, amount, countryCode, email } = req.body;

  if (!amount || !phone) {
    return res.status(400).json({ success: false, message: "Amount and phone required" });
  }

  try {
    // Complete mapping for African Calling Codes to Local Currencies & ISO Codes
    const countryMap = {
      // East Africa
      '254': { currency: 'KES', iso: 'KE' }, // Kenya
      '255': { currency: 'TZS', iso: 'TZ' }, // Tanzania
      '256': { currency: 'UGX', iso: 'UG' }, // Uganda
      '250': { currency: 'RWF', iso: 'RW' }, // Rwanda
      '257': { currency: 'BIF', iso: 'BI' }, // Burundi
      '251': { currency: 'ETB', iso: 'ET' }, // Ethiopia
      '252': { currency: 'SOS', iso: 'SO' }, // Somalia
      '253': { currency: 'DJI', iso: 'DJ' }, // Djibouti
      '211': { currency: 'SSP', iso: 'SS' }, // South Sudan
      '269': { currency: 'KMF', iso: 'KM' }, // Comoros
      '230': { currency: 'MUR', iso: 'MU' }, // Mauritius
      '248': { currency: 'SCR', iso: 'SC' }, // Seychelles

      // West Africa
      '234': { currency: 'NGN', iso: 'NG' }, // Nigeria
      '233': { currency: 'GHS', iso: 'GH' }, // Ghana
      '221': { currency: 'XOF', iso: 'SN' }, // Senegal (CFA)
      '225': { currency: 'XOF', iso: 'CI' }, // Ivory Coast (CFA)
      '223': { currency: 'XOF', iso: 'ML' }, // Mali (CFA)
      '226': { currency: 'XOF', iso: 'BF' }, // Burkina Faso (CFA)
      '228': { currency: 'XOF', iso: 'TG' }, // Togo (CFA)
      '229': { currency: 'XOF', iso: 'BJ' }, // Benin (CFA)
      '224': { currency: 'GNF', iso: 'GN' }, // Guinea
      '231': { currency: 'LRD', iso: 'LR' }, // Liberia
      '232': { currency: 'SLE', iso: 'SL' }, // Sierra Leone
      '220': { currency: 'GMD', iso: 'GM' }, // Gambia
      '238': { currency: 'CVE', iso: 'CV' }, // Cape Verde
      '245': { currency: 'XOF', iso: 'GW' }, // Guinea-Bissau (CFA)

      // Southern Africa
      '27':  { currency: 'ZAR', iso: 'ZA' }, // South Africa
      '260': { currency: 'ZMW', iso: 'ZM' }, // Zambia
      '263': { currency: 'ZWG', iso: 'ZW' }, // Zimbabwe
      '265': { currency: 'MWK', iso: 'MW' }, // Malawi
      '258': { currency: 'MZN', iso: 'MZ' }, // Mozambique
      '267': { currency: 'BWP', iso: 'BW' }, // Botswana
      '264': { currency: 'NAD', iso: 'NA' }, // Namibia
      '266': { currency: 'LSL', iso: 'LS' }, // Lesotho
      '268': { currency: 'SZL', iso: 'SZ' }, // Eswatini
      '261': { currency: 'MGA', iso: 'MG' }, // Madagascar
      '244': { currency: 'AOA', iso: 'AO' }, // Angola

      // North Africa
      '20':  { currency: 'EGP', iso: 'EG' }, // Egypt
      '212': { currency: 'MAD', iso: 'MA' }, // Morocco
      '213': { currency: 'DZD', iso: 'DZ' }, // Algeria
      '216': { currency: 'TND', iso: 'TN' }, // Tunisia
      '218': { currency: 'LYD', iso: 'LY' }, // Libya
      '222': { currency: 'MRU', iso: 'MR' }, // Mauritania
      '249': { currency: 'SDG', iso: 'SD' }, // Sudan

      // Central Africa
      '237': { currency: 'XAF', iso: 'CM' }, // Cameroon (CFA)
      '241': { currency: 'XAF', iso: 'GA' }, // Gabon (CFA)
      '242': { currency: 'XAF', iso: 'CG' }, // Republic of the Congo (CFA)
      '243': { currency: 'CDF', iso: 'CD' }, // Democratic Republic of the Congo
      '236': { currency: 'XAF', iso: 'CF' }, // Central African Republic (CFA)
      '235': { currency: 'XAF', iso: 'TD' }, // Chad (CFA)
      '240': { currency: 'XAF', iso: 'GQ' }, // Equatorial Guinea (CFA)
      '239': { currency: 'STN', iso: 'ST' }  // São Tomé and Príncipe
    };

    // Default to USD for unlisted international numbers
    const selectedConfig = countryMap[countryCode] || { currency: 'USD', iso: 'US' };

    // Fetch Pesapal Authentication Token
    const authRes = await axios.post('https://pay.pesapal.com/v3/api/Auth/RequestToken', {
      consumer_key: process.env.PESAPAL_CONSUMER_KEY,
      consumer_secret: process.env.PESAPAL_CONSUMER_SECRET
    }, {
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }
    });

    const token = authRes.data.token;

    // Submit Order Payload
    const orderData = {
      id: `ORDER_${Date.now()}`,
      currency: selectedConfig.currency,
      amount: parseFloat(amount),
      description: "Account Deposit - TradersCheem",
      callback_url: "https://traderscheem.duckdns.org/trade.html",
      notification_id: process.env.PESAPAL_NOTIFICATION_ID,
      billing_address: {
        email_address: email || "trader@traderscheem.com",
        phone_number: phone,
        country_code: selectedConfig.iso,
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
