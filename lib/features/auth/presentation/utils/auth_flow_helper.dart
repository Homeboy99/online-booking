import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:google_sign_in/google_sign_in.dart';

import '../../domain/entities/app_user.dart';

class AuthFlowHelper {
  AuthFlowHelper._();

  static final GoogleSignIn _googleSignIn = GoogleSignIn.instance;
  static Future<void>? _googleSignInInitialization;

  static String? get _googleClientId {
    final options = Firebase.app().options;

    switch (defaultTargetPlatform) {
      case TargetPlatform.iOS:
      case TargetPlatform.macOS:
        return options.iosClientId;
      case TargetPlatform.android:
        return options.androidClientId;
      default:
        return null;
    }
  }

  static bool isValidEmail(String? value) {
    final email = value?.trim() ?? '';
    if (email.isEmpty) {
      return false;
    }

    return RegExp(r'^[^@\s]+@[^@\s]+\.[^@\s]+$').hasMatch(email);
  }

  static Future<UserCredential?> signInWithGoogle() async {
    await _ensureGoogleSignInInitialized();

    if (!kIsWeb) {
      try {
        await _googleSignIn.signOut();
      } catch (_) {
        // Ignore stale Google sessions and continue with a fresh sign-in.
      }
    }

    GoogleSignInAccount googleUser;
    try {
      googleUser = await _googleSignIn.authenticate(
        scopeHint: const ['email'],
      );
    } on GoogleSignInException catch (error) {
      if (error.code == GoogleSignInExceptionCode.canceled) {
        return null;
      }
      rethrow;
    }

    final googleAuth = googleUser.authentication;
    if (googleAuth.idToken == null) {
      return null;
    }

    final credential = GoogleAuthProvider.credential(
      idToken: googleAuth.idToken,
    );

    final userCredential =
        await FirebaseAuth.instance.signInWithCredential(credential);
    final user = userCredential.user;

    if (user != null) {
      await createUserProfileIfNeeded(user);
    }

    return userCredential;
  }

  static Future<void> _ensureGoogleSignInInitialized() {
    return _googleSignInInitialization ??= _googleSignIn.initialize(
      clientId: _googleClientId,
    );
  }

  static Future<void> createUserProfileIfNeeded(
    User user, {
    String? fallbackName,
  }) async {
    final userRef =
        FirebaseFirestore.instance.collection('users').doc(user.uid);
    final userDoc = await userRef.get();

    if (userDoc.exists) {
      return;
    }

    final trimmedDisplayName = user.displayName?.trim() ?? '';
    final trimmedFallbackName = fallbackName?.trim() ?? '';
    final newUser = AppUser(
      uid: user.uid,
      name: trimmedDisplayName.isNotEmpty
          ? trimmedDisplayName
          : trimmedFallbackName.isNotEmpty
              ? trimmedFallbackName
              : 'NextGen User',
      email: user.email ?? '',
      createdAt: DateTime.now(),
    );

    await userRef.set(newUser.toFirestore(), SetOptions(merge: true));
  }

  static Future<void> sendPasswordResetEmail(String email) {
    return FirebaseAuth.instance.sendPasswordResetEmail(email: email.trim());
  }

  static Future<void> signOut() async {
    try {
      await FirebaseAuth.instance.signOut();
    } finally {
      try {
        await _ensureGoogleSignInInitialized();
        await _googleSignIn.signOut();
      } catch (_) {
        // Ignore Google sign-out failures so Firebase logout still succeeds.
      }
    }
  }

  static String firebaseErrorMessage(
    FirebaseAuthException error, {
    bool isGoogleFlow = false,
    bool isPasswordReset = false,
  }) {
    switch (error.code) {
      case 'invalid-email':
        return 'Enter a valid email address.';
      case 'user-not-found':
        return isPasswordReset
            ? 'No account was found for that email address.'
            : 'No user found for that email. Please sign up.';
      case 'wrong-password':
      case 'invalid-credential':
        return 'Incorrect email or password.';
      case 'email-already-in-use':
        return 'This email is already registered. Please sign in.';
      case 'weak-password':
        return 'The password provided is too weak.';
      case 'network-request-failed':
        return 'Network error. Check your internet connection and try again.';
      case 'too-many-requests':
        return 'Too many attempts. Please wait a bit and try again.';
      case 'account-exists-with-different-credential':
        return 'This email already uses another sign-in method. Use that method first, then link Google later.';
      case 'popup-closed-by-user':
      case 'cancelled-popup-request':
        return 'Google sign-in was cancelled.';
      case 'missing-google-auth-token':
        return 'Google sign-in could not get the required authentication token.';
      default:
        if (isGoogleFlow) {
          return 'Google sign-in failed. Please try again.';
        }
        if (isPasswordReset) {
          return 'Could not send the reset email right now. Please try again.';
        }
        return 'Authentication failed. Please try again.';
    }
  }

  static String googleErrorMessage(Object error) {
    if (error is FirebaseAuthException) {
      return firebaseErrorMessage(error, isGoogleFlow: true);
    }

    if (error is GoogleSignInException) {
      switch (error.code) {
        case GoogleSignInExceptionCode.canceled:
        case GoogleSignInExceptionCode.interrupted:
          return 'Google sign-in was cancelled.';
        case GoogleSignInExceptionCode.clientConfigurationError:
        case GoogleSignInExceptionCode.providerConfigurationError:
          return 'Google sign-in is not configured for this Android build yet. Add this app signing SHA to Firebase, then download the updated google-services.json.';
        case GoogleSignInExceptionCode.uiUnavailable:
          return 'Google sign-in is unavailable right now. Please try again.';
        default:
          return error.description ??
              'Google sign-in failed. Please try again.';
      }
    }

    if (error is PlatformException) {
      final details = '${error.code} ${error.message ?? ''}'.toLowerCase();
      if (details.contains('apiexception: 10') ||
          details.contains('developer_error')) {
        return 'Google sign-in is not configured for this Android build yet. Add this app signing SHA to Firebase, then download the updated google-services.json.';
      }

      switch (error.code) {
        case 'sign_in_canceled':
          return 'Google sign-in was cancelled.';
        case 'network_error':
          return 'Network error while contacting Google. Try again.';
        case 'sign_in_failed':
          return 'Google sign-in failed. Check your Google/Firebase setup and try again.';
        default:
          return error.message ?? 'Google sign-in failed. Please try again.';
      }
    }

    return 'Google sign-in failed. Please try again.';
  }
}
