const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const admin = require("firebase-admin");
const path = require("path");
const axios = require("axios");

require("dotenv").config({ path: path.join(__dirname, ".env") });
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

/**
 * Decodes and parses the bulletproof Base64 Service Account string from Render
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

// ZenoPay Configurations pulled from environment
const ZENOPAY_API_KEY = String(process.env.ZENOPAY_API_KEY || "").trim();
const ZENOPAY_ACCOUNT_ID = String(process.env.ZENOPAY_ACCOUNT_ID || "").trim();
// ZENOPAY_WEBHOOK_SECRET is optional – not required for polling

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
    const idToken = String(match[1] || "").trim();
    if (!idToken) {
      return res.status(401).json({ status: "failed", message: "Missing Firebase auth token" });
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

// ------------------- FIXED ZENO PAY INTERFACES -------------------

/**
 * Endpoint to initiate payment with ZenoPay using the correct API.
 * Expects: { amount, phone, orderId, busId, travelDate, seats }
 */
app.post("/api/payments/initialize", authenticateAppUser, async (req, res) => {
  const { amount, phone, orderId, busId, travelDate, seats } = req.body;

  if (!amount || !phone || !orderId || !busId || !travelDate || !Array.isArray(seats) || seats.length === 0) {
    return res.status(400).json({ status: "error", message: "Missing required booking details" });
  }

  try {
    // Format phone number to Tanzanian international format (255XXXXXXXXX)
    let formattedPhone = phone.trim().replace(/^\+/, '');
    if (formattedPhone.startsWith('0')) {
      formattedPhone = '255' + formattedPhone.substring(1);
    }
    if (!formattedPhone.match(/^255[67]\d{8}$/)) {
      return res.status(400).json({ status: "error", message: "Invalid phone number format for Tanzania" });
    }

    // Correct ZenoPay push payload
    const zenoPayload = new URLSearchParams();
    zenoPayload.append('create_order', '1');
    zenoPayload.append('api_key', ZENOPAY_API_KEY);
    zenoPayload.append('account_id', ZENOPAY_ACCOUNT_ID);
    zenoPayload.append('amount', String(amount));
    zenoPayload.append('chat_id', formattedPhone);
    zenoPayload.append('status', 'payment');

    console.log(`[ZenoPay] Initializing payment for order ${orderId}, phone ${formattedPhone}, amount ${amount}`);

    const zenoResponse = await axios.post("https://zenoapi.com/api/payments", zenoPayload.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000
    });

    const zenoOrderId = zenoResponse.data?.order_id;
    if (!zenoOrderId) {
      throw new Error(`ZenoPay rejected: ${JSON.stringify(zenoResponse.data)}`);
    }

    // Store payment record with full booking details
    const pollDeadline = new Date(Date.now() + PAYMENT_POLL_TTL_SECONDS * 1000);
    await db.collection("payments").doc(orderId).set({
      userId: req.user.uid,
      orderId: orderId,
      zenoOrderId: zenoOrderId,
      amount: Number(amount),
      phone: formattedPhone,
      busId: busId,
      travelDate: travelDate,
      seats: seats,
      status: "pending",
      pollAttempts: 0,
      pollDeadline: admin.firestore.Timestamp.fromDate(pollDeadline),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Start immediate polling for this order (catches failures quickly)
    startImmediatePolling(orderId, zenoOrderId);

    return res.status(200).json({
      status: "pending",
      message: "USSD push sent. Please check your phone and enter PIN.",
      orderId: orderId,
      zenoOrderId: zenoOrderId
    });

  } catch (err) {
    console.error("❌ ZenoPay initialization error:", err.response?.data || err.message);
    return res.status(500).json({
      status: "failed",
      message: "Payment gateway error. Please try again."
    });
  }
});

/**
 * Immediately poll ZenoPay for a specific order every 5 seconds (max 12 attempts = 60 seconds)
 * to detect failures/cancellations and release seats.
 */
async function startImmediatePolling(orderId, zenoOrderId, attempt = 1) {
  const MAX_ATTEMPTS = 12;   // 12 * 5s = 60 seconds
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
      // Correct status check payload
      const checkPayload = new URLSearchParams();
      checkPayload.append('check_order', '1');
      checkPayload.append('api_key', ZENOPAY_API_KEY);
      checkPayload.append('order_id', zenoOrderId);

      const response = await axios.post("https://zenoapi.com/api/payments", checkPayload.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000
      });

      const remoteStatus = String(response.data?.payment_status || "").toLowerCase();
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
      // Retry on network error
      startImmediatePolling(orderId, zenoOrderId, attempt + 1);
    }
  }, DELAY_MS);
}

/**
 * Update seat reservation documents for a given orderId.
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
 * Periodic worker: checks pending payments using the same correct API.
 * Used as a fallback in case immediate polling missed something.
 */
async function checkZenoPayStatusAndUpdate(orderDoc) {
  const fresh = await orderDoc.ref.get();
  const paymentData = fresh.data();
  if (!paymentData) return null;

  const currentStatus = (paymentData.status || '').toString().toLowerCase();
  if (currentStatus !== 'pending') return currentStatus;

  // Check deadline
  try {
    const now = new Date();
    if (paymentData.pollDeadline && paymentData.pollDeadline.toDate && paymentData.pollDeadline.toDate() < now) {
      await fresh.ref.update({ status: 'failed', failReason: 'poll_timeout', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      await updateSeatReservationsForOrder(paymentData.orderId, 'cancelled');
      return 'failed';
    }
  } catch (e) { console.error('Deadline check error:', e); }

  // Query ZenoPay using correct endpoint
  try {
    const checkPayload = new URLSearchParams();
    checkPayload.append('check_order', '1');
    checkPayload.append('api_key', ZENOPAY_API_KEY);
    checkPayload.append('order_id', paymentData.zenoOrderId);

    const response = await axios.post("https://zenoapi.com/api/payments", checkPayload.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000,
    });

    const remoteStatus = String(response.data?.payment_status || "").toLowerCase();
    let computedStatus = 'pending';
    if (["success", "completed", "paid"].some(s => remoteStatus.includes(s))) computedStatus = 'completed';
    else if (["failed", "declined", "error", "cancelled", "expired"].some(s => remoteStatus.includes(s))) computedStatus = 'failed';

    // Re-fetch to avoid race
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

    // If still pending, check attempts exhaustion
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
    // Increment attempts and continue
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

    await updateSeatReservationsForOrder(orderId, 'cancelled');
    return res.status(200).json({ status: 'success', message: 'Order cancelled' });
  } catch (err) {
    console.error('❌ /api/cancel-order error:', err.message || err);
    return res.status(500).json({ status: 'error', message: 'Failed to cancel order' });
  }
});

/**
 * Polling Route: Client requests status (also used by Flutter)
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
 * Compatibility endpoint for legacy /zenopay-pay (used by some mobile clients)
 * Uses the same corrected API.
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
    if (formattedPhone.startsWith('0')) {
      formattedPhone = '255' + formattedPhone.substring(1);
    }

    const zenoPayload = new URLSearchParams();
    zenoPayload.append('create_order', '1');
    zenoPayload.append('api_key', ZENOPAY_API_KEY);
    zenoPayload.append('account_id', ZENOPAY_ACCOUNT_ID);
    zenoPayload.append('amount', String(amount));
    zenoPayload.append('chat_id', formattedPhone);
    zenoPayload.append('status', 'payment');

    const response = await axios.post("https://zenoapi.com/api/payments", zenoPayload.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const data = response.data || {};
    const zenoOrderId = data.order_id || appOrderId;

    const pollDeadline = new Date(Date.now() + PAYMENT_POLL_TTL_SECONDS * 1000);
    await db.collection('payments').doc(appOrderId).set({
      userId: req.user?.uid,
      orderId: appOrderId,
      zenoOrderId,
      amount: Number(amount),
      phone: formattedPhone,
      busId: busId,
      travelDate: travelDate,
      seats: seats,
      status: 'pending',
      pollAttempts: 0,
      pollDeadline: admin.firestore.Timestamp.fromDate(pollDeadline),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    startImmediatePolling(appOrderId, zenoOrderId);

    return res.status(200).json({
      status: 'pending',
      message: data.message || 'Request in progress. You will receive a callback shortly',
      orderId: appOrderId,
      zenoOrderId,
      raw: data,
    });
  } catch (error) {
    console.error('❌ ZenoPay proxy error (/zenopay-pay):', error.response?.data || error.message);
    return res.status(500).json({ status: 'error', message: 'Failed to contact ZenoPay gateway' });
  }
});

/**
 * Compatibility polling endpoint for /zenopay-status/:orderId
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
 * Webhook receiver (optional, may be used if ZenoPay supports callbacks)
 * Secured by query token if ZENOPAY_WEBHOOK_SECRET is set.
 */
app.post('/zenopay-webhook', async (req, res) => {
  const token = String(req.query.token || '').trim();
  const webhookSecret = String(process.env.ZENOPAY_WEBHOOK_SECRET || '').trim();
  if (webhookSecret && (!token || token !== webhookSecret)) {
    console.warn('⚠️ Zenopay webhook rejected: invalid token');
    return res.status(403).json({ status: 'error', message: 'Invalid webhook token' });
  }

  const body = req.body || {};
  const zenoOrderId = String(body.order_id || body.zenoOrderId || body.orderId || '').trim();
  const remoteStatusRaw = String(body.payment_status || body.status || body.result || '').toLowerCase();

  if (!zenoOrderId && !body.orderId) {
    console.warn('⚠️ Zenopay webhook missing order id');
    return res.status(400).json({ status: 'error', message: 'Missing order id' });
  }

  let computedStatus = 'pending';
  if (["completed", "success", "paid"].some(s => remoteStatusRaw.includes(s))) computedStatus = 'completed';
  else if (["failed", "declined", "error"].some(s => remoteStatusRaw.includes(s))) computedStatus = 'failed';
  else if (["cancelled", "expired"].some(s => remoteStatusRaw.includes(s))) computedStatus = 'cancelled';

  // Find payment doc by zenoOrderId or orderId
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
    console.warn('⚠️ Zenopay webhook: payment record not found');
    return res.status(200).json({ status: 'ignored', message: 'No matching payment record' });
  }

  const paymentData = paymentSnap.data() || {};
  const prior = (paymentData.status || '').toString().toLowerCase();
  if (prior === computedStatus) {
    return res.status(200).json({ status: 'ok', message: 'No change' });
  }

  await paymentSnap.ref.update({ status: computedStatus, updatedAt: admin.firestore.FieldValue.serverTimestamp() });

  if (computedStatus === 'completed') await updateSeatReservationsForOrder(paymentData.orderId, 'booked');
  else if (['failed', 'cancelled'].includes(computedStatus)) await updateSeatReservationsForOrder(paymentData.orderId, 'cancelled');

  return res.status(200).json({ status: 'ok', message: 'processed' });
});

// Health endpoint
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

// Payment polling worker configuration (fallback)
const PAYMENT_POLL_INTERVAL_SECONDS = Number(process.env.PAYMENT_POLL_INTERVAL_SECONDS || 20);
const PAYMENT_POLL_BATCH_SIZE = Number(process.env.PAYMENT_POLL_BATCH_SIZE || 100);

/**
 * Cleanup expired reserved seats
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

// Manual cleanup trigger
app.post('/api/_cleanup-reservations', authenticateAppUser, async (req, res) => {
  try {
    const count = await cleanupExpiredReservations();
    return res.status(200).json({ status: 'success', cleaned: count });
  } catch (err) {
    return res.status(500).json({ status: 'error', message: 'cleanup failed' });
  }
});

// Start periodic cleanup loop
setInterval(async () => {
  try {
    const cleaned = await cleanupExpiredReservations();
    if (cleaned > 0) console.log(`🧹 Periodic cleanup: ${cleaned} expired reservations cleared`);
  } catch (err) {
    console.error('❌ Periodic cleanup failed:', err.message || err);
  }
}, RESERVATION_CLEANUP_INTERVAL_SECONDS * 1000);

/**
 * Poll pending payments periodically (fallback for any order that wasn't caught by immediate polling)
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
        const last = data.lastPolledAt.toDate();
        const delta = (Date.now() - last.getTime()) / 1000;
        if (delta < PAYMENT_POLL_INTERVAL_SECONDS / 2) continue;
      }
      await checkZenoPayStatusAndUpdate(doc);
      processed++;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (processed > 0) console.log(`🕵️ Polling: processed ${processed} pending payments`);
    return processed;
  } catch (err) {
    console.error('❌ pollPendingPayments error:', err.message || err);
    return -1;
  }
}

// Periodic polling loop (fallback)
setInterval(async () => {
  try {
    await pollPendingPayments();
  } catch (err) {
    console.error('❌ periodic polling failed:', err.message || err);
  }
}, PAYMENT_POLL_INTERVAL_SECONDS * 1000);

// Manual poll trigger
app.post('/api/_poll-pending-payments', authenticateAppUser, async (req, res) => {
  try {
    const count = await pollPendingPayments();
    return res.status(200).json({ status: 'success', processed: count });
  } catch (err) {
    return res.status(500).json({ status: 'error', message: 'poll failed' });
  }
});

// Debug endpoint (disabled in production)
app.get('/_debug/zenopay', async (req, res) => {
  if (isProduction) {
    return res.status(403).json({ status: 'error', message: 'Debug endpoint disabled in production' });
  }
  const phone = String(req.query.phone || '').trim();
  const amount = String(req.query.amount || '').trim();
  if (!phone || !amount) {
    return res.status(400).json({ status: 'error', message: 'Provide phone and amount query params' });
  }
  try {
    let formattedPhone = phone.replace(/^\+/, '');
    if (formattedPhone.startsWith('0')) formattedPhone = '255' + formattedPhone.substring(1);
    const payload = new URLSearchParams();
    payload.append('create_order', '1');
    payload.append('api_key', ZENOPAY_API_KEY);
    payload.append('account_id', ZENOPAY_ACCOUNT_ID);
    payload.append('amount', amount);
    payload.append('chat_id', formattedPhone);
    payload.append('status', 'payment');
    const response = await axios.post("https://zenoapi.com/api/payments", payload.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000,
    });
    return res.status(200).json({ status: 'pending', raw: response.data });
  } catch (err) {
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

const PORT = process.env.PORT || 10000;
const HOST = process.env.HOST || "0.0.0.0";
app.listen(PORT, HOST, () => {
  console.log(`🚀 Server running on ${HOST}:${PORT}`);
});