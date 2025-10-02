const express = require("express");
const nodemailer = require("nodemailer");
const bodyParser = require("body-parser");
const cors = require("cors");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(bodyParser.json());

// Nodemailer transporter (Gmail SMTP)
const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 587, 
  secure: false, // TLS
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});


// OTP store (memory)
let otpStore = {};

// Generate OTP
function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// Send OTP
app.post("/send-otp", async (req, res) => {
    try {
        let { email } = req.body;
        if (!email) return res.status(400).json({ success: false, message: "Email is required" });

        email = email.trim().toLowerCase();
        const otp = generateOTP();
        otpStore[email] = otp;

        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: email,
            subject: "Your OTP Code",
            text: `Your OTP is: ${otp}`
        };

        await transporter.sendMail(mailOptions);
        console.log(`✅ OTP sent to ${email}: ${otp}`);
        res.json({ success: true, message: "OTP sent successfully!" });
    } catch (error) {
        console.error("❌ Error sending OTP:", error);
        res.status(500).json({ success: false, message: "Failed to send OTP" });
    }
});

// Verify OTP
app.post("/verify-otp", (req, res) => {
    try {
        let { email, otp } = req.body;
        if (!email || !otp) return res.status(400).json({ success: false, message: "Email & OTP required" });

        email = email.trim().toLowerCase();
        otp = otp.trim();

        if (otpStore[email] && otpStore[email] === otp) {
            delete otpStore[email];
            console.log(`✅ OTP verified for ${email}`);
            return res.json({ success: true, message: "OTP verified successfully!" });
        } else {
            console.log(`❌ Invalid OTP for ${email}`);
            return res.status(400).json({ success: false, message: "Invalid OTP" });
        }
    } catch (error) {
        return res.status(500).json({ success: false, message: "OTP verification failed" });
    }
});

app.listen(PORT, () => console.log(`🚀 Backend running on http://localhost:${PORT}`));
