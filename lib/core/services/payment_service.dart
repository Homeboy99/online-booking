import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/foundation.dart';

enum PaymentInitStatus { success, pending, failed }

class PaymentInitResult {
  final PaymentInitStatus status;
  final String? message;
  final String? orderId;

  const PaymentInitResult({
    required this.status,
    this.message,
    this.orderId,
  });

  bool get isSuccess => status == PaymentInitStatus.success;
  bool get isPending => status == PaymentInitStatus.pending;
}

class PaymentService {
  static const String _configuredBackendBaseUrl =
      String.fromEnvironment('BACKEND_URL', defaultValue: '');

  static String get backendBaseUrl {
    final configured = _normalizeBaseUrl(_configuredBackendBaseUrl);
    if (configured.isNotEmpty) {
      return configured;
    }

    if (!kDebugMode) {
      return '';
    }

    if (kIsWeb) {
      return 'http://localhost:3000';
    }

    switch (defaultTargetPlatform) {
      case TargetPlatform.android:
        return 'http://10.0.2.2:3000';
      case TargetPlatform.iOS:
      case TargetPlatform.macOS:
      case TargetPlatform.windows:
      case TargetPlatform.linux:
        return 'http://localhost:3000';
      default:
        return '';
    }
  }

  final Dio _dio = Dio();
  final FirebaseFirestore _firestore = FirebaseFirestore.instance;
  final FirebaseAuth _auth = FirebaseAuth.instance;

  /// Initiate Payment using Zenopay
  Future<PaymentInitResult> initiateZenopayPayment({
    required String phoneNumber,
    required double amount,
    required String email,
    required String fullName,
    required String orderId,
    String? paymentReference,
  }) async {
    // 🇹🇿 Format phone to 255XXXXXXXXX
    String formattedPhone = phoneNumber.replaceAll(RegExp(r'[^0-9]'), '');
    if (formattedPhone.startsWith('0')) {
      formattedPhone = '255${formattedPhone.substring(1)}';
    }

    final user = _auth.currentUser;
    if (user == null) {
      return PaymentInitResult(
        status: PaymentInitStatus.failed,
        message: 'Please sign in before making a payment.',
        orderId: orderId,
      );
    }

    final String resolvedBackendBaseUrl = backendBaseUrl;
    if (resolvedBackendBaseUrl.isEmpty) {
      return PaymentInitResult(
        status: PaymentInitStatus.failed,
        message: 'Payment backend is required. Set BACKEND_URL.',
        orderId: orderId,
      );
    }

    try {
      // Force a fresh ID token to avoid using an expired token
      final idToken = await user.getIdToken(true);
      if (idToken == null || idToken.isEmpty) {
        return PaymentInitResult(
          status: PaymentInitStatus.failed,
          message: 'Could not verify your session. Please sign in again.',
          orderId: orderId,
        );
      }

      // 1. Create a transaction record in Firebase Firestore first (Pending)
      await _saveTransactionToFirebase(
        orderId: orderId,
        amount: amount,
        phoneNumber: formattedPhone,
        status: 'pending',
        customerName: fullName,
        paymentReference: paymentReference,
      );

      // 2. Prepare Zenopay Payload
      final payload = {
        'create_order': '1',
        'buyer_email': email,
        'buyer_name': fullName,
        'buyer_phone': formattedPhone,
        'amount': amount.toStringAsFixed(0),
        // Optional: webhook_url for Zenopay to notify your backend/Firebase function
        // 'webhook_url': 'https://your-firebase-function-url.com/zenopay-webhook',
      };
      final backendPayload = {
        'app_order_id': orderId,
        ...payload,
        if (paymentReference != null && paymentReference.trim().isNotEmpty)
          'payment_reference': paymentReference.trim(),
      };

      debugPrint("🔵 INITIATING ZENOPAY: $orderId for TZS $amount");

      // 3. Call protected backend payment API
      final Response response = await _dio.post(
        "$resolvedBackendBaseUrl/zenopay-pay",
        data: backendPayload,
        options: Options(
          contentType: Headers.jsonContentType,
          headers: <String, String>{
            'Authorization': 'Bearer $idToken',
          },
        ),
      );

      debugPrint("🔵 ZENOPAY RESPONSE: ${response.data}");

      final String? zenoOrderId = _extractOrderId(response.data);
      if (zenoOrderId != null) {
        await _attachZenopayOrderId(orderId, zenoOrderId);
      }

      final result = _parseZenopayResponse(response, orderId: orderId);

      if (result.isSuccess) {
        await _updateTransactionStatus(orderId, 'completed');
      } else if (result.isPending) {
        await _updateTransactionStatus(orderId, 'pending');
      } else {
        await _updateTransactionStatus(orderId, 'failed');
        debugPrint("❌ Zenopay Payment Failed: ${response.data}");
      }

      return result;
    } on DioException catch (e) {
      final String? message =
          _extractBackendErrorMessage(e, resolvedBackendBaseUrl);
      debugPrint("💥 ZENOPAY ERROR: $message");
      await _updateTransactionStatus(orderId, 'error');
      return PaymentInitResult(
        status: PaymentInitStatus.failed,
        message: message ?? "Payment request failed",
        orderId: orderId,
      );
    } catch (e) {
      debugPrint("💥 ZENOPAY ERROR: $e");
      await _updateTransactionStatus(orderId, 'error');
      return PaymentInitResult(
        status: PaymentInitStatus.failed,
        message: "Unexpected payment error",
        orderId: orderId,
      );
    }
  }

  /// Save transaction to Firebase
  Future<void> _saveTransactionToFirebase({
    required String orderId,
    required double amount,
    required String phoneNumber,
    required String status,
    required String customerName,
    String? paymentReference,
  }) async {
    try {
      final user = _auth.currentUser;
      await _firestore.collection('payments').doc(orderId).set({
        'userId': user?.uid,
        'orderId': orderId,
        'amount': amount,
        'currency': 'TZS',
        'phoneNumber': phoneNumber,
        'customerName': customerName,
        'status': status,
        'provider': 'Zenopay',
        if (paymentReference != null && paymentReference.trim().isNotEmpty)
          'paymentReference': paymentReference.trim(),
        'createdAt': FieldValue.serverTimestamp(),
      });
    } catch (e) {
      debugPrint("🔥 Firebase Save Error: $e");
    }
  }

  /// Update transaction status in Firebase
  Future<void> _updateTransactionStatus(String orderId, String status) async {
    try {
      await _firestore.collection('payments').doc(orderId).update({
        'status': status,
        'updatedAt': FieldValue.serverTimestamp(),
      });
    } catch (e) {
      debugPrint("🔥 Firebase Update Error: $e");
    }
  }

  Future<void> _attachZenopayOrderId(String orderId, String zenoOrderId) async {
    try {
      await _firestore.collection('payments').doc(orderId).update({
        'zenoOrderId': zenoOrderId,
        'updatedAt': FieldValue.serverTimestamp(),
      });
    } catch (e) {
      debugPrint("🔥 Firebase Update Error (zenoOrderId): $e");
    }
  }

  Future<void> syncPendingPaymentStatus(String orderId) async {
    if (backendBaseUrl.isEmpty) {
      debugPrint('💥 ZENOPAY STATUS SYNC ERROR: Payment backend is required.');
      return;
    }

    try {
      final user = _auth.currentUser;
      if (user == null) {
        debugPrint('💥 ZENOPAY STATUS SYNC ERROR: User is not authenticated.');
        return;
      }

      // Force refresh the ID token before contacting backend
      final idToken = await user.getIdToken(true);
      if (idToken == null || idToken.isEmpty) {
        debugPrint('💥 ZENOPAY STATUS SYNC ERROR: Missing auth token.');
        return;
      }

      await _dio.get(
        "$backendBaseUrl/zenopay-status/${Uri.encodeComponent(orderId)}",
        options: Options(
          responseType: ResponseType.json,
          contentType: Headers.jsonContentType,
          headers: <String, String>{
            'Authorization': 'Bearer $idToken',
          },
        ),
      );
    } on DioException catch (e) {
      debugPrint(
          "💥 ZENOPAY STATUS SYNC ERROR: ${_extractErrorMessage(e.response?.data) ?? e.message}");
    } catch (e) {
      debugPrint("💥 ZENOPAY STATUS SYNC ERROR: $e");
    }
  }

  static String _normalizeBaseUrl(String value) {
    final trimmed = value.trim();
    if (trimmed.isEmpty) {
      return '';
    }
    return trimmed.endsWith('/')
        ? trimmed.substring(0, trimmed.length - 1)
        : trimmed;
  }

  String? _extractBackendErrorMessage(
    DioException error,
    String resolvedBackendBaseUrl,
  ) {
    final apiMessage =
        _extractErrorMessage(error.response?.data) ?? error.message;

    if (error.type == DioExceptionType.connectionError ||
        error.type == DioExceptionType.connectionTimeout ||
        error.type == DioExceptionType.receiveTimeout) {
      if (resolvedBackendBaseUrl.isEmpty) {
        return 'Payment backend is not configured. Set BACKEND_URL.';
      }
      return 'Could not reach payment backend at $resolvedBackendBaseUrl. Start backend/server.js or set BACKEND_URL to a live server.';
    }

    return apiMessage;
  }

  // Fallback for Bank (If Zenopay supports it, otherwise map to their flow)
  Future<PaymentInitResult> initiateBank({
    required String bankName,
    required double amount,
    required String email,
    required String fullName,
  }) async {
    // For now, mapping Bank to the same Zenopay flow or a custom instruction
    final String orderId = "ZEN-BANK-${DateTime.now().millisecondsSinceEpoch}";
    return await initiateZenopayPayment(
      phoneNumber:
          "", // Usually bank doesn't need phone for STK but Zenopay might
      amount: amount,
      email: email,
      fullName: fullName,
      orderId: orderId,
    );
  }

  PaymentInitResult _parseZenopayResponse(Response response,
      {String? orderId}) {
    final int statusCode = response.statusCode ?? 0;
    final dynamic data = response.data;

    String? status = _extractStatus(data);
    final String? message = _extractErrorMessage(data);
    final String messageLower = (message ?? '').toLowerCase();

    if (status != null) {
      final String normalized = status.toLowerCase();
      if (_matchesAny(
          messageLower, const ['request in progress', 'callback'])) {
        return PaymentInitResult(
          status: PaymentInitStatus.pending,
          message: message,
          orderId: orderId,
        );
      }
      if (_matchesAny(normalized, const ['success', 'completed', 'paid'])) {
        return PaymentInitResult(
          status: PaymentInitStatus.success,
          message: message,
          orderId: orderId,
        );
      }
      if (_matchesAny(
          normalized, const ['pending', 'processing', 'created', 'queued'])) {
        return PaymentInitResult(
          status: PaymentInitStatus.pending,
          message: message,
          orderId: orderId,
        );
      }
      if (_matchesAny(normalized,
          const ['fail', 'failed', 'cancel', 'error', 'timeout', 'expired'])) {
        return PaymentInitResult(
          status: PaymentInitStatus.failed,
          message: message,
          orderId: orderId,
        );
      }
    }

    if (statusCode >= 200 && statusCode < 300) {
      return PaymentInitResult(
        status: PaymentInitStatus.pending,
        message: message,
        orderId: orderId,
      );
    }

    return PaymentInitResult(
      status: PaymentInitStatus.failed,
      message: message ?? "Payment request failed",
      orderId: orderId,
    );
  }

  String? _extractStatus(dynamic data) {
    if (data == null) return null;
    if (data is String) {
      final String lower = data.toLowerCase();
      if (_matchesAny(
          lower, const ['success', 'completed', 'pending', 'processing'])) {
        return lower;
      }
      if (_matchesAny(lower, const ['failed', 'cancel', 'error'])) {
        return lower;
      }
      return null;
    }

    if (data is Map) {
      final Map<String, dynamic> map = Map<String, dynamic>.from(data);
      final String? direct = _firstString(map, const [
        'payment_status',
        'order_status',
        'status',
        'state',
        'result',
      ]);
      if (direct != null) return direct;

      final String? raw = _firstString(map, const ['raw']);
      if (raw != null) {
        final String lower = raw.toLowerCase();
        if (_matchesAny(
            lower, const ['success', 'completed', 'pending', 'processing'])) {
          return lower;
        }
        if (_matchesAny(lower, const ['failed', 'cancel', 'error'])) {
          return lower;
        }
      }

      final dynamic nested = map['data'];
      if (nested is String) {
        return nested.toLowerCase();
      }
      if (nested is Map) {
        final Map<String, dynamic> nestedMap =
            Map<String, dynamic>.from(nested);
        return _firstString(nestedMap, const [
          'payment_status',
          'order_status',
          'status',
          'state',
          'result',
        ]);
      }
    }

    return null;
  }

  String? _extractErrorMessage(dynamic data) {
    if (data == null) return null;
    if (data is String) return data;

    if (data is Map) {
      final Map<String, dynamic> map = Map<String, dynamic>.from(data);
      final String? direct = _firstString(
          map, const ['message', 'error', 'errors', 'detail', 'response']);
      if (direct != null) return direct;

      final dynamic nested = map['data'];
      if (nested is Map) {
        final Map<String, dynamic> nestedMap =
            Map<String, dynamic>.from(nested);
        return _firstString(
            nestedMap, const ['message', 'error', 'errors', 'detail']);
      }
    }

    return null;
  }

  String? _extractOrderId(dynamic data) {
    if (data == null) return null;
    if (data is String) {
      final Map<String, dynamic>? parsed = _tryParseMap(data);
      if (parsed != null) {
        return _extractOrderId(parsed);
      }

      final Match? jsonMatch =
          RegExp(r'"order_id"\s*:\s*"([^"]+)"').firstMatch(data);
      if (jsonMatch != null) {
        return jsonMatch.group(1);
      }

      final Match? plainMatch =
          RegExp(r'order_id\s*[=:]\s*([A-Za-z0-9_-]+)', caseSensitive: false)
              .firstMatch(data);
      if (plainMatch != null) {
        return plainMatch.group(1);
      }
      return null;
    }

    if (data is Map) {
      final Map<String, dynamic> map = Map<String, dynamic>.from(data);
      final String? direct = _firstString(map, const ['order_id', 'orderId']);
      if (direct != null) return direct;

      final dynamic nested = map['data'];
      if (nested is Map) {
        final Map<String, dynamic> nestedMap =
            Map<String, dynamic>.from(nested);
        return _firstString(nestedMap, const ['order_id', 'orderId']);
      }

      final String? raw = _firstString(map, const ['raw']);
      if (raw != null) {
        return _extractOrderId(raw);
      }
    }

    return null;
  }

  Map<String, dynamic>? _tryParseMap(String value) {
    try {
      final dynamic decoded = jsonDecode(value);
      if (decoded is Map) {
        return Map<String, dynamic>.from(decoded);
      }
    } catch (_) {
      // Ignore malformed payloads and fall back to regex extraction.
    }
    return null;
  }

  String? _firstString(Map<String, dynamic> map, List<String> keys) {
    for (final String key in keys) {
      final dynamic value = map[key];
      if (value == null) continue;
      if (value is String && value.trim().isNotEmpty) return value;
      if (value is List && value.isNotEmpty && value.first is String) {
        return value.first as String;
      }
    }
    return null;
  }

  bool _matchesAny(String value, List<String> needles) {
    for (final String needle in needles) {
      if (value.contains(needle)) return true;
    }
    return false;
  }
}
