import 'package:flutter/foundation.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:timezone/timezone.dart' as tz;
import 'package:timezone/data/latest.dart' as tz;

import 'native_app_config_service.dart';

class NotificationService {
  static final NotificationService _instance = NotificationService._internal();
  factory NotificationService() => _instance;
  NotificationService._internal();

  final FlutterLocalNotificationsPlugin _notificationsPlugin =
      FlutterLocalNotificationsPlugin();
  final NativeAppConfigService _nativeAppConfigService =
      NativeAppConfigService();

  Future<void> init() async {
    tz.initializeTimeZones();
    await _configureLocalTimezone();

    const AndroidInitializationSettings initializationSettingsAndroid =
        AndroidInitializationSettings('@mipmap/ic_launcher');
    const DarwinInitializationSettings initializationSettingsDarwin =
        DarwinInitializationSettings(
      requestAlertPermission: false,
      requestBadgePermission: false,
      requestSoundPermission: false,
    );

    const InitializationSettings initializationSettings =
        InitializationSettings(
      android: initializationSettingsAndroid,
      iOS: initializationSettingsDarwin,
      macOS: initializationSettingsDarwin,
    );

    await _notificationsPlugin.initialize(
      settings: initializationSettings,
    );
  }

  Future<bool> ensurePermissions() async {
    final androidNotifications =
        _notificationsPlugin.resolvePlatformSpecificImplementation<
            AndroidFlutterLocalNotificationsPlugin>();

    if (androidNotifications == null) {
      return !kIsWeb;
    }

    final notificationsEnabled =
        await androidNotifications.areNotificationsEnabled() ?? false;

    if (!notificationsEnabled) {
      final granted =
          await androidNotifications.requestNotificationsPermission() ?? false;
      if (!granted) return false;
    }

    final canScheduleExact =
        await androidNotifications.canScheduleExactNotifications() ?? true;
    if (!canScheduleExact) {
      await androidNotifications.requestExactAlarmsPermission();
    }

    return true;
  }

  Future<void> scheduleJourneyAlert({
    required int id,
    required String title,
    required String body,
    required DateTime scheduledDate,
    String? customSoundUri,
  }) async {
    if (scheduledDate.isBefore(DateTime.now())) return;

    final soundUri = _normalizeSoundUri(customSoundUri);
    final AndroidNotificationDetails androidDetails =
        AndroidNotificationDetails(
      _channelIdFor(soundUri),
      'Journey Alerts',
      channelDescription: 'Notifications for bus departure and arrival',
      importance: Importance.max,
      priority: Priority.high,
      category: AndroidNotificationCategory.alarm,
      audioAttributesUsage: AudioAttributesUsage.alarm,
      sound: soundUri == null ? null : UriAndroidNotificationSound(soundUri),
      playSound: true,
    );

    await _notificationsPlugin.zonedSchedule(
      id: id,
      title: title,
      body: body,
      scheduledDate: tz.TZDateTime.from(scheduledDate, tz.local),
      notificationDetails: NotificationDetails(android: androidDetails),
      androidScheduleMode: await _androidScheduleMode(),
    );
  }

  Future<void> cancel(int id) async {
    await _notificationsPlugin.cancel(id: id);
  }

  Future<void> cancelAll() async {
    await _notificationsPlugin.cancelAll();
  }

  Future<void> _configureLocalTimezone() async {
    final timeZoneId = await _nativeAppConfigService.getTimeZoneId();
    if (timeZoneId == null) return;

    try {
      tz.setLocalLocation(tz.getLocation(timeZoneId));
    } catch (_) {
      // Keep the timezone package default when the device zone isn't found.
    }
  }

  Future<AndroidScheduleMode> _androidScheduleMode() async {
    final androidNotifications =
        _notificationsPlugin.resolvePlatformSpecificImplementation<
            AndroidFlutterLocalNotificationsPlugin>();

    if (androidNotifications == null) {
      return AndroidScheduleMode.exactAllowWhileIdle;
    }

    final canScheduleExact =
        await androidNotifications.canScheduleExactNotifications() ?? true;

    return canScheduleExact
        ? AndroidScheduleMode.exactAllowWhileIdle
        : AndroidScheduleMode.inexactAllowWhileIdle;
  }

  String? _normalizeSoundUri(String? value) {
    final normalized = value?.trim();
    if (normalized == null || normalized.isEmpty) {
      return null;
    }
    return normalized;
  }

  String _channelIdFor(String? soundUri) {
    if (soundUri == null) return 'journey_alerts_default';
    return 'journey_alerts_${_stableHash(soundUri)}';
  }

  String _stableHash(String input) {
    var hash = 0;
    for (final code in input.codeUnits) {
      hash = ((hash * 31) + code) & 0x7fffffff;
    }
    return hash.toRadixString(16);
  }
}
