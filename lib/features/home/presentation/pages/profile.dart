import 'dart:io';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../../../core/constants/tanzania_regions.dart';
import '../../../../core/services/app_session_service.dart';
import '../../../../core/services/user_profile_storage_service.dart';
import '../../../../core/theme/app_colors.dart';
import '../../domain/entities/user_profile_details.dart';

class ProfilePage extends StatefulWidget {
  const ProfilePage({super.key});

  @override
  State<ProfilePage> createState() => _ProfilePageState();
}

class _ProfilePageState extends State<ProfilePage> {
  final UserProfileStorageService _profileStorageService =
      UserProfileStorageService();
  final TextEditingController _nameController = TextEditingController();
  final TextEditingController _emailController = TextEditingController();
  final TextEditingController _phoneController = TextEditingController();
  final TextEditingController _nidaController = TextEditingController();
  final TextEditingController _ageController = TextEditingController();

  bool _isLoading = true;
  bool _isSaving = false;
  String _avatarPath = '';
  String _selectedLanguage = 'English';
  String _selectedCoachClass = 'Luxury AC Sleeper';
  bool _travelAlertsEnabled = true;
  bool _biometricLockEnabled = false;
  bool _shareLiveTripEnabled = true;
  List<String> _favoriteRoutes = [];
  DateTime _lastUpdated = DateTime.now();

  static const List<String> _languages = [
    'English',
    'Swahili',
    'French',
  ];

  static const List<String> _coachClasses = [
    'Luxury AC Sleeper',
    'Executive AC Seater',
    'Semi-Luxury AC',
    'Royal VVIP',
  ];

  @override
  void initState() {
    super.initState();
    _loadProfile();
  }

  @override
  void dispose() {
    _nameController.dispose();
    _emailController.dispose();
    _phoneController.dispose();
    _nidaController.dispose();
    _ageController.dispose();
    super.dispose();
  }

  Future<void> _loadProfile() async {
    final profile = await _profileStorageService.loadProfile();
    if (!mounted) {
      return;
    }
    setState(() {
      _nameController.text = profile.name;
      _emailController.text = profile.email;
      _phoneController.text = profile.phoneNumber;
      _nidaController.text = profile.nidaNumber;
      _ageController.text = profile.age.toString();
      _avatarPath = profile.avatarPath;
      _selectedLanguage = profile.preferredLanguage;
      _selectedCoachClass = profile.preferredCoachClass;
      _travelAlertsEnabled = profile.travelAlertsEnabled;
      _biometricLockEnabled = profile.biometricLockEnabled;
      _shareLiveTripEnabled = profile.shareLiveTripEnabled;
      _favoriteRoutes = List<String>.from(profile.favoriteRoutes);
      _lastUpdated = profile.updatedAt;
      _isLoading = false;
    });
  }

  Future<void> _pickAvatar() async {
    final result = await FilePicker.pickFile(
      type: FileType.image,
    );

    if (result == null || result.path == null || !mounted) {
      return;
    }

    setState(() => _avatarPath = result.path!);
  }

  Future<void> _saveProfile() async {
    final age = int.tryParse(_ageController.text.trim()) ?? 0;
    final email = _emailController.text.trim();
    final phone = _phoneController.text.trim();
    final nida = _nidaController.text.trim();

    if (_nameController.text.trim().isEmpty) {
      _showMessage('Name is required.');
      return;
    }
    if (email.isEmpty || !email.contains('@')) {
      _showMessage('Enter a valid email address.');
      return;
    }
    if (phone.length < 10) {
      _showMessage('Enter a valid phone number.');
      return;
    }
    if (nida.isNotEmpty && nida.length != 20) {
      _showMessage('NIDA number must have 20 digits.');
      return;
    }
    if (age < 1) {
      _showMessage('Enter a valid age.');
      return;
    }

    setState(() => _isSaving = true);
    final current = await _profileStorageService.loadProfile();
    final profile = current.copyWith(
      name: _nameController.text.trim(),
      email: email,
      phoneNumber: phone,
      nidaNumber: nida,
      age: age,
      avatarPath: _avatarPath,
      favoriteRoutes: _favoriteRoutes,
      preferredLanguage: _selectedLanguage,
      preferredCoachClass: _selectedCoachClass,
      travelAlertsEnabled: _travelAlertsEnabled,
      biometricLockEnabled: _biometricLockEnabled,
      shareLiveTripEnabled: _shareLiveTripEnabled,
      updatedAt: DateTime.now(),
    );

    await _profileStorageService.saveProfile(profile);
    if (!mounted) {
      return;
    }
    setState(() {
      _lastUpdated = DateTime.now();
      _isSaving = false;
    });
    _showMessage('Profile updated successfully.');
  }

  Future<void> _confirmLogout() async {
    final shouldLogout = await showDialog<bool>(
          context: context,
          builder: (dialogContext) {
            return AlertDialog(
              title: const Text('Log out'),
              content: const Text(
                'You can sign back in anytime. Auto logout after 2 minutes of inactivity is also enabled for security.',
              ),
              actions: [
                TextButton(
                  onPressed: () => Navigator.pop(dialogContext, false),
                  child: const Text('Cancel'),
                ),
                FilledButton(
                  onPressed: () => Navigator.pop(dialogContext, true),
                  style: FilledButton.styleFrom(
                    backgroundColor: AppColors.error,
                  ),
                  child: const Text('Log Out'),
                ),
              ],
            );
          },
        ) ??
        false;

    if (!shouldLogout) {
      return;
    }

    await AppSessionService.instance.logoutManually();
  }

  Future<void> _showFavoriteRouteSheet() async {
    var from = tanzaniaRegions.first;
    var to =
        tanzaniaRegions.length > 1 ? tanzaniaRegions[1] : tanzaniaRegions.first;

    await showModalBottomSheet<void>(
      context: context,
      backgroundColor: Colors.white,
      isScrollControlled: true,
      builder: (context) {
        return StatefulBuilder(
          builder: (context, setSheetState) {
            return Padding(
              padding: EdgeInsets.fromLTRB(
                24,
                24,
                24,
                MediaQuery.of(context).viewInsets.bottom + 24,
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const Text(
                    'Add favorite route',
                    style: TextStyle(
                      fontSize: 18,
                      fontWeight: FontWeight.w900,
                      color: AppColors.textPrimary,
                    ),
                  ),
                  const SizedBox(height: 20),
                  _buildDropdownField(
                    label: 'From',
                    value: from,
                    items: tanzaniaRegions,
                    onChanged: (value) {
                      if (value == null) {
                        return;
                      }
                      setSheetState(() => from = value);
                    },
                  ),
                  const SizedBox(height: 16),
                  _buildDropdownField(
                    label: 'To',
                    value: to,
                    items: tanzaniaRegions
                        .where((region) => region != from)
                        .toList(),
                    onChanged: (value) {
                      if (value == null) {
                        return;
                      }
                      setSheetState(() => to = value);
                    },
                  ),
                  const SizedBox(height: 24),
                  SizedBox(
                    width: double.infinity,
                    height: 54,
                    child: ElevatedButton(
                      onPressed: () {
                        final route = '$from -> $to';
                        if (!_favoriteRoutes.contains(route)) {
                          setState(() => _favoriteRoutes.add(route));
                        }
                        Navigator.pop(context);
                      },
                      style: ElevatedButton.styleFrom(
                        backgroundColor: AppColors.primary,
                        foregroundColor: Colors.white,
                      ),
                      child: const Text(
                        'SAVE ROUTE',
                        style: TextStyle(fontWeight: FontWeight.w800),
                      ),
                    ),
                  ),
                ],
              ),
            );
          },
        );
      },
    );
  }

  void _showMessage(String message) {
    if (!mounted) {
      return;
    }
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(message),
        backgroundColor: AppColors.primary,
        behavior: SnackBarBehavior.floating,
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (_isLoading) {
      return const Scaffold(
        backgroundColor: AppColors.background,
        body: Center(
          child: CircularProgressIndicator(color: AppColors.primary),
        ),
      );
    }

    final profile = UserProfileDetails.empty(
      userId: 'preview',
      name: _nameController.text.trim(),
      email: _emailController.text.trim(),
    );

    return Scaffold(
      backgroundColor: AppColors.background,
      body: CustomScrollView(
        slivers: [
          SliverAppBar(
            pinned: true,
            expandedHeight: 180,
            elevation: 0,
            backgroundColor: AppColors.primary,
            actions: [
              IconButton(
                tooltip: 'Log out',
                onPressed: _isSaving ? null : _confirmLogout,
                icon: const Icon(Icons.logout_rounded),
              ),
            ],
            flexibleSpace: FlexibleSpaceBar(
              background: Container(
                decoration: const BoxDecoration(
                  gradient: AppColors.primaryGradient,
                ),
                child: SafeArea(
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(24, 28, 24, 24),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Spacer(),
                        const Text(
                          'PROFILE',
                          style: TextStyle(
                            color: Colors.white70,
                            fontWeight: FontWeight.w800,
                            letterSpacing: 2,
                            fontSize: 11,
                          ),
                        ),
                        const SizedBox(height: 8),
                        Text(
                          _nameController.text.trim().isEmpty
                              ? 'NextGen Traveler'
                              : _nameController.text.trim(),
                          style: const TextStyle(
                            color: Colors.white,
                            fontWeight: FontWeight.w900,
                            fontSize: 28,
                          ),
                        ),
                        const SizedBox(height: 4),
                        Text(
                          _emailController.text.trim().isEmpty
                              ? 'Add your contact details and preferences'
                              : _emailController.text.trim(),
                          style: const TextStyle(
                            color: Colors.white70,
                            fontSize: 13,
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
          SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(20, 20, 20, 120),
              child: Column(
                children: [
                  _buildIdentityCard(profile),
                  const SizedBox(height: 20),
                  _buildSectionCard(
                    title: 'Personal Details',
                    subtitle:
                        'Keep your travel identity complete for faster booking.',
                    child: Column(
                      children: [
                        _buildTextField(
                          controller: _nameController,
                          label: 'Full name',
                          icon: Icons.person_outline_rounded,
                        ),
                        const SizedBox(height: 16),
                        _buildTextField(
                          controller: _emailController,
                          label: 'Email',
                          icon: Icons.alternate_email_rounded,
                          keyboardType: TextInputType.emailAddress,
                        ),
                        const SizedBox(height: 16),
                        _buildTextField(
                          controller: _phoneController,
                          label: 'Phone number',
                          icon: Icons.phone_android_rounded,
                          keyboardType: TextInputType.phone,
                        ),
                        const SizedBox(height: 16),
                        Row(
                          children: [
                            Expanded(
                              child: _buildTextField(
                                controller: _ageController,
                                label: 'Age',
                                icon: Icons.cake_outlined,
                                keyboardType: TextInputType.number,
                              ),
                            ),
                            const SizedBox(width: 16),
                            Expanded(
                              child: _buildTextField(
                                controller: _nidaController,
                                label: 'NIDA number',
                                icon: Icons.badge_outlined,
                                keyboardType: TextInputType.number,
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 20),
                  _buildSectionCard(
                    title: 'Favorites & Preferences',
                    subtitle:
                        'Customize routes, coach style, and language for this user.',
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            const Text(
                              'Favorite routes',
                              style: TextStyle(
                                color: AppColors.textPrimary,
                                fontWeight: FontWeight.w800,
                              ),
                            ),
                            const Spacer(),
                            TextButton.icon(
                              onPressed: _showFavoriteRouteSheet,
                              icon: const Icon(Icons.add_rounded, size: 18),
                              label: const Text('Add'),
                            ),
                          ],
                        ),
                        Wrap(
                          spacing: 8,
                          runSpacing: 8,
                          children: _favoriteRoutes
                              .map(
                                (route) => Chip(
                                  label: Text(route),
                                  deleteIcon: const Icon(Icons.close, size: 18),
                                  onDeleted: () {
                                    setState(() {
                                      _favoriteRoutes.remove(route);
                                    });
                                  },
                                ),
                              )
                              .toList(),
                        ),
                        const SizedBox(height: 20),
                        _buildDropdownField(
                          label: 'Preferred language',
                          value: _selectedLanguage,
                          items: _languages,
                          onChanged: (value) {
                            if (value == null) {
                              return;
                            }
                            setState(() => _selectedLanguage = value);
                          },
                        ),
                        const SizedBox(height: 16),
                        _buildDropdownField(
                          label: 'Preferred coach category',
                          value: _selectedCoachClass,
                          items: _coachClasses,
                          onChanged: (value) {
                            if (value == null) {
                              return;
                            }
                            setState(() => _selectedCoachClass = value);
                          },
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 20),
                  _buildSectionCard(
                    title: 'Advanced Controls',
                    subtitle:
                        'Security and live-journey settings stored for this user.',
                    child: Column(
                      children: [
                        Container(
                          width: double.infinity,
                          padding: const EdgeInsets.all(16),
                          decoration: BoxDecoration(
                            color: AppColors.background,
                            borderRadius: BorderRadius.circular(18),
                          ),
                          child: const Row(
                            children: [
                              Icon(
                                Icons.timer_off_rounded,
                                color: AppColors.primary,
                              ),
                              SizedBox(width: 12),
                              Expanded(
                                child: Text(
                                  'Automatic logout is enabled after 2 minutes of inactivity.',
                                  style: TextStyle(
                                    color: AppColors.textPrimary,
                                    fontWeight: FontWeight.w700,
                                    height: 1.4,
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ),
                        const Divider(height: 24),
                        _buildSwitchTile(
                          icon: Icons.notifications_active_outlined,
                          title: 'Travel alerts',
                          subtitle:
                              'Keep departure and reminder notifications on.',
                          value: _travelAlertsEnabled,
                          onChanged: (value) {
                            setState(() => _travelAlertsEnabled = value);
                          },
                        ),
                        const Divider(height: 24),
                        _buildSwitchTile(
                          icon: Icons.fingerprint_rounded,
                          title: 'Biometric ticket lock',
                          subtitle:
                              'Add an extra privacy layer before showing tickets.',
                          value: _biometricLockEnabled,
                          onChanged: (value) {
                            setState(() => _biometricLockEnabled = value);
                          },
                        ),
                        const Divider(height: 24),
                        _buildSwitchTile(
                          icon: Icons.share_location_rounded,
                          title: 'Share live trip status',
                          subtitle:
                              'Allow live trip details to be available inside tracking.',
                          value: _shareLiveTripEnabled,
                          onChanged: (value) {
                            setState(() => _shareLiveTripEnabled = value);
                          },
                        ),
                        const Divider(height: 24),
                        SizedBox(
                          width: double.infinity,
                          child: OutlinedButton.icon(
                            onPressed: _isSaving ? null : _confirmLogout,
                            style: OutlinedButton.styleFrom(
                              foregroundColor: AppColors.error,
                              side: const BorderSide(color: AppColors.error),
                              minimumSize: const Size.fromHeight(52),
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(18),
                              ),
                            ),
                            icon: const Icon(Icons.logout_rounded),
                            label: const Text(
                              'LOG OUT NOW',
                              style: TextStyle(fontWeight: FontWeight.w800),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
      bottomNavigationBar: SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
          child: Container(
            decoration: BoxDecoration(
              gradient: AppColors.primaryGradient,
              borderRadius: BorderRadius.circular(22),
              boxShadow: AppColors.premiumShadow,
            ),
            child: ElevatedButton(
              onPressed: _isSaving ? null : _saveProfile,
              style: ElevatedButton.styleFrom(
                backgroundColor: Colors.transparent,
                shadowColor: Colors.transparent,
                minimumSize: const Size.fromHeight(60),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(22),
                ),
              ),
              child: _isSaving
                  ? const SizedBox(
                      height: 24,
                      width: 24,
                      child: CircularProgressIndicator(
                        color: Colors.white,
                        strokeWidth: 2.4,
                      ),
                    )
                  : const Text(
                      'SAVE PROFILE',
                      style: TextStyle(
                        color: Colors.white,
                        fontWeight: FontWeight.w900,
                        letterSpacing: 1,
                      ),
                    ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildIdentityCard(UserProfileDetails profile) {
    return Container(
      padding: const EdgeInsets.all(24),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(28),
        boxShadow: AppColors.softShadow,
      ),
      child: Column(
        children: [
          Stack(
            children: [
              CircleAvatar(
                radius: 42,
                backgroundColor: AppColors.primary.withAlpha(30),
                backgroundImage: _avatarPath.isNotEmpty
                    ? FileImage(File(_avatarPath))
                    : null,
                child: _avatarPath.isEmpty
                    ? Text(
                        profile.initials,
                        style: const TextStyle(
                          color: AppColors.primary,
                          fontWeight: FontWeight.w900,
                          fontSize: 26,
                        ),
                      )
                    : null,
              ),
              Positioned(
                right: -4,
                bottom: -4,
                child: Material(
                  color: AppColors.accent,
                  shape: const CircleBorder(),
                  child: InkWell(
                    customBorder: const CircleBorder(),
                    onTap: _pickAvatar,
                    child: const Padding(
                      padding: EdgeInsets.all(8),
                      child: Icon(Icons.camera_alt_rounded,
                          color: Colors.white, size: 18),
                    ),
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 16),
          Text(
            _nameController.text.trim().isEmpty
                ? 'Traveler profile'
                : _nameController.text.trim(),
            style: const TextStyle(
              color: AppColors.textPrimary,
              fontWeight: FontWeight.w900,
              fontSize: 20,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            'Updated ${DateFormat('dd MMM yyyy, hh:mm a').format(_lastUpdated)}',
            style: const TextStyle(
              color: AppColors.textSecondary,
              fontSize: 12,
            ),
          ),
          const SizedBox(height: 18),
          Row(
            children: [
              Expanded(
                child: _buildStatTile(
                  label: 'Favorites',
                  value: _favoriteRoutes.length.toString(),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: _buildStatTile(
                  label: 'Language',
                  value: _selectedLanguage,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: _buildStatTile(
                  label: 'Coach',
                  value: _selectedCoachClass.split(' ').first,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildStatTile({required String label, required String value}) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 14),
      decoration: BoxDecoration(
        color: AppColors.background,
        borderRadius: BorderRadius.circular(18),
      ),
      child: Column(
        children: [
          Text(
            value,
            textAlign: TextAlign.center,
            style: const TextStyle(
              color: AppColors.textPrimary,
              fontWeight: FontWeight.w900,
              fontSize: 14,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            label,
            style: const TextStyle(
              color: AppColors.textSecondary,
              fontSize: 11,
              fontWeight: FontWeight.w600,
            ),
          ),
        ],
      ),
    );
  }

  Widget _buildSectionCard({
    required String title,
    required String subtitle,
    required Widget child,
  }) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(22),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(28),
        boxShadow: AppColors.softShadow,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            style: const TextStyle(
              fontSize: 18,
              fontWeight: FontWeight.w900,
              color: AppColors.textPrimary,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            subtitle,
            style: const TextStyle(
              color: AppColors.textSecondary,
              fontSize: 13,
              height: 1.4,
            ),
          ),
          const SizedBox(height: 20),
          child,
        ],
      ),
    );
  }

  Widget _buildTextField({
    required TextEditingController controller,
    required String label,
    required IconData icon,
    TextInputType keyboardType = TextInputType.text,
  }) {
    return TextField(
      controller: controller,
      keyboardType: keyboardType,
      decoration: InputDecoration(
        labelText: label,
        prefixIcon: Icon(icon, color: AppColors.primary),
        filled: true,
        fillColor: AppColors.background,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(18),
          borderSide: BorderSide.none,
        ),
      ),
    );
  }

  Widget _buildDropdownField({
    required String label,
    required String value,
    required List<String> items,
    required ValueChanged<String?> onChanged,
  }) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16),
      decoration: BoxDecoration(
        color: AppColors.background,
        borderRadius: BorderRadius.circular(18),
      ),
      child: DropdownButtonHideUnderline(
        child: DropdownButton<String>(
          value: value,
          isExpanded: true,
          onChanged: onChanged,
          items: items
              .map(
                (item) => DropdownMenuItem<String>(
                  value: item,
                  child: Text(item),
                ),
              )
              .toList(),
        ),
      ),
    );
  }

  Widget _buildSwitchTile({
    required IconData icon,
    required String title,
    required String subtitle,
    required bool value,
    required ValueChanged<bool> onChanged,
  }) {
    return Row(
      children: [
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: AppColors.primary.withAlpha(24),
            borderRadius: BorderRadius.circular(16),
          ),
          child: Icon(icon, color: AppColors.primary),
        ),
        const SizedBox(width: 16),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                title,
                style: const TextStyle(
                  color: AppColors.textPrimary,
                  fontWeight: FontWeight.w800,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                subtitle,
                style: const TextStyle(
                  color: AppColors.textSecondary,
                  fontSize: 12,
                  height: 1.35,
                ),
              ),
            ],
          ),
        ),
        Switch(
          value: value,
          activeThumbColor: AppColors.primary,
          onChanged: onChanged,
        ),
      ],
    );
  }
}
