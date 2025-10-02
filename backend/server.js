// backend/server.js
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const nodemailer = require('nodemailer');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors()); // For prod restrict origin: app.use(cors({ origin: 'https://your-frontend.netlify.app' }))
app.use(bodyParser.json());

// Config
const EMAIL_PROVIDER = (process.env.EMAIL_PROVIDER || 'gmail').toLowerCase();
const RETURN_OTP_IN_RESPONSE = (process.env.RETURN_OTP_IN_RESPONSE || 'true').toLowerCase() === 'true';
const OTP_EXPIRY_SECONDS = parseInt(process.env.OTP_EXPIRY_SECONDS || '300', 10);

// In-memory OTP store (email -> { otp, expiresAt, timeoutId })
// NOTE: For production use Redis or DB for persistence across instances.
const otpStore = new Map();

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}
function setOtp(email, otp) {
  const existing = otpStore.get(email);
  if (existing && existing.timeoutId) clearTimeout(existing.timeoutId);
  const expiresAt = Date.now() + OTP_EXPIRY_SECONDS * 1000;
  const timeoutId = setTimeout(() => otpStore.delete(email), OTP_EXPIRY_SECONDS * 1000);
  otpStore.set(email, { otp, expiresAt, timeoutId });
}

// --- Transport / API helpers ---

// Nodemailer transporter for Gmail (used only when EMAIL_PROVIDER === 'gmail')
let transporter = null;
if (EMAIL_PROVIDER === 'gmail') {
  transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.EMAIL_PORT || '587', 10),
    secure: false,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    },
    tls: { rejectUnauthorized: false },
    connectionTimeout: 10000
  });

  transporter.verify((err, success) => {
    if (err) console.error('❌ SMTP verify failed:', err && err.message ? err.message : err);
    else console.log('✅ Gmail SMTP ready to send mails');
  });
} else {
  console.log('ℹ️ Email provider is not Gmail; expecting Brevo API for sending.');
}

// Brevo send via HTTP (used when EMAIL_PROVIDER === 'brevo')
// Expects BREVO_API_KEY env var
async function sendViaBrevo(toEmail, subject, htmlContent, textContent) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) throw new Error('BREVO_API_KEY not set');

  const payload = {
    sender: { name: process.env.SENDER_NAME || 'NoReply', email: process.env.SENDER_EMAIL || (process.env.EMAIL_USER || '') },
    to: [{ email: toEmail }],
    subject,
    htmlContent: htmlContent || textContent || `<p>${textContent}</p>`,
    textContent: textContent || htmlContent || ''
  };

  const res = await axios.post('https://api.brevo.com/v3/smtp/email', payload, {
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    timeout: 10000
  });
  return res.data;
}

// --- Routes ---

// Debug route: list current OTPs (for local dev only) — remove in production
app.get('/__debug/otps', (req, res) => {
  const out = {};
  otpStore.forEach((v, k) => {
    out[k] = { otp: RETURN_OTP_IN_RESPONSE ? v.otp : 'HIDDEN', expiresAt: v.expiresAt };
  });
  res.json(out);
});

// Send OTP
app.post('/send-otp', async (req, res) => {
  try {
    let { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email is required' });

    email = email.trim().toLowerCase();
    const otp = generateOTP();
    setOtp(email, otp);

    const subject = 'Your OTP Code';
    const text = `Your OTP is: ${otp}\nThis code will expire in ${Math.floor(OTP_EXPIRY_SECONDS/60)} minute(s).`;

    if (EMAIL_PROVIDER === 'gmail') {
      // Use Nodemailer / Gmail SMTP
      if (!transporter) throw new Error('SMTP transporter not initialized');
      const mailOptions = {
        from: process.env.EMAIL_USER,
        to: email,
        subject,
        text
      };

      transporter.sendMail(mailOptions, (err, info) => {
        if (err) {
          console.error('❌ sendMail error:', err);
          return res.status(500).json({ success: false, message: 'Failed to send OTP', error: err.message || err });
        }
        console.log(`✅ OTP sent via Gmail to ${email}`);
        const resp = { success: true, message: 'OTP sent successfully' };
        if (RETURN_OTP_IN_RESPONSE) resp.otp = otp;
        return res.json(resp);
      });

    } else if (EMAIL_PROVIDER === 'brevo') {
      // Use Brevo API
      try {
        await sendViaBrevo(email, subject, `<p>${text}</p>`, text);
        console.log(`✅ OTP sent via Brevo to ${email}`);
        const resp = { success: true, message: 'OTP sent successfully' };
        if (RETURN_OTP_IN_RESPONSE) resp.otp = otp;
        return res.json(resp);
      } catch (err) {
        console.error('❌ Brevo send error:', err.response?.data || err.message || err);
        return res.status(500).json({ success: false, message: 'Failed to send OTP', error: err.response?.data || err.message || err });
      }
    } else {
      return res.status(500).json({ success: false, message: 'Unknown EMAIL_PROVIDER' });
    }
  } catch (error) {
    console.error('❌ Unexpected send-otp error:', error);
    return res.status(500).json({ success: false, message: 'Failed to send OTP', error: error.message || error });
  }
});

// Verify OTP
app.post('/verify-otp', (req, res) => {
  try {
    let { email, otp } = req.body;
    if (!email || !otp) return res.status(400).json({ success: false, message: 'Email & OTP required' });

    email = email.trim().toLowerCase();
    otp = otp.trim();

    const rec = otpStore.get(email);
    if (!rec) return res.status(400).json({ success: false, message: 'OTP not found or expired' });

    if (rec.otp === otp) {
      clearTimeout(rec.timeoutId);
      otpStore.delete(email);
      console.log(`✅ OTP verified for ${email}`);
      return res.json({ success: true, message: 'OTP verified successfully' });
    } else {
      console.log(`❌ Invalid OTP for ${email}`);
      return res.status(400).json({ success: false, message: 'Invalid OTP' });
    }
  } catch (error) {
    console.error('❌ Unexpected verify-otp error:', error);
    return res.status(500).json({ success: false, message: 'OTP verification failed', error: error.message || error });
  }
});

// Start
app.listen(PORT, () => {
  console.log(`🚀 OTP backend running on port ${PORT} — provider=${EMAIL_PROVIDER}`);
});
