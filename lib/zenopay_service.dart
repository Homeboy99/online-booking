import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;

class ZenoPayService {
  final String baseUrl;
  final Duration pollingInterval;
  final Duration maxPollingDuration;

  Timer? _pollingTimer;
  int _consecutiveErrors = 0;

  ZenoPayService({
    required this.baseUrl,
    this.pollingInterval = const Duration(seconds: 5),
    this.maxPollingDuration = const Duration(minutes: 10),
  });

  Future<void> startPayment({
    required String amount,
    required String phone,
    required String orderId,
    required String firebaseUserToken,
    required Function(String status) onStatusChanged,
    required Function(String errorMessage) onError,
    Future<String> Function()? onTokenExpired,
  }) async {
    if (amount.isEmpty || phone.isEmpty || orderId.isEmpty) {
      onError("Amount, phone, and orderId cannot be empty.");
      return;
    }

    final url = Uri.parse("$baseUrl/api/payments/initialize");

    try {
      final response = await http
          .post(
            url,
            headers: {
              "Content-Type": "application/json",
              "Authorization": "Bearer $firebaseUserToken",
            },
            body: jsonEncode({
              "amount": amount,
              "phone": phone,
              "orderId": orderId,
            }),
          )
          .timeout(const Duration(seconds: 15));

      final data = _safeJsonDecode(response.body);

      if (response.statusCode == 200 && data['status'] == 'success') {
        _startPolling(
          orderId: orderId,
          currentToken: firebaseUserToken,
          onStatusChanged: onStatusChanged,
          onError: onError,
          onTokenExpired: onTokenExpired,
        );
      } else {
        onError(data['message'] ?? 'Payment initialization failed.');
      }
    } catch (e) {
      onError("Initialization error: ${_formatError(e)}");
    }
  }

  void _startPolling({
    required String orderId,
    required String currentToken,
    required Function(String status) onStatusChanged,
    required Function(String errorMessage) onError,
    Future<String> Function()? onTokenExpired,
  }) {
    _pollingTimer?.cancel();
    _consecutiveErrors = 0;

    final url = Uri.parse("$baseUrl/api/payments/status/$orderId");
    final stopwatch = Stopwatch()..start();

    _pollingTimer = Timer.periodic(pollingInterval, (timer) async {
      if (stopwatch.elapsed >= maxPollingDuration) {
        timer.cancel();
        _pollingTimer = null;
        onError(
            "Polling timeout after ${maxPollingDuration.inMinutes} minutes.");
        return;
      }

      try {
        final response = await http.get(
          url,
          headers: {"Authorization": "Bearer $currentToken"},
        ).timeout(const Duration(seconds: 10));

        if (response.statusCode == 200) {
          _consecutiveErrors = 0;
          final data = _safeJsonDecode(response.body);
          final String status = data['paymentStatus'] ?? data['status'];
          if (status == null) {
            onError("Invalid response: missing paymentStatus field.");
            timer.cancel();
            _pollingTimer = null;
            return;
          }
          onStatusChanged(status);
          if (status == 'completed' ||
              status == 'failed' ||
              status == 'cancelled') {
            timer.cancel();
            _pollingTimer = null;
          }
        } else if (response.statusCode == 401 && onTokenExpired != null) {
          try {
            final newToken = await onTokenExpired();
            if (newToken.isNotEmpty) {
              currentToken = newToken;
              _consecutiveErrors = 0;
            } else {
              throw Exception("Token refresh returned empty token.");
            }
          } catch (_) {
            onError("Authentication failed. Please login again.");
            timer.cancel();
            _pollingTimer = null;
          }
        } else {
          throw Exception("HTTP ${response.statusCode}: ${response.body}");
        }
      } catch (e) {
        _consecutiveErrors++;
        if (_consecutiveErrors >= 3) {
          onError(
              "Unable to fetch payment status after multiple attempts: ${_formatError(e)}");
          timer.cancel();
          _pollingTimer = null;
        }
      }
    });
  }

  void stopTracking() {
    _pollingTimer?.cancel();
    _pollingTimer = null;
    _consecutiveErrors = 0;
  }

  bool get isPollingActive => _pollingTimer != null;

  dynamic _safeJsonDecode(String body) {
    try {
      return jsonDecode(body);
    } catch (_) {
      return {};
    }
  }

  String _formatError(Object error) {
    if (error is http.ClientException) return "Network error: ${error.message}";
    if (error is TimeoutException) return "Request timeout.";
    return error.toString();
  }
}
