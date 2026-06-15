const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const path = require("path");
const axios = require("axios");

require("dotenv").config({ path: path.join(__dirname, ".env") });
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

/**
 * Decodes and parses the Base64 Service Account string from Render
 */
function parseFirebaseServiceAccount() {
  const encoded = String(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || "").trim();
  if (!encoded) return null;

  try {
    const raw = Buffer.from(encoded, "base64").toString("utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.private_key === "string") {
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

// ZenoPay v2 Configuration
const ZENOPAY_API_KEY = String(process.env.ZENOPAY_API_KEY || "").trim();
const ZENOPAY_ACCOUNT_ID = String(process.env.ZENOPAY_ACCOUNT_ID || "").trim();
const ZENOPAY_WEBHOOK_SECRET = String(process.env.ZENOPAY_WEBHOOK_SECRET || "").trim();
const ZENOPAY_BASE_URL = "https://zenopaymobile.com/api";

// Payment polling configuration
const PAYMENT_POLL_TTL_SECONDS = Number(process.env.PAYMENT_POLL_TTL_SECONDS || 900);
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

// Reservation hold window (seconds)
const RESERVATION_HOLD_SECONDS = Number(process.env.RESERVATION_HOLD_SECONDS || 900);

/**
 * Reserve seats atomically
 */
app.post('/api/reserve-seats', authenticateAppUser, async (req, res) => {
  const { busId, travelDate, seats, orderId } = req.body || {};

  if (!busId || !travelDate || !Array.isArray(seats) || seats.length === 0 || !orderId) {
    return res.status(400).json({ status: 'error', message: 'Missing busId, travelDate, seats, or orderId' });
  }

  try {
    const date = new Date(travelDate);
    if (isNaN(date.getTime())) {
      return res.status(400).json({ status: 'error', message: 'Invalid travelDate' });
    }
    const isoDate = date.toISOString().slice(0, 10);
    const reservedUntil = new Date(Date.now() + RESERVATION_HOLD_SECONDS * 1000);

    const seatRefs = seats.map(seat => db.collection('seat_reservations').doc(`${busId}_${isoDate}_${seat}`));

    await db.runTransaction(async (tx) => {
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

    console.log(`[reserve-seats] reserved ${seats.length} seats for order=${orderId}`);
    return res.status(200).json({ status: 'success', message: 'Seats reserved', reservedUntil: reservedUntil.toISOString() });
  } catch (err) {
    console.error('❌ Seat reservation error:', err.message);
    return res.status(409).json({ status: 'failed', message: err.message || 'Seat reservation failed' });
  }
});

/**
 * Authenticate Firebase ID token
 */
async function authenticateAppUser(req, res, next) {
  const authHeader = String(req.get("authorization") || "").trim();
  const match = authHeader.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    return res.status(401).json({ status: "failed", message: "Missing Firebase auth token" });
  }

  try {
    const idToken = String(match[1] || "").trim();
    if (!idToken) {
      return res.status(401).json({ status: "failed", message: "Missing Firebase auth token" });
    }
    req.user = await admin.auth().verifyIdToken(idToken);
    next();
  } catch (error) {
    console.error("❌ Auth Verification Error:", error);
    return res.status(401).json({ status: "failed", message: "Invalid Firebase auth token" });
  }
}

// ------------------- ZENOPAY V2 INTEGRATION -------------------

/**
 * Initiate payment via ZenoPay Mobile Money Tanzania (v2)
 * Expects: { amount, phone, orderId, busId, travelDate, seats }
 */
app.post("/api/payments/initialize", authenticateAppUser, async (req, res) => {
  const { amount, phone, orderId, busId, travelDate, seats } = req.body;

  if (!amount || !phone || !orderId || !busId || !travelDate || !Array.isArray(seats) || seats.length === 0) {
    return res.status(400).json({ status: "error", message: "Missing required booking details" });
  }

  try {
    // Format phone number to Tanzanian international format
    let formattedPhone = phone.trim().replace(/^\+/, '');
    if (formattedPhone.startsWith('0')) {
      formattedPhone = '255' + formattedPhone.substring(1);
    }
    if (!formattedPhone.match(/^255[67]\d{8}$/)) {
      return res.status(400).json({ status: "error", message: "Invalid phone number format for Tanzania" });
    }

    // Build JSON payload for ZenoPay v2
    const payload = {
      order_id: orderId,
      buyer_email: req.user.email || "customer@example.com",
      buyer_name: req.user.name || "App Customer",
      buyer_phone: formattedPhone,
      amount: Number(amount),
      account_id: ZENOPAY_ACCOUNT_ID,   // may be required by ZenoPay
      webhook_url: `${req.protocol}://${req.get('host')}/zenopay-webhook?token=${ZENOPAY_WEBHOOK_SECRET || ''}`,
      metadata: { busId, travelDate, seats }
    };

    console.log(`[ZenoPay] Initializing order ${orderId} for ${formattedPhone}, amount ${amount}`);

    const response = await axios.post(`${ZENOPAY_BASE_URL}/mobile-money-tanzania`, payload, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ZENOPAY_API_KEY
      },
      timeout: 15000
    });

    const data = response.data;
    console.log('[ZenoPay] create order response:', JSON.stringify(data));

    // Expect { status: "success", order_id: "..." }
    if (data.status === "success" && data.order_id) {
      const zenoOrderId = data.order_id;

      const pollDeadline = new Date(Date.now() + PAYMENT_POLL_TTL_SECONDS * 1000);
      await db.collection("payments").doc(orderId).set({
        userId: req.user.uid,
        orderId,
        zenoOrderId,
        amount: Number(amount),
        phone: formattedPhone,
        busId,
        travelDate,
        seats,
        status: "pending",
        pollAttempts: 0,
        pollDeadline: admin.firestore.Timestamp.fromDate(pollDeadline),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

      startImmediatePolling(orderId, zenoOrderId);

      return res.status(200).json({
        status: "pending",
        message: "USSD push sent. Please check your phone and enter PIN.",
        orderId,
        zenoOrderId
      });
    }

    throw new Error(data.message || "ZenoPay order creation failed");
  } catch (error) {
    console.error("❌ ZenoPay initialization error:", error.response?.data || error.message);
    return res.status(500).json({
      status: "failed",
      message: "Payment gateway error. Please try again."
    });
  }
});

/**
 * Immediately poll ZenoPay order status every 5 seconds (max 60 seconds)
 */
async function startImmediatePolling(orderId, zenoOrderId, attempt = 1) {
  const MAX_ATTEMPTS = 12;
  const DELAY_MS = 5000;

  if (attempt > MAX_ATTEMPTS) {
    console.log(`[ImmediatePoll] Order ${orderId} timed out after ${MAX_ATTEMPTS} attempts.`);
    const orderRef = db.collection("payments").doc(orderId);
    const doc = await orderRef.get();
    if (doc.exists && doc.data().status === 'pending') {
      await orderRef.update({ status: 'failed', failReason: 'poll_timeout', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      await updateSeatReservationsForOrder(orderId, 'cancelled');
    }
    return;
  }

  setTimeout(async () => {
    try {
      // GET request to check order status
      const url = `${ZENOPAY_BASE_URL}/order-status?order_id=${zenoOrderId}`;
      const response = await axios.get(url, {
        headers: { 'x-api-key': ZENOPAY_API_KEY },
        timeout: 10000
      });

      const remoteStatus = String(response.data?.payment_status || response.data?.status || "").toLowerCase();
      console.log(`[ImmediatePoll ${attempt}] Order ${orderId} status: ${remoteStatus}`);

      let finalStatus = null;
      if (["success", "completed", "paid"].includes(remoteStatus)) finalStatus = "completed";
      else if (["failed", "declined", "cancelled", "expired", "error"].includes(remoteStatus)) finalStatus = "failed";

      if (finalStatus) {
        const orderRef = db.collection("payments").doc(orderId);
        await orderRef.update({ status: finalStatus, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        if (finalStatus === "completed") {
          await updateSeatReservationsForOrder(orderId, 'booked');
          console.log(`✅ Payment completed for order ${orderId}`);
        } else {
          await updateSeatReservationsForOrder(orderId, 'cancelled');
          console.log(`❌ Payment failed/cancelled for order ${orderId}`);
        }
        return;
      }

      // Still pending – continue polling
      startImmediatePolling(orderId, zenoOrderId, attempt + 1);
    } catch (err) {
      console.error(`[ImmediatePoll] Error checking status for order ${orderId}:`, err.message);
      startImmediatePolling(orderId, zenoOrderId, attempt + 1);
    }
  }, DELAY_MS);
}

/**
 * Update seat reservations for an order (booked or cancelled)
 */
async function updateSeatReservationsForOrder(orderId, newStatus) {
  if (!orderId) return;
  const snaps = await db.collection('seat_reservations').where('orderId', '==', orderId).get();
  if (snaps.empty) return;
  const batch = db.batch();
  snaps.forEach(doc => {
    const updates = { status: newStatus, updatedAt: admin.firestore.FieldValue.serverTimestamp() };
    if (newStatus === 'booked') updates.bookedAt = admin.firestore.FieldValue.serverTimestamp();
    batch.update(doc.ref, updates);
  });
  await batch.commit();
}

/**
 * Fallback periodic worker (every 20 seconds) to check pending payments
 * Uses same GET order-status endpoint.
 */
async function checkZenoPayStatusAndUpdate(orderDoc) {
  const fresh = await orderDoc.ref.get();
  const paymentData = fresh.data();
  if (!paymentData) return null;

  const currentStatus = (paymentData.status || '').toLowerCase();
  if (currentStatus !== 'pending') return currentStatus;

  // Deadline check
  try {
    const now = new Date();
    if (paymentData.pollDeadline && paymentData.pollDeadline.toDate && paymentData.pollDeadline.toDate() < now) {
      await fresh.ref.update({ status: 'failed', failReason: 'poll_timeout', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      await updateSeatReservationsForOrder(paymentData.orderId, 'cancelled');
      return 'failed';
    }
  } catch (e) { console.error('Deadline check error:', e); }

  try {
    const url = `${ZENOPAY_BASE_URL}/order-status?order_id=${paymentData.zenoOrderId}`;
    const response = await axios.get(url, {
      headers: { 'x-api-key': ZENOPAY_API_KEY },
      timeout: 15000
    });

    const remoteStatus = String(response.data?.payment_status || response.data?.status || "").toLowerCase();
    let computedStatus = 'pending';
    if (["success", "completed", "paid"].some(s => remoteStatus.includes(s))) computedStatus = 'completed';
    else if (["failed", "declined", "error", "cancelled", "expired"].some(s => remoteStatus.includes(s))) computedStatus = 'failed';

    const latest = await orderDoc.ref.get();
    if (latest.data()?.status !== 'pending') return latest.data().status;

    const updates = {
      lastPolledAt: admin.firestore.FieldValue.serverTimestamp(),
      pollAttempts: admin.firestore.FieldValue.increment(1),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (computedStatus !== 'pending') updates.status = computedStatus;

    await latest.ref.update(updates);

    if (computedStatus !== 'pending') {
      if (computedStatus === 'completed') {
        await updateSeatReservationsForOrder(paymentData.orderId, 'booked');
      } else {
        await updateSeatReservationsForOrder(paymentData.orderId, 'cancelled');
      }
      return computedStatus;
    }

    const attempts = Number(latest.data()?.pollAttempts || 0);
    const deadline = latest.data()?.pollDeadline;
    if (attempts >= PAYMENT_MAX_POLL_ATTEMPTS || (deadline && deadline.toDate && deadline.toDate() < new Date())) {
      await latest.ref.update({ status: 'failed', failReason: 'poll_exhausted', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      await updateSeatReservationsForOrder(paymentData.orderId, 'cancelled');
      return 'failed';
    }
    return 'pending';
  } catch (err) {
    console.error("Status check error:", err.message);
    await orderDoc.ref.update({ pollAttempts: admin.firestore.FieldValue.increment(1), lastPolledAt: admin.firestore.FieldValue.serverTimestamp() });
    const post = await orderDoc.ref.get();
    if (Number(post.data()?.pollAttempts || 0) >= PAYMENT_MAX_POLL_ATTEMPTS) {
      await post.ref.update({ status: 'failed', failReason: 'poll_exhausted', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      await updateSeatReservationsForOrder(paymentData.orderId, 'cancelled');
      return 'failed';
    }
    return paymentData.status;
  }
}

/**
 * Cancel order endpoint
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

    await updateSeatReservationsForOrder(orderId, 'cancelled');
    return res.status(200).json({ status: 'success', message: 'Order cancelled' });
  } catch (err) {
    console.error('❌ /api/cancel-order error:', err.message);
    return res.status(500).json({ status: 'error', message: 'Failed to cancel order' });
  }
});

/**
 * Polling route for clients (Flutter)
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

    return res.status(200).json({ status: "success", orderId, paymentStatus: currentStatus });
  } catch (error) {
    console.error("❌ Polling fetch error:", error);
    return res.status(500).json({ status: "error", message: "Failed to resolve payment status" });
  }
});

/**
 * Compatibility /zenopay-pay endpoint (JSON version)
 */
app.post('/zenopay-pay', authenticateAppUser, async (req, res) => {
  const body = req.body || {};
  const amount = String(body.amount || body.amount_text || '');
  const phone = String(body.buyer_phone || body.buyerPhone || body.phone || '');
  const appOrderId = String(body.app_order_id || body.orderId || body.order_id || `ZEN-${Date.now()}`);
  const busId = body.busId || '';
  const travelDate = body.travelDate || '';
  const seats = body.seats || [];

  if (!amount || !phone) {
    return res.status(400).json({ status: 'error', message: 'Missing amount or phone' });
  }

  try {
    let formattedPhone = phone.trim().replace(/^\+/, '');
    if (formattedPhone.startsWith('0')) formattedPhone = '255' + formattedPhone.substring(1);

    const payload = {
      order_id: appOrderId,
      buyer_phone: formattedPhone,
      amount: Number(amount),
      buyer_email: req.user?.email || 'customer@example.com',
      buyer_name: req.user?.name || 'App Customer',
      account_id: ZENOPAY_ACCOUNT_ID,
      webhook_url: `${req.protocol}://${req.get('host')}/zenopay-webhook?token=${ZENOPAY_WEBHOOK_SECRET || ''}`,
      metadata: { busId, travelDate, seats }
    };

    const response = await axios.post(`${ZENOPAY_BASE_URL}/mobile-money-tanzania`, payload, {
      headers: { 'Content-Type': 'application/json', 'x-api-key': ZENOPAY_API_KEY }
    });

    const data = response.data;
    const zenoOrderId = data.order_id || appOrderId;

    const pollDeadline = new Date(Date.now() + PAYMENT_POLL_TTL_SECONDS * 1000);
    await db.collection('payments').doc(appOrderId).set({
      userId: req.user?.uid,
      orderId: appOrderId,
      zenoOrderId,
      amount: Number(amount),
      phone: formattedPhone,
      busId,
      travelDate,
      seats,
      status: 'pending',
      pollAttempts: 0,
      pollDeadline: admin.firestore.Timestamp.fromDate(pollDeadline),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    startImmediatePolling(appOrderId, zenoOrderId);
    return res.status(200).json({ status: 'pending', message: data.message || 'Request in progress', orderId: appOrderId, zenoOrderId });
  } catch (error) {
    console.error('❌ /zenopay-pay error:', error.response?.data || error.message);
    return res.status(500).json({ status: 'error', message: 'Failed to contact ZenoPay gateway' });
  }
});

/**
 * Compatibility /zenopay-status/:orderId
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
    return res.status(200).json({ status: 'success', orderId, paymentStatus: currentStatus });
  } catch (error) {
    console.error('❌ /zenopay-status error:', error);
    return res.status(500).json({ status: 'error', message: 'Failed to resolve payment status' });
  }
});

/**
 * Webhook receiver (optional)
 */
app.post('/zenopay-webhook', async (req, res) => {
  const token = String(req.query.token || '').trim();
  if (ZENOPAY_WEBHOOK_SECRET && token !== ZENOPAY_WEBHOOK_SECRET) {
    console.warn('⚠️ Webhook rejected: invalid token');
    return res.status(403).json({ status: 'error', message: 'Invalid webhook token' });
  }

  const body = req.body || {};
  const zenoOrderId = String(body.order_id || body.zenoOrderId || '').trim();
  const remoteStatus = String(body.payment_status || body.status || '').toLowerCase();

  if (!zenoOrderId) {
    console.warn('⚠️ Webhook missing order_id');
    return res.status(400).json({ status: 'error', message: 'Missing order_id' });
  }

  let computedStatus = 'pending';
  if (["completed", "success", "paid"].includes(remoteStatus)) computedStatus = 'completed';
  else if (["failed", "declined", "error", "cancelled", "expired"].includes(remoteStatus)) computedStatus = 'failed';

  const q = await db.collection('payments').where('zenoOrderId', '==', zenoOrderId).limit(1).get();
  if (q.empty) {
    console.warn(`⚠️ Webhook: no payment record for order ${zenoOrderId}`);
    return res.status(200).json({ status: 'ignored' });
  }

  const paymentSnap = q.docs[0];
  const paymentData = paymentSnap.data();
  if (paymentData.status === computedStatus) {
    return res.status(200).json({ status: 'ok', message: 'No change' });
  }

  await paymentSnap.ref.update({ status: computedStatus, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
  if (computedStatus === 'completed') await updateSeatReservationsForOrder(paymentData.orderId, 'booked');
  else if (['failed', 'cancelled'].includes(computedStatus)) await updateSeatReservationsForOrder(paymentData.orderId, 'cancelled');

  return res.status(200).json({ status: 'ok', message: 'processed' });
});

// Health endpoint
app.get('/', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'online-booking-backend', timestamp: new Date().toISOString() });
});

// ---------- Reservation cleanup & periodic polling ----------
const RESERVATION_CLEANUP_INTERVAL_SECONDS = Number(process.env.RESERVATION_CLEANUP_INTERVAL_SECONDS || 60);
const RESERVATION_CLEANUP_BATCH_SIZE = Number(process.env.RESERVATION_CLEANUP_BATCH_SIZE || 250);
const PAYMENT_POLL_INTERVAL_SECONDS = Number(process.env.PAYMENT_POLL_INTERVAL_SECONDS || 20);
const PAYMENT_POLL_BATCH_SIZE = Number(process.env.PAYMENT_POLL_BATCH_SIZE || 100);

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
      batch.update(doc.ref, { status: 'cancelled', cancelledAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    });
    await batch.commit();
    console.log(`✅ Cleaned ${snap.size} expired reservations`);
    return snap.size;
  } catch (err) {
    console.error('❌ cleanupExpiredReservations error:', err.message);
    return -1;
  }
}

setInterval(async () => {
  try { await cleanupExpiredReservations(); } catch (err) { console.error('Periodic cleanup failed:', err.message); }
}, RESERVATION_CLEANUP_INTERVAL_SECONDS * 1000);

async function pollPendingPayments() {
  try {
    const q = db.collection('payments').where('status', '==', 'pending').limit(PAYMENT_POLL_BATCH_SIZE);
    const snap = await q.get();
    if (snap.empty) return 0;

    let processed = 0;
    for (const doc of snap.docs) {
      const data = doc.data();
      const attempts = Number(data.pollAttempts || 0);
      if (attempts >= PAYMENT_MAX_POLL_ATTEMPTS) {
        await doc.ref.update({ status: 'failed', failReason: 'poll_exhausted', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        await updateSeatReservationsForOrder(data.orderId, 'cancelled');
        processed++;
        continue;
      }
      if (data.pollDeadline && data.pollDeadline.toDate && data.pollDeadline.toDate() < new Date()) {
        await doc.ref.update({ status: 'failed', failReason: 'poll_timeout', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        await updateSeatReservationsForOrder(data.orderId, 'cancelled');
        processed++;
        continue;
      }
      if (data.lastPolledAt && data.lastPolledAt.toDate) {
        const delta = (Date.now() - data.lastPolledAt.toDate().getTime()) / 1000;
        if (delta < PAYMENT_POLL_INTERVAL_SECONDS / 2) continue;
      }
      await checkZenoPayStatusAndUpdate(doc);
      processed++;
      await new Promise(r => setTimeout(r, 100));
    }
    if (processed > 0) console.log(`🕵️ Polled ${processed} pending payments`);
    return processed;
  } catch (err) {
    console.error('❌ pollPendingPayments error:', err.message);
    return -1;
  }
}

setInterval(async () => {
  try { await pollPendingPayments(); } catch (err) { console.error('Periodic polling failed:', err.message); }
}, PAYMENT_POLL_INTERVAL_SECONDS * 1000);

// Manual triggers (for admin)
app.post('/api/_cleanup-reservations', authenticateAppUser, async (req, res) => {
  try { const count = await cleanupExpiredReservations(); res.json({ status: 'success', cleaned: count }); }
  catch (err) { res.status(500).json({ status: 'error', message: 'cleanup failed' }); }
});

app.post('/api/_poll-pending-payments', authenticateAppUser, async (req, res) => {
  try { const count = await pollPendingPayments(); res.json({ status: 'success', processed: count }); }
  catch (err) { res.status(500).json({ status: 'error', message: 'poll failed' }); }
});

// Start server
const PORT = process.env.PORT || 10000;
const HOST = process.env.HOST || "0.0.0.0";
app.listen(PORT, HOST, () => {
  console.log(`🚀 Server running on ${HOST}:${PORT}`);
});