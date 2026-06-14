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
const ZENOPAY_SECRET_KEY = String(process.env.ZENOPAY_SECRET_KEY || "").trim();
const ZENOPAY_WEBHOOK_SECRET = String(process.env.ZENOPAY_WEBHOOK_SECRET || "").trim();

// Payment polling configuration
const PAYMENT_POLL_TTL_SECONDS = Number(process.env.PAYMENT_POLL_TTL_SECONDS || 900); // 15 minutes default
const PAYMENT_MAX_POLL_ATTEMPTS = Number(process.env.PAYMENT_MAX_POLL_ATTEMPTS || 8);

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

// Reservation hold window (seconds) default 15 minutes
const RESERVATION_HOLD_SECONDS = Number(process.env.RESERVATION_HOLD_SECONDS || 900);

/**
 * Reserve seats atomically for a given bus and travel date.
 * Request body: { busId, travelDate (ISO date), seats: ["1","2"], orderId }
 */
app.post('/api/reserve-seats', authenticateAppUser, async (req, res) => {
  const { busId, travelDate, seats, orderId } = req.body || {};

  if (!busId || !travelDate || !Array.isArray(seats) || seats.length === 0 || !orderId) {
    return res.status(400).json({ status: 'error', message: 'Missing busId, travelDate, seats, or orderId' });
  }

  try {
    // Normalize date to yyyy-mm-dd
    const date = new Date(travelDate);
    if (isNaN(date.getTime())) {
      return res.status(400).json({ status: 'error', message: 'Invalid travelDate' });
    }
    const isoDate = date.toISOString().slice(0, 10);
    const reservedUntil = new Date(Date.now() + RESERVATION_HOLD_SECONDS * 1000);

    const seatRefs = seats.map(seat => db.collection('seat_reservations').doc(`${busId}_${isoDate}_${seat}`));

    await db.runTransaction(async (tx) => {
      // Validate availability
      for (let i = 0; i < seatRefs.length; i++) {
        const snap = await tx.get(seatRefs[i]);
        if (snap.exists) {
          const data = snap.data() || {};
          const status = (data.status || '').toString().toLowerCase();
          const until = data.reservedUntil ? data.reservedUntil.toDate() : null;
          if (status === 'booked') {
            throw new Error(`Seat ${seats[i]} already booked`);
          }
          if (status === 'reserved' && until && until > new Date()) {
            throw new Error(`Seat ${seats[i]} currently reserved`);
          }
        }
      }

      // Reserve seats
      for (let i = 0; i < seatRefs.length; i++) {
        tx.set(seatRefs[i], {
          busId,
          travelDate: isoDate,
          seatNumber: seats[i],
          orderId,
          userId: req.user.uid || null,
          status: 'reserved',
          reservedAt: admin.firestore.FieldValue.serverTimestamp(),
          reservedUntil: admin.firestore.Timestamp.fromDate(reservedUntil),
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      }
    });

    console.log(`[reserve-seats] reserved ${seats.length} seats for order=${orderId} bus=${busId} date=${isoDate} until=${reservedUntil.toISOString()}`);
    return res.status(200).json({ status: 'success', message: 'Seats reserved', reservedUntil: reservedUntil.toISOString() });
  } catch (err) {
    console.error('❌ Seat reservation error:', err.message || err);
    return res.status(409).json({ status: 'failed', message: err.message || 'Seat reservation failed' });
  }
});


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
    // Extract the actual token string from the regex capture group
    const idToken = String(match[1] || "").trim();
    if (!idToken) {
      return res.status(401).json({ status: "failed", message: "Missing Firebase auth token" });
    }

    // Debug: decode token payload (without verification) to inspect iat/exp
    try {
      const parts = idToken.split('.');
      if (parts.length === 3) {
        const payloadJson = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        const payload = JSON.parse(payloadJson);
        const iat = payload.iat;
        const exp = payload.exp;
        console.log(`🔐 ID token debug: iat=${new Date(iat * 1000).toISOString()} exp=${new Date(exp * 1000).toISOString()} now=${new Date().toISOString()}`);
      } else {
        console.log('🔐 ID token debug: unexpected token format');
      }
    } catch (dbgErr) {
      console.log('🔐 ID token debug parse failed:', dbgErr.message);
    }

    req.user = await admin.auth().verifyIdToken(idToken);
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
      const pollDeadline = new Date(Date.now() + PAYMENT_POLL_TTL_SECONDS * 1000);
      await db.collection("payments").doc(orderId).set({
        userId: req.user.uid,
        orderId: orderId,
        zenoOrderId: zenoOrderId,
        amount: amount,
        phone: phone,
        status: "pending",
        pollAttempts: 0,
        pollDeadline: admin.firestore.Timestamp.fromDate(pollDeadline),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // IMPORTANT: creation of a ZenoPay order does not mean the payment
      // has been completed. Return a pending payment status so the client
      // waits for a webhook/callback or polling to mark the payment completed.
      return res.status(200).json({
        status: "pending",
        message: data.message || "Request in progress. You will receive a callback shortly",
        orderId: orderId,
        zenoOrderId: zenoOrderId,
        raw: data,
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
  // Refresh the snapshot to ensure we act on the latest state
  const fresh = await orderDoc.ref.get();
  const paymentData = fresh.data();
  if (!paymentData) return null;

  const currentStatus = (paymentData.status || '').toString().toLowerCase();
  if (currentStatus !== 'pending') {
    // No work to do if someone already cancelled or completed the order
    return currentStatus;
  }

  // If we've passed the polling deadline, mark failed (timeout)
  try {
    const now = new Date();
    if (paymentData.pollDeadline && paymentData.pollDeadline.toDate && paymentData.pollDeadline.toDate() < now) {
      await fresh.ref.update({
        status: 'failed',
        failReason: 'poll_timeout',
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      try { await updateSeatReservationsForOrder(paymentData.orderId, 'cancelled'); } catch (e) { console.error('❌ update seats after timeout failed', e); }
      return 'failed';
    }
  } catch (e) {
    console.error('❌ Poll-deadline check failed:', e.message || e);
  }

  // Query remote gateway for authoritative status
  try {
    const payload = new URLSearchParams({
      check_status: "1",
      order_id: paymentData.zenoOrderId,
      account_id: ZENOPAY_ACCOUNT_ID
    });

    const response = await axios.post(String(process.env.ZENOPAY_BASE_URL || 'https://zenoapi.com'), payload.toString(), {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "x-api-key": ZENOPAY_API_KEY
      },
      timeout: 15000,
    });

    const remoteStatus = String(response.data?.payment_status || response.data?.status || "").toLowerCase();
    let computedStatus = 'pending';
    if (["completed", "success", "paid"].some(s => remoteStatus.includes(s))) computedStatus = 'completed';
    else if (["failed", "declined", "error"].some(s => remoteStatus.includes(s))) computedStatus = 'failed';
    else if (["cancelled", "expired"].some(s => remoteStatus.includes(s))) computedStatus = 'cancelled';

    // Re-fetch to make sure status wasn't changed while we queried remote
    const latest = await orderDoc.ref.get();
    const latestStatus = (latest.data()?.status || '').toString().toLowerCase();
    if (latestStatus !== 'pending') return latestStatus;

    // Prepare fields to update (increment attempts + timestamps)
    const updates = {
      lastPolledAt: admin.firestore.FieldValue.serverTimestamp(),
      pollAttempts: admin.firestore.FieldValue.increment(1),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (computedStatus !== 'pending') {
      updates.status = computedStatus;
    }

    await latest.ref.update(updates);

    // If we still have a pending after incrementing attempts, check attempts/deadline to possibly fail
    if (computedStatus === 'pending') {
      const post = await orderDoc.ref.get();
      const attempts = Number(post.data()?.pollAttempts || 0);
      const deadline = post.data()?.pollDeadline;
      if (attempts >= PAYMENT_MAX_POLL_ATTEMPTS || (deadline && deadline.toDate && deadline.toDate() < new Date())) {
        await post.ref.update({ status: 'failed', failReason: 'poll_exhausted', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        try { await updateSeatReservationsForOrder(paymentData.orderId, 'cancelled'); } catch (e) { console.error('❌ update seats after exhausted failed', e); }
        return 'failed';
      }
      return 'pending';
    }

    // If status moved to a final state, reconcile reservations
    try {
      if (computedStatus === 'completed') {
        await updateSeatReservationsForOrder(paymentData.orderId, 'booked');
      } else if (['failed', 'cancelled'].includes(computedStatus)) {
        await updateSeatReservationsForOrder(paymentData.orderId, 'cancelled');
      }
    } catch (innerErr) {
      console.error('❌ Failed to update seat reservations for order:', innerErr.message || innerErr);
    }

    return computedStatus;
  } catch (err) {
    console.error("Status check operation failed:", err.message || err);
    // If status check failed, increment attempts and return current status
    try {
      await orderDoc.ref.update({ pollAttempts: admin.firestore.FieldValue.increment(1), lastPolledAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      const post = await orderDoc.ref.get();
      if (Number(post.data()?.pollAttempts || 0) >= PAYMENT_MAX_POLL_ATTEMPTS) {
        await post.ref.update({ status: 'failed', failReason: 'poll_exhausted', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        try { await updateSeatReservationsForOrder(paymentData.orderId, 'cancelled'); } catch (e) { console.error('❌ update seats after error exhausted failed', e); }
        return 'failed';
      }
    } catch (e) {
      console.error('❌ failed to increment pollAttempts after error:', e.message || e);
    }
    return paymentData.status;
  }
}

/**
 * Update seat reservation docs for an orderId
 * newStatus: 'booked' or 'cancelled'
 */
async function updateSeatReservationsForOrder(orderId, newStatus) {
  if (!orderId) return;
  const snaps = await db.collection('seat_reservations').where('orderId', '==', orderId).get();
  if (snaps.empty) return;
  const batch = db.batch();
  snaps.forEach(doc => {
    const updates = {
      status: newStatus,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (newStatus === 'booked') {
      updates.bookedAt = admin.firestore.FieldValue.serverTimestamp();
    }
    batch.update(doc.ref, updates);
  });
  await batch.commit();
}

/**
 * Cancel an order server-side and release reservations
 * POST body: { orderId, reason }
 */
app.post('/api/cancel-order', authenticateAppUser, async (req, res) => {
  const { orderId, reason } = req.body || {};
  if (!orderId) {
    return res.status(400).json({ status: 'error', message: 'Missing orderId' });
  }

  try {
    const orderRef = db.collection('payments').doc(orderId);
    const resTx = await db.runTransaction(async (tx) => {
      const doc = await tx.get(orderRef);
      if (!doc.exists) return { ok: false, message: 'Order not found' };
      const data = doc.data() || {};
      const status = (data.status || '').toLowerCase();
      if (status === 'completed') return { ok: false, message: 'Order already completed' };
      tx.update(orderRef, { status: 'cancelled', cancelReason: reason || 'user_cancelled', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      return { ok: true };
    });

    if (!resTx.ok) {
      return res.status(400).json({ status: 'failed', message: resTx.message });
    }

    // Update reservations
    try {
      await updateSeatReservationsForOrder(orderId, 'cancelled');
    } catch (err) {
      console.error('❌ Failed to release reservations on cancel:', err.message || err);
    }

    return res.status(200).json({ status: 'success', message: 'Order cancelled' });
  } catch (err) {
    console.error('❌ /api/cancel-order error:', err.message || err);
    return res.status(500).json({ status: 'error', message: 'Failed to cancel order' });
  }
});


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
    console.log('[zenopay-pay] request payload:', payload.toString());
    console.log('[zenopay-pay] gateway response:', JSON.stringify(data));
    const zenoOrderId = data.order_id || data.zenoOrderId || appOrderId;
    // Persist/merge a payments doc so other listeners can pick up the order.
    try {
      const pollDeadline = new Date(Date.now() + PAYMENT_POLL_TTL_SECONDS * 1000);
      await db.collection('payments').doc(appOrderId).set({
        userId: req.user?.uid,
        orderId: appOrderId,
        zenoOrderId,
        amount: Number(amount),
        phone,
        status: 'pending',
        pollAttempts: 0,
        pollDeadline: admin.firestore.Timestamp.fromDate(pollDeadline),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    } catch (e) {
      console.error('🔥 Firestore merge error (zenopay-pay):', e);
    }

    // Creation accepted — it's still a pending payment until ZenoPay confirms
    console.log(`[zenopay-pay] persisted payment doc for order=${appOrderId} zenoOrderId=${zenoOrderId}`);
    return res.status(200).json({
      status: 'pending',
      message: data.message || 'Request in progress. You will receive a callback shortly',
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


/**
 * Webhook receiver for ZenoPay to notify real-time payment status updates.
 * Secured by either a query `token` matching `ZENOPAY_WEBHOOK_SECRET` or
 * (optionally) by other verification methods if provided.
 * ZenoPay should be configured to POST to: /zenopay-webhook?token=YOUR_SECRET
 */
app.post('/zenopay-webhook', async (req, res) => {
  try {
    const token = String(req.query.token || '').trim();
    if (ZENOPAY_WEBHOOK_SECRET) {
      if (!token || token !== ZENOPAY_WEBHOOK_SECRET) {
        console.warn('⚠️ Zenopay webhook rejected: invalid token');
        return res.status(403).json({ status: 'error', message: 'Invalid webhook token' });
      }
    } else {
      console.warn('⚠️ Zenopay webhook received but no ZENOPAY_WEBHOOK_SECRET configured. Proceeding cautiously.');
    }

    const body = req.body || {};
    // Accept common fields used by ZenoPay integrations
    const zenoOrderId = String(body.order_id || body.zenoOrderId || body.orderId || '').trim();
    const remoteStatusRaw = String(body.payment_status || body.status || body.result || '').toLowerCase();

    if (!zenoOrderId && !body.orderId) {
      console.warn('⚠️ Zenopay webhook missing order id in payload', body);
      return res.status(400).json({ status: 'error', message: 'Missing order id' });
    }

    let computedStatus = 'pending';
    if (["completed", "success", "paid"].some(s => remoteStatusRaw.includes(s))) computedStatus = 'completed';
    else if (["failed", "declined", "error"].some(s => remoteStatusRaw.includes(s))) computedStatus = 'failed';
    else if (["cancelled", "expired"].some(s => remoteStatusRaw.includes(s))) computedStatus = 'cancelled';

    // Try to find the payment doc by zenoOrderId first, fallback to orderId
    let paymentSnap = null;
    if (zenoOrderId) {
      const q = await db.collection('payments').where('zenoOrderId', '==', zenoOrderId).limit(1).get();
      if (!q.empty) paymentSnap = q.docs[0];
    }

    if (!paymentSnap && body.orderId) {
      const doc = await db.collection('payments').doc(String(body.orderId)).get();
      if (doc.exists) paymentSnap = doc;
    }

    if (!paymentSnap) {
      console.warn('⚠️ Zenopay webhook: payment record not found for order', zenoOrderId || body.orderId);
      // Still acknowledge to avoid retries by gateway
      return res.status(200).json({ status: 'ignored', message: 'No matching payment record' });
    }

    const paymentData = paymentSnap.data() || {};
    const prior = (paymentData.status || '').toString().toLowerCase();
    if (prior === computedStatus) {
      return res.status(200).json({ status: 'ok', message: 'No change' });
    }

    // Update payment status and reconcile seats
    await paymentSnap.ref.update({ status: computedStatus, updatedAt: admin.firestore.FieldValue.serverTimestamp() });

    try {
      if (computedStatus === 'completed') await updateSeatReservationsForOrder(paymentData.orderId, 'booked');
      else if (['failed', 'cancelled'].includes(computedStatus)) await updateSeatReservationsForOrder(paymentData.orderId, 'cancelled');
    } catch (err) {
      console.error('❌ Zenopay webhook: failed to update seat reservations', err.message || err);
    }

    return res.status(200).json({ status: 'ok', message: 'processed' });
  } catch (err) {
    console.error('❌ /zenopay-webhook error:', err.message || err);
    return res.status(500).json({ status: 'error', message: 'webhook processing failed' });
  }
});

/**
 * Temporary debug endpoint (local-only) to directly call ZenoPay without Firebase auth.
 * Usage: GET /_debug/zenopay?phone=2557XXXXXXX&amount=45000
 * NOTE: Disabled in production for safety.
 */
app.get('/_debug/zenopay', async (req, res) => {
  if (isProduction) {
    return res.status(403).json({ status: 'error', message: 'Debug endpoint disabled in production' });
  }

  const phone = String(req.query.phone || req.query.buyer_phone || '').trim();
  const amount = String(req.query.amount || req.query.amt || '').trim();

  if (!phone || !amount) {
    return res.status(400).json({ status: 'error', message: 'Provide phone and amount query params' });
  }

  try {
    const payload = new URLSearchParams({
      create_order: '1',
      buyer_phone: phone,
      amount: amount,
      account_id: ZENOPAY_ACCOUNT_ID,
      buyer_email: 'debug@example.com',
      buyer_name: 'Debug User',
    });

    const response = await axios.post(String(process.env.ZENOPAY_BASE_URL || 'https://zenoapi.com'), payload.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'x-api-key': ZENOPAY_API_KEY,
      },
      timeout: 15000,
    });

    console.log('[_debug/zenopay] response:', response.data);
    return res.status(200).json({
      status: 'pending',
      message: response.data?.message || 'Request in progress. You will receive a callback shortly',
      raw: response.data,
    });
  } catch (err) {
    console.error('[_debug/zenopay] error:', err.response?.data || err.message || err);
    return res.status(500).json({ status: 'error', message: err.response?.data || err.message || 'gateway error' });
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

// Reservation cleanup configuration
const RESERVATION_CLEANUP_INTERVAL_SECONDS = Number(process.env.RESERVATION_CLEANUP_INTERVAL_SECONDS || 60);
const RESERVATION_CLEANUP_BATCH_SIZE = Number(process.env.RESERVATION_CLEANUP_BATCH_SIZE || 250);

// Polling worker configuration
const PAYMENT_POLL_INTERVAL_SECONDS = Number(process.env.PAYMENT_POLL_INTERVAL_SECONDS || 20);
const PAYMENT_POLL_BATCH_SIZE = Number(process.env.PAYMENT_POLL_BATCH_SIZE || 100);
const PAYMENT_POLL_CONCURRENCY = Number(process.env.PAYMENT_POLL_CONCURRENCY || 3);

/**
 * Cleanup expired reserved seats by marking them cancelled.
 * Returns the number of reservations cleaned, or -1 on error.
 */
async function cleanupExpiredReservations() {
  try {
    const now = admin.firestore.Timestamp.now();
    const q = db.collection('seat_reservations')
      .where('status', '==', 'reserved')
      .where('reservedUntil', '<=', now)
      .limit(RESERVATION_CLEANUP_BATCH_SIZE);

    const snap = await q.get();
    if (snap.empty) return 0;

    const batch = db.batch();
    snap.forEach(doc => {
      batch.update(doc.ref, {
        status: 'cancelled',
        cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    await batch.commit();
    console.log(`✅ cleanupExpiredReservations: released ${snap.size} reservations`);
    return snap.size;
  } catch (err) {
    console.error('❌ cleanupExpiredReservations error:', err.message || err);
    return -1;
  }
}

// Manual trigger endpoint (authenticated)
app.post('/api/_cleanup-reservations', authenticateAppUser, async (req, res) => {
  try {
    const count = await cleanupExpiredReservations();
    return res.status(200).json({ status: 'success', cleaned: count });
  } catch (err) {
    console.error('❌ manual cleanup error', err.message || err);
    return res.status(500).json({ status: 'error', message: 'cleanup failed' });
  }
});

// Start periodic cleanup loop
setInterval(async () => {
  try {
    const cleaned = await cleanupExpiredReservations();
    if (cleaned > 0) {
      console.log(`🧹 Periodic cleanup: ${cleaned} expired reservations cleared`);
    }
  } catch (err) {
    console.error('❌ Periodic cleanup failed:', err.message || err);
  }
}, RESERVATION_CLEANUP_INTERVAL_SECONDS * 1000);

/**
 * Poll pending payments and reconcile their status with ZenoPay.
 * This acts as a pseudo-webhook provider when actual webhook support is unavailable.
 */
async function pollPendingPayments() {
  try {
    const now = admin.firestore.Timestamp.now();
    const q = db.collection('payments')
      .where('status', '==', 'pending')
      .limit(PAYMENT_POLL_BATCH_SIZE);

    const snap = await q.get();
    if (snap.empty) return 0;

    let processed = 0;
    for (const doc of snap.docs) {
      const data = doc.data() || {};

      // Skip if pollAttempts already exhausted
      const attempts = Number(data.pollAttempts || 0);
      if (attempts >= PAYMENT_MAX_POLL_ATTEMPTS) {
        // mark failed if not already
        await doc.ref.update({ status: 'failed', failReason: 'poll_exhausted', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        try { await updateSeatReservationsForOrder(data.orderId, 'cancelled'); } catch (e) { console.error('❌ update seats after exhausted failed', e); }
        processed++;
        continue;
      }

      // If pollDeadline passed, mark failed
      if (data.pollDeadline && data.pollDeadline.toDate && data.pollDeadline.toDate() < new Date()) {
        await doc.ref.update({ status: 'failed', failReason: 'poll_timeout', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        try { await updateSeatReservationsForOrder(data.orderId, 'cancelled'); } catch (e) { console.error('❌ update seats after timeout failed', e); }
        processed++;
        continue;
      }

      // Respect a minimal backoff: if lastPolledAt is recent, skip this doc
      if (data.lastPolledAt && data.lastPolledAt.toDate) {
        const last = data.lastPolledAt.toDate();
        const delta = (Date.now() - last.getTime()) / 1000;
        if (delta < PAYMENT_POLL_INTERVAL_SECONDS / 2) {
          continue; // skip recently-polled docs
        }
      }

      // Perform the remote status check and reconciliation
      await checkZenoPayStatusAndUpdate(doc);
      processed++;

      // Gentle throttling to avoid hammering remote gateway
      await new Promise((r) => setTimeout(r, 100));
    }

    if (processed > 0) console.log(`🕵️ Polling: processed ${processed} pending payments`);
    return processed;
  } catch (err) {
    console.error('❌ pollPendingPayments error:', err.message || err);
    return -1;
  }
}

// Periodic polling loop
setInterval(async () => {
  try {
    await pollPendingPayments();
  } catch (err) {
    console.error('❌ periodic polling failed:', err.message || err);
  }
}, PAYMENT_POLL_INTERVAL_SECONDS * 1000);

// Manual trigger for admins/developers (authenticated)
app.post('/api/_poll-pending-payments', authenticateAppUser, async (req, res) => {
  try {
    const count = await pollPendingPayments();
    return res.status(200).json({ status: 'success', processed: count });
  } catch (err) {
    console.error('❌ manual poll trigger failed:', err.message || err);
    return res.status(500).json({ status: 'error', message: 'poll failed' });
  }
});

// Port Execution Configuration
const PORT = process.env.PORT || 10000;
// Bind host explicitly so devices on the LAN can reach the server during local testing
const HOST = process.env.HOST || "0.0.0.0";
app.listen(PORT, HOST, () => {
  console.log(`🚀 Server running smoothly on ${HOST}:${PORT}`);
});
