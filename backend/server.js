const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const admin = require("firebase-admin");
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

// 🔑 Initialize Firebase Admin
// You need to provide a service account key file
// const serviceAccount = require("./path-to-your-service-account-key.json");
// admin.initializeApp({
//   credential: admin.credential.cert(serviceAccount)
// });

// Or if using environment variables:
if (process.env.FIREBASE_CONFIG) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_CONFIG))
  });
} else {
  // Fallback for development (if already signed in via CLI)
  try {
    admin.initializeApp();
  } catch (e) {
    console.log("Firebase Admin already initialized or missing config");
  }
}

const db = admin.firestore();
const isProduction = process.env.NODE_ENV === "production";
const allowedOrigins = String(process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const webhookSecret = String(process.env.ZENOPAY_WEBHOOK_SECRET || "").trim();
const webhookTokenQueryName =
  String(process.env.ZENOPAY_WEBHOOK_TOKEN_QUERY || "token").trim() || "token";

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

function sanitizeReference(value, maxLen) {
  if (value === null || value === undefined) return null;
  const raw = String(value).replace(/\s+/g, " ").trim();
  if (!raw) return null;
  const cleaned = raw.replace(/[^A-Za-z0-9 \\-_.]/g, "");
  if (!cleaned) return null;
  return cleaned.slice(0, maxLen);
}

function firstString(source, keys) {
  if (!source || typeof source !== "object") return null;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function includesAny(value, needles) {
  return needles.some((needle) => value.includes(needle));
}

function maskPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length <= 4) return digits;
  return `${"*".repeat(Math.max(digits.length - 4, 0))}${digits.slice(-4)}`;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

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
    req.user = await admin.auth().verifyIdToken(match[1]);
    next();
  } catch (error) {
    console.error("❌ Auth Verification Error:", error);
    return res.status(401).json({
      status: "failed",
      message: "Invalid Firebase auth token",
    });
  }
}

function authenticateWebhook(req, res, next) {
  if (!webhookSecret) {
    if (isProduction) {
      return res.status(500).json({
        status: "failed",
        message: "Webhook secret is not configured",
      });
    }
    next();
    return;
  }

  const headerSecret = String(req.get("x-webhook-secret") || "").trim();
  const querySecret = String(req.query?.[webhookTokenQueryName] || "").trim();

  if (safeEqual(headerSecret, webhookSecret) || safeEqual(querySecret, webhookSecret)) {
    next();
    return;
  }

  return res.status(401).json({
    status: "failed",
    message: "Unauthorized webhook request",
  });
}

function normalizeZenoPaymentStatus(payload) {
  const source =
    payload && typeof payload === "object"
      ? payload
      : { raw: String(payload ?? "") };

  const nested =
    source.data && typeof source.data === "object" ? source.data : null;

  const paymentStatus =
    firstString(source, ["payment_status", "order_status"]) ||
    firstString(nested, ["payment_status", "order_status"]);

  const fallbackStatus =
    firstString(source, ["status", "state", "result", "message"]) ||
    firstString(nested, ["status", "state", "result", "message"]) ||
    (typeof source.raw === "string" ? source.raw : null) ||
    "";

  const paymentLower = String(paymentStatus || "").toLowerCase();
  const fallbackLower = String(fallbackStatus || "").toLowerCase();

  if (includesAny(paymentLower, ["completed", "success", "paid"])) {
    return {
      appStatus: "completed",
      providerStatus: paymentStatus || fallbackStatus || null,
    };
  }

  if (
    includesAny(paymentLower, [
      "cancelled",
      "canceled",
      "expired",
      "timeout",
      "timed_out",
    ])
  ) {
    return {
      appStatus: "cancelled",
      providerStatus: paymentStatus || fallbackStatus || null,
    };
  }

  if (includesAny(paymentLower, ["failed", "fail", "error", "declined"])) {
    return {
      appStatus: "failed",
      providerStatus: paymentStatus || fallbackStatus || null,
    };
  }

  if (
    includesAny(paymentLower, ["pending", "processing", "created", "queued"])
  ) {
    return {
      appStatus: "pending",
      providerStatus: paymentStatus || fallbackStatus || null,
    };
  }

  if (
    includesAny(fallbackLower, [
      "cancelled",
      "canceled",
      "expired",
      "timeout",
      "timed_out",
    ])
  ) {
    return {
      appStatus: "cancelled",
      providerStatus: paymentStatus || fallbackStatus || null,
    };
  }

  if (includesAny(fallbackLower, ["failed", "fail", "error", "declined"])) {
    return {
      appStatus: "failed",
      providerStatus: paymentStatus || fallbackStatus || null,
    };
  }

  if (includesAny(fallbackLower, ["completed", "paid"])) {
    return {
      appStatus: "completed",
      providerStatus: paymentStatus || fallbackStatus || null,
    };
  }

  if (
    includesAny(fallbackLower, [
      "pending",
      "processing",
      "created",
      "queued",
      "callback",
      "in progress",
      "waiting",
    ])
  ) {
    return {
      appStatus: "pending",
      providerStatus: paymentStatus || fallbackStatus || null,
    };
  }

  return {
    appStatus: "pending",
    providerStatus: paymentStatus || fallbackStatus || null,
  };
}

app.get("/", (req, res) => {
  res.send("Heches Bus Booking Backend with Zenopay is Running");
});

/**
 * Zenopay Payment Proxy
 * Avoids browser CORS issues by calling Zenopay from the server.
 */
app.post("/zenopay-pay", authenticateAppUser, async (req, res) => {
  try {
    const {
      buyer_email,
      buyer_name,
      buyer_phone,
      amount,
      app_order_id,
      payment_reference,
    } = req.body || {};

    console.log("🔵 /zenopay-pay fields:", {
      app_order_id,
      buyer_email,
      buyer_name,
      buyer_phone: maskPhone(buyer_phone),
      amount,
      payment_reference,
      uid: req.user.uid,
    });

    const normalizedOrderId = String(app_order_id || "").trim();
    const parsedAmount = Number(amount);

    if (
      !normalizedOrderId ||
      !buyer_email ||
      !buyer_name ||
      !buyer_phone ||
      !Number.isFinite(parsedAmount) ||
      parsedAmount <= 0
    ) {
      return res.status(400).json({
        status: "failed",
        message: "Missing or invalid payment fields",
      });
    }

    const apiKey = process.env.ZENOPAY_API_KEY;
    const accountId = process.env.ZENOPAY_ACCOUNT_ID;
    const secretKey = process.env.ZENOPAY_SECRET_KEY;
    const webhookUrl = String(process.env.ZENOPAY_WEBHOOK_URL || "").trim();
    const baseUrl = process.env.ZENOPAY_BASE_URL || "https://api.zeno.africa";
    const referenceField = process.env.ZENOPAY_REFERENCE_FIELD;
    const referenceMaxLen = Number.parseInt(
      process.env.ZENOPAY_REFERENCE_MAX_LEN || "40",
      10
    );

    if (!apiKey || !accountId) {
      return res.status(500).json({
        status: "failed",
        message: "ZENOPAY_API_KEY or ZENOPAY_ACCOUNT_ID not configured",
      });
    }

    const paymentRef = db.collection("payments").doc(normalizedOrderId);
    const paymentSnapshot = await paymentRef.get();
    if (!paymentSnapshot.exists) {
      return res.status(404).json({
        status: "failed",
        message: "Payment record not found",
      });
    }

    const paymentData = paymentSnapshot.data() || {};
    if (paymentData.userId !== req.user.uid) {
      return res.status(403).json({
        status: "failed",
        message: "You are not allowed to initiate this payment",
      });
    }

    if (Number(paymentData.amount || 0) !== parsedAmount) {
      return res.status(409).json({
        status: "failed",
        message: "Payment amount mismatch",
      });
    }

    const payload = new URLSearchParams({
      create_order: "1",
      buyer_email,
      buyer_name,
      buyer_phone,
      amount: parsedAmount.toFixed(0),
      account_id: accountId,
      api_key: apiKey,
    });

    if (secretKey) {
      payload.append("secret_key", secretKey);
    }

    if (webhookUrl && !webhookUrl.includes("your-public-url")) {
      payload.append("webhook_url", webhookUrl);
    }

    const sanitizedReference = sanitizeReference(
      payment_reference,
      Number.isFinite(referenceMaxLen) ? referenceMaxLen : 40
    );
    if (referenceField && sanitizedReference) {
      payload.append(referenceField, sanitizedReference);
    }

    const zenoUrl = baseUrl.endsWith("/")
      ? baseUrl.slice(0, -1)
      : baseUrl;
    const zenoResponse = await fetch(zenoUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: payload.toString(),
    });

    const raw = await zenoResponse.text();
    let data = raw;
    try {
      data = JSON.parse(raw);
    } catch (_) {
      // Non-JSON response; keep raw text.
    }

    return res.status(zenoResponse.status).json({
      status_code: zenoResponse.status,
      data,
      raw,
    });
  } catch (error) {
    console.error("❌ Zenopay Proxy Error:", error);
    return res.status(502).json({
      status: "failed",
      message: "Zenopay proxy error",
    });
  }
});

app.get("/zenopay-status/:orderId", authenticateAppUser, async (req, res) => {
  try {
    const requestedOrderId = String(req.params.orderId || "").trim();
    if (!requestedOrderId) {
      return res.status(400).json({
        status: "failed",
        message: "Missing orderId",
      });
    }

    const apiKey = process.env.ZENOPAY_API_KEY;
    const secretKey = process.env.ZENOPAY_SECRET_KEY;
    const baseUrl = process.env.ZENOPAY_BASE_URL || "https://api.zeno.africa";

    if (!apiKey) {
      return res.status(500).json({
        status: "failed",
        message: "ZENOPAY_API_KEY not configured",
      });
    }

    const paymentsRef = db.collection("payments");
    const refsByPath = new Map();
    let zenoOrderId = requestedOrderId;
    const requesterUid = req.user.uid;

    const directDoc = await paymentsRef.doc(requestedOrderId).get();
    if (directDoc.exists) {
      const paymentData = directDoc.data() || {};
      if (paymentData.userId !== requesterUid) {
        return res.status(404).json({
          status: "failed",
          message: "Payment not found",
        });
      }
      refsByPath.set(directDoc.ref.path, directDoc.ref);
      if (
        typeof paymentData.zenoOrderId === "string" &&
        paymentData.zenoOrderId.trim()
      ) {
        zenoOrderId = paymentData.zenoOrderId.trim();
      }
    }

    const linkedDocs = await paymentsRef.where("zenoOrderId", "==", zenoOrderId).get();
    linkedDocs.forEach((doc) => {
      const paymentData = doc.data() || {};
      if (paymentData.userId === requesterUid) {
        refsByPath.set(doc.ref.path, doc.ref);
      }
    });

    if (refsByPath.size === 0) {
      return res.status(404).json({
        status: "failed",
        message: "Payment not found",
      });
    }

    const payload = new URLSearchParams({
      check_status: "1",
      order_id: zenoOrderId,
      api_key: apiKey,
    });

    if (secretKey) {
      payload.append("secret_key", secretKey);
    }

    const zenoUrl = baseUrl.endsWith("/")
      ? `${baseUrl.slice(0, -1)}/order-status`
      : `${baseUrl}/order-status`;

    const zenoResponse = await fetch(zenoUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: payload.toString(),
    });

    const raw = await zenoResponse.text();
    let data = raw;
    try {
      data = JSON.parse(raw);
    } catch (_) {
      // Non-JSON response; keep raw text.
    }

    const { appStatus, providerStatus } = normalizeZenoPaymentStatus({
      data,
      raw,
    });

    if (refsByPath.size > 0) {
      const batch = db.batch();
      for (const ref of refsByPath.values()) {
        batch.set(
          ref,
          {
            status: appStatus,
            zenoOrderId,
            zenoPaymentStatus: providerStatus,
            lastStatusCheckAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            statusCheckRawData: typeof data === "string" ? { raw } : data,
          },
          { merge: true }
        );
      }
      await batch.commit();
    }

    return res.status(200).json({
      orderId: requestedOrderId,
      zenoOrderId,
      status: appStatus,
      payment_status: providerStatus,
      status_code: zenoResponse.status,
      data,
      raw,
    });
  } catch (error) {
    console.error("❌ Zenopay Status Check Error:", error);
    return res.status(502).json({
      status: "failed",
      message: "Zenopay status check error",
    });
  }
});

/**
 * Zenopay Webhook
 * Zenopay calls this URL when a payment status changes
 */
app.post("/zenopay-webhook", authenticateWebhook, async (req, res) => {
  console.log("🔵 Received Zenopay Webhook:", req.body);

  const { order_id, status, payment_status, transaction_id } = req.body;

  if (!order_id) {
    return res.status(400).send("Missing order_id");
  }

  try {
    const { appStatus, providerStatus } = normalizeZenoPaymentStatus({
      payment_status,
      status,
      raw: JSON.stringify(req.body),
    });

    // Update Firestore (match on zenoOrderId first, fallback to doc id)
    const paymentsRef = db.collection('payments');
    const matching = await paymentsRef.where('zenoOrderId', '==', order_id).get();

    if (matching.empty) {
      const paymentRef = paymentsRef.doc(order_id);
      await paymentRef.update({
        status: appStatus,
        zenoTransactionId: transaction_id || null,
        zenoPaymentStatus: providerStatus,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        webhookRawData: req.body
      });
    } else {
      const batch = db.batch();
      matching.forEach((doc) => {
        batch.update(doc.ref, {
          status: appStatus,
          zenoTransactionId: transaction_id || null,
          zenoPaymentStatus: providerStatus,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          webhookRawData: req.body
        });
      });
      await batch.commit();
    }

    console.log(`✅ Payment ${order_id} updated to ${appStatus}`);
    res.status(200).send("OK");
  } catch (error) {
    console.error("❌ Webhook Error:", error);
    res.status(500).send("Internal Server Error");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
