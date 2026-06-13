const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const admin = require("firebase-admin");
const path = require("path");
const axios = require("axios"); // Handles outbound ZenoPay API requests

require("dotenv").config({ path: path.join(__dirname, ".env") });
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

/**
 * Decodes and parses the bulletproof Base64 Service Account string from Render
 */
function parseFirebaseServiceAccount() {
  const encoded = String(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || "").trim();
  if (!encoded) return null;

  try {
    // Safely convert the base64 string back into readable JSON
    const raw = Buffer.from(encoded, "base64").toString("utf8");
    const parsed = JSON.parse(raw);

    if (typeof parsed.private_key === "string") {
      // Replaces literal escaped newlines with actual newline characters
      parsed.private_key = parsed.private_key.replace(/\\n/g, "\n");
    }
    return parsed;
  } catch (e) {
    console.error("❌ Failed to parse base64 service account string.");
    return null;
  }
}

// Initialize Firebase Admin SDK
const serviceAccount = parseFirebaseServiceAccount();

if (serviceAccount && serviceAccount.type === "service_account") {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
} else if (process.env.NODE_ENV === "production") {
  throw new Error("Missing or invalid FIREBASE_SERVICE_ACCOUNT_BASE64 string in Render.");
} else {
  try {
    admin.initializeApp();
  } catch (error) {
    console.log("Firebase Admin already initialized or missing local config");
  }
}

const db = admin.firestore();
const isProduction = process.env.NODE_ENV === "production";
const allowedOrigins = String(process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

// ZenoPay Configurations pulled from Render
const ZENOPAY_API_KEY = String(process.env.ZENOPAY_API_KEY || "").trim();
const ZENOPAY_ACCOUNT_ID = String(process.env.ZENOPAY_ACCOUNT_ID || "").trim();

const app = express();
app.disable("x-powered-by");

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }
      if (allowedOrigins.length === 0 && !isProduction) {
        callback(null, true);
        return;
      }
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      callback(new Error("Origin not allowed by CORS"));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/**
 * Authenticates users requesting endpoints using Firebase Auth ID Tokens
 */
async function authenticateAppUser(req, res, next) {
  const authHeader = String(req.get("authorization") || "").trim();
  const match = authHeader.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    return res.status(401).json({
      status: "failed",
      message: "Missing Firebase auth token",
    });
  }

  try {
    // Fixed: Correctly passes match to get the pure token string split out by regex
    req.user = await admin.auth().verifyIdToken(match);
    next();
  } catch (error) {
    console.error("❌ Auth Verification Error:", error);
    return res.status(401).json({
      status: "failed",
      message: "Invalid Firebase auth token",
    });
  }
}

// ------------------- ZENO PAY INTERFACES -------------------

/**
 * Endpoint to initiate payment tracking records and contact ZenoPay gateway
 */
app.post("/api/payments/initialize", authenticateAppUser, async (req, res) => {
  const { amount, phone, orderId } = req.body;

  if (!amount || !phone || !orderId) {
    return res.status(400).json({ status: "error", message: "Missing amount, phone, or orderId" });
  }

  try {
    const payload = new URLSearchParams({
      create_order: "1",
      buyer_email: req.user.email || "customer@example.com",
      buyer_name: req.user.name || "App Customer",
      buyer_phone: phone,
      amount: amount,
      account_id: ZENOPAY_ACCOUNT_ID
    });

    const response = await axios.post("https://zenoapi.com", payload.toString(), {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-api-key": ZENOPAY_API_KEY
      }
    });

    const data = response.data;

    if (data.status === "success" || data.order_id) {
      const zenoOrderId = data.order_id || orderId;

      // Track local ledger item marked pending initially
      await db.collection("payments").doc(orderId).set({
        userId: req.user.uid,
        orderId: orderId,
        zenoOrderId: zenoOrderId,
        amount: amount,
        phone: phone,
        status: "pending",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      return res.status(200).json({
        status: "success",
        message: "Payment initiated",
        orderId: orderId,
        zenoOrderId: zenoOrderId
      });
    }

    return res.status(400).json({ status: "failed", message: data.message || "Failed to initialize ZenoPay session" });

  } catch (error) {
    console.error("❌ ZenoPay Error:", error.response?.data || error.message);
    return res.status(500).json({ status: "error", message: "Internal gateway processing failure" });
  }
});

/**
 * Worker Function: Queries active status from ZenoPay to reconcile pending logs
 */
async function checkZenoPayStatusAndUpdate(orderDoc) {
  const paymentData = orderDoc.data();
  try {
    const payload = new URLSearchParams({
      check_status: "1",
      order_id: paymentData.zenoOrderId,
      account_id: ZENOPAY_ACCOUNT_ID
    });

    const response = await axios.post("https://zenoapi.com", payload.toString(), {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-api-key": ZENOPAY_API_KEY
      }
    });

    const remoteStatus = String(response.data?.payment_status || response.data?.status || "").toLowerCase();
    let computedStatus = "pending";

    if (["completed", "success", "paid"].some(s => remoteStatus.includes(s))) {
      computedStatus = "completed";
    } else if (["failed", "declined", "error"].some(s => remoteStatus.includes(s))) {
      computedStatus = "failed";
    } else if (["cancelled", "expired"].some(s => remoteStatus.includes(s))) {
      computedStatus = "cancelled";
    }

    if (computedStatus !== paymentData.status) {
      await orderDoc.ref.update({
        status: computedStatus,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return computedStatus;
    }

    return paymentData.status;
  } catch (err) {
    console.error("Status check operation failed:", err.message);
    return paymentData.status;
  }
}

/**
 * Polling Route: Client application requests state evaluation via intervals
 */
app.get("/api/payments/status/:orderId", authenticateAppUser, async (req, res) => {
  const { orderId } = req.params;

  try {
    const orderRef = db.collection("payments").doc(orderId);
    const doc = await orderRef.get();

    if (!doc.exists) {
      return res.status(404).json({ status: "error", message: "Order records not found" });
    }

    let currentStatus = doc.data().status;

    if (currentStatus === "pending") {
      currentStatus = await checkZenoPayStatusAndUpdate(doc);
    }

    return res.status(200).json({
      status: "success",
      orderId: orderId,
      paymentStatus: currentStatus
    });

  } catch (error) {
    console.error("❌ Polling fetch error:", error);
    return res.status(500).json({ status: "error", message: "Failed to resolve payment status" });
  }
});

/**
 * Compatibility endpoint used by legacy/mobile `PaymentService` code.
 * Accepts Zenopay-style payloads and proxies the create-order call to ZenoPay,
 * then persists a lightweight payments record (merge) and returns the gateway response.
 */
app.post('/zenopay-pay', authenticateAppUser, async (req, res) => {
  const body = req.body || {};

  const amount = String(body.amount || body.amount_text || '');
  const phone = String(body.buyer_phone || body.buyerPhone || body.phone || '');
  const appOrderId = String(body.app_order_id || body.orderId || body.order_id || `ZEN-${Date.now()}`);
  const buyerEmail = String(body.buyer_email || body.email || req.user?.email || 'customer@example.com');
  const buyerName = String(body.buyer_name || body.name || req.user?.name || 'App Customer');

  if (!amount || !phone) {
    return res.status(400).json({ status: 'error', message: 'Missing amount or phone' });
  }

  try {
    const payload = new URLSearchParams({
      create_order: '1',
      buyer_email: buyerEmail,
      buyer_name: buyerName,
      buyer_phone: phone,
      amount: amount,
      account_id: ZENOPAY_ACCOUNT_ID,
    });

    const response = await axios.post(String(process.env.ZENOPAY_BASE_URL || 'https://zenoapi.com'), payload.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'x-api-key': ZENOPAY_API_KEY,
      },
    });

    const data = response.data || {};
    const zenoOrderId = data.order_id || data.zenoOrderId || appOrderId;

    // Persist/merge a payments doc so other listeners can pick up the order.
    try {
      await db.collection('payments').doc(appOrderId).set({
        userId: req.user?.uid,
        orderId: appOrderId,
        zenoOrderId,
        amount: Number(amount),
        phone,
        status: 'pending',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    } catch (e) {
      console.error('🔥 Firestore merge error (zenopay-pay):', e);
    }

    return res.status(200).json({
      status: 'success',
      message: 'Payment initiated',
      orderId: appOrderId,
      zenoOrderId,
      raw: data,
    });
  } catch (error) {
    console.error('❌ ZenoPay proxy error (/zenopay-pay):', error.response?.data || error.message || error);
    return res.status(500).json({ status: 'error', message: 'Failed to contact ZenoPay gateway' });
  }
});

/**
 * Compatibility polling endpoint for PaymentService which expects `/zenopay-status/:orderId`.
 */
app.get('/zenopay-status/:orderId', authenticateAppUser, async (req, res) => {
  const { orderId } = req.params;
  try {
    const orderRef = db.collection('payments').doc(orderId);
    const doc = await orderRef.get();

    if (!doc.exists) {
      return res.status(404).json({ status: 'error', message: 'Order records not found' });
    }

    let currentStatus = doc.data().status;
    if (currentStatus === 'pending') {
      currentStatus = await checkZenoPayStatusAndUpdate(doc);
    }

    return res.status(200).json({ status: 'success', orderId: orderId, paymentStatus: currentStatus });
  } catch (error) {
    console.error('❌ /zenopay-status fetch error:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to resolve payment status' });
  }
});

// Lightweight health endpoint for uptime/health checks (Render uses this path)
app.get('/', (req, res) => {
  return res.status(200).json({
    status: 'ok',
    service: 'online-booking-backend',
    timestamp: new Date().toISOString(),
  });
});

// Port Execution Configuration
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server running smoothly on port ${PORT}`);
});
