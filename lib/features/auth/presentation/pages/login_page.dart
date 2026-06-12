import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:animate_do/animate_do.dart';
import 'package:font_awesome_flutter/font_awesome_flutter.dart';
import '../../../../core/theme/app_colors.dart';
import 'signup_page.dart';
import '../../../home/presentation/pages/main_bottom_nav.dart';
import '../utils/auth_flow_helper.dart';

class LoginPage extends StatefulWidget {
  const LoginPage({super.key});

  @override
  State<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends State<LoginPage> {
  final _formKey = GlobalKey<FormState>();
  final _emailController = TextEditingController();
  final _passwordController = TextEditingController();
  bool _isPasswordVisible = false;
  bool _isLoading = false;

  @override
  void dispose() {
    _emailController.dispose();
    _passwordController.dispose();
    super.dispose();
  }

  void _showSnackBar(
    String message, {
    Color backgroundColor = AppColors.error,
  }) {
    if (!mounted) {
      return;
    }

    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(message),
        backgroundColor: backgroundColor,
        behavior: SnackBarBehavior.floating,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(10)),
      ),
    );
  }

  void _navigateToHome() {
    if (!mounted) {
      return;
    }

    Navigator.pushReplacement(
      context,
      PageRouteBuilder(
        pageBuilder: (context, animation, secondaryAnimation) =>
            const MainBottomNav(),
        transitionsBuilder: (context, animation, secondaryAnimation, child) {
          return FadeTransition(opacity: animation, child: child);
        },
        transitionDuration: const Duration(milliseconds: 800),
      ),
    );
  }

  Future<void> _handleGoogleSignIn() async {
    FocusScope.of(context).unfocus();
    setState(() => _isLoading = true);

    try {
      final userCredential = await AuthFlowHelper.signInWithGoogle();
      if (userCredential?.user == null) {
        return;
      }

      _navigateToHome();
    } on FirebaseAuthException catch (error) {
      debugPrint('Google Auth Error [${error.code}]: ${error.message}');
      _showSnackBar(
        AuthFlowHelper.firebaseErrorMessage(error, isGoogleFlow: true),
      );
    } catch (error) {
      debugPrint('Google Auth Error: $error');
      _showSnackBar(AuthFlowHelper.googleErrorMessage(error));
    } finally {
      if (mounted) setState(() => _isLoading = false);
    }
  }

  Future<void> _handleLogin() async {
    if (_formKey.currentState!.validate()) {
      FocusScope.of(context).unfocus();
      setState(() => _isLoading = true);

      try {
        await FirebaseAuth.instance.signInWithEmailAndPassword(
          email: _emailController.text.trim(),
          password: _passwordController.text.trim(),
        );

        _navigateToHome();
      } on FirebaseAuthException catch (error) {
        _showSnackBar(AuthFlowHelper.firebaseErrorMessage(error));
      } finally {
        if (mounted) setState(() => _isLoading = false);
      }
    }
  }

  Future<void> _handleForgotPassword() async {
    final dialogController = TextEditingController(
      text: _emailController.text.trim(),
    );
    final dialogFormKey = GlobalKey<FormState>();

    final email = await showDialog<String>(
      context: context,
      builder: (dialogContext) {
        return AlertDialog(
          title: const Text('Reset Password'),
          content: Form(
            key: dialogFormKey,
            child: TextFormField(
              controller: dialogController,
              keyboardType: TextInputType.emailAddress,
              autofocus: true,
              decoration: const InputDecoration(
                labelText: 'Email Address',
                hintText: 'name@example.com',
              ),
              validator: (value) {
                if (!AuthFlowHelper.isValidEmail(value)) {
                  return 'Enter a valid email address';
                }
                return null;
              },
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () {
                if (dialogFormKey.currentState!.validate()) {
                  Navigator.of(dialogContext).pop(dialogController.text.trim());
                }
              },
              child: const Text('Send Link'),
            ),
          ],
        );
      },
    );

    dialogController.dispose();

    if (!mounted || email == null || email.isEmpty) {
      return;
    }

    FocusScope.of(context).unfocus();
    setState(() => _isLoading = true);

    try {
      await AuthFlowHelper.sendPasswordResetEmail(email);
      _showSnackBar(
        'Password reset email sent to $email.',
        backgroundColor: AppColors.success,
      );
    } on FirebaseAuthException catch (error) {
      _showSnackBar(
        AuthFlowHelper.firebaseErrorMessage(
          error,
          isPasswordReset: true,
        ),
      );
    } finally {
      if (mounted) {
        setState(() => _isLoading = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: AppColors.background,
      body: Stack(
        children: [
          SingleChildScrollView(
            padding: const EdgeInsets.symmetric(horizontal: 30),
            child: ConstrainedBox(
              constraints: BoxConstraints(
                minHeight: MediaQuery.of(context).size.height,
              ),
              child: IntrinsicHeight(
                child: Form(
                  key: _formKey,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const SizedBox(height: 80),
                      FadeInDown(
                        child: Center(
                          child: Container(
                            padding: const EdgeInsets.all(20),
                            decoration: BoxDecoration(
                              gradient: AppColors.primaryGradient,
                              borderRadius: BorderRadius.circular(24),
                              boxShadow: AppColors.premiumShadow,
                            ),
                            child: const Icon(Icons.directions_bus_rounded,
                                color: Colors.white, size: 40),
                          ),
                        ),
                      ),
                      const SizedBox(height: 40),
                      FadeInLeft(
                        child: const Text(
                          "Welcome Back",
                          style: TextStyle(
                            fontWeight: FontWeight.w900,
                            color: AppColors.textPrimary,
                            letterSpacing: -0.5,
                          ),
                        ),
                      ),
                      FadeInLeft(
                        delay: const Duration(milliseconds: 200),
                        child: const Text(
                          "Sign in to continue your luxury journey",
                          style: TextStyle(
                            color: AppColors.textSecondary,
                            fontSize: 16,
                            fontWeight: FontWeight.w500,
                          ),
                        ),
                      ),
                      const SizedBox(height: 40),
                      FadeInUp(
                        delay: const Duration(milliseconds: 400),
                        child: _buildTextField(
                          controller: _emailController,
                          label: "Email Address",
                          icon: Icons.alternate_email_rounded,
                          validator: (value) {
                            if (value == null || value.isEmpty) {
                              return "Email is required";
                            }
                            if (!AuthFlowHelper.isValidEmail(value)) {
                              return "Enter a valid email address";
                            }
                            return null;
                          },
                        ),
                      ),
                      const SizedBox(height: 20),
                      FadeInUp(
                        delay: const Duration(milliseconds: 600),
                        child: _buildTextField(
                          controller: _passwordController,
                          label: "Password",
                          icon: Icons.lock_outline_rounded,
                          isPassword: true,
                          validator: (value) {
                            if (value == null || value.isEmpty) {
                              return "Password is required";
                            }
                            return null;
                          },
                        ),
                      ),
                      const SizedBox(height: 12),
                      FadeInRight(
                        child: Align(
                          alignment: Alignment.centerRight,
                          child: TextButton(
                            onPressed:
                                _isLoading ? null : _handleForgotPassword,
                            child: const Text(
                              "Forgot Password?",
                              style: TextStyle(
                                  color: AppColors.primary,
                                  fontWeight: FontWeight.w700),
                            ),
                          ),
                        ),
                      ),
                      const SizedBox(height: 30),
                      FadeInUp(
                        delay: const Duration(milliseconds: 800),
                        child: Container(
                          width: double.infinity,
                          height: 60,
                          decoration: BoxDecoration(
                            gradient: AppColors.primaryGradient,
                            borderRadius: BorderRadius.circular(18),
                            boxShadow: AppColors.premiumShadow,
                          ),
                          child: ElevatedButton(
                            onPressed: _isLoading ? null : _handleLogin,
                            style: ElevatedButton.styleFrom(
                              backgroundColor: Colors.transparent,
                              shadowColor: Colors.transparent,
                              shape: RoundedRectangleBorder(
                                  borderRadius: BorderRadius.circular(18)),
                            ),
                            child: const Text(
                              "SIGN IN",
                              style: TextStyle(
                                  fontSize: 16,
                                  fontWeight: FontWeight.w800,
                                  color: Colors.white,
                                  letterSpacing: 1),
                            ),
                          ),
                        ),
                      ),
                      const SizedBox(height: 40),
                      FadeIn(
                        delay: const Duration(milliseconds: 1000),
                        child: Row(
                          children: [
                            const Expanded(
                                child: Divider(color: Colors.black12)),
                            Padding(
                              padding:
                                  const EdgeInsets.symmetric(horizontal: 16),
                              child: Text("Social Connect",
                                  style: TextStyle(
                                      color: AppColors.textMuted,
                                      fontSize: 12,
                                      fontWeight: FontWeight.w600)),
                            ),
                            const Expanded(
                                child: Divider(color: Colors.black12)),
                          ],
                        ),
                      ),
                      const SizedBox(height: 30),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.center,
                        children: [
                          FadeInLeft(
                            delay: const Duration(milliseconds: 1200),
                            child: GestureDetector(
                              onTap: _isLoading ? null : _handleGoogleSignIn,
                              child: _buildSocialButton(FontAwesomeIcons.google,
                                  const Color(0xFFDB4437)),
                            ),
                          ),
                          const SizedBox(width: 20),
                          FadeInUp(
                            delay: const Duration(milliseconds: 1200),
                            child: _buildSocialButton(
                                FontAwesomeIcons.apple, Colors.black),
                          ),
                          const SizedBox(width: 20),
                          FadeInRight(
                            delay: const Duration(milliseconds: 1200),
                            child: _buildSocialButton(FontAwesomeIcons.facebook,
                                const Color(0xFF4267B2)),
                          ),
                        ],
                      ),
                      const Spacer(),
                      FadeInUp(
                        delay: const Duration(milliseconds: 1400),
                        child: Row(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            const Text("Don't have an account?",
                                style:
                                    TextStyle(color: AppColors.textSecondary)),
                            TextButton(
                              onPressed: () {
                                Navigator.push(
                                  context,
                                  MaterialPageRoute(
                                      builder: (context) => const SignupPage()),
                                );
                              },
                              child: const Text(
                                "Sign Up",
                                style: TextStyle(
                                    color: AppColors.primary,
                                    fontWeight: FontWeight.w800),
                              ),
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 30),
                    ],
                  ),
                ),
              ),
            ),
          ),
          if (_isLoading)
            Container(
              color: Colors.black26,
              child: const Center(
                child: CircularProgressIndicator(),
              ),
            ),
        ],
      ),
    );
  }

  Widget _buildTextField({
    required TextEditingController controller,
    required String label,
    required IconData icon,
    bool isPassword = false,
    String? Function(String?)? validator,
  }) {
    return Container(
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(18),
        boxShadow: AppColors.softShadow,
      ),
      child: TextFormField(
        controller: controller,
        obscureText: isPassword && !_isPasswordVisible,
        validator: validator,
        style: const TextStyle(fontWeight: FontWeight.w600),
        decoration: InputDecoration(
          labelText: label,
          labelStyle: const TextStyle(
              color: AppColors.textMuted,
              fontSize: 14,
              fontWeight: FontWeight.w500),
          prefixIcon: Icon(icon, color: AppColors.primary, size: 22),
          suffixIcon: isPassword
              ? IconButton(
                  icon: Icon(
                    _isPasswordVisible
                        ? Icons.visibility_outlined
                        : Icons.visibility_off_outlined,
                    color: AppColors.textMuted,
                  ),
                  onPressed: () =>
                      setState(() => _isPasswordVisible = !_isPasswordVisible),
                )
              : null,
          border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(18),
              borderSide: BorderSide.none),
          filled: true,
          fillColor: Colors.white,
          contentPadding: const EdgeInsets.symmetric(vertical: 20),
        ),
      ),
    );
  }

  Widget _buildSocialButton(FaIconData icon, Color color) {
    return Container(
      height: 64,
      width: 64,
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(20),
        boxShadow: AppColors.softShadow,
      ),
      child: Center(
        child: FaIcon(icon, color: color, size: 26),
      ),
    );
  }
}
