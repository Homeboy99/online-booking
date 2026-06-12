class RoutePricing {
  static const double defaultPrice = 60000;

  static const Map<String, double> _featuredRoutePrices = {
    'Dar es Salaam-Arusha': 45000,
    'Dar es Salaam-Mbeya': 78000,
    'Dar es Salaam-Dodoma': 35000,
    'Dar es Salaam-Singida': 48000,
    'Dar es Salaam-Mwanza': 98000,
    'Dar es Salaam-Tanga': 98000,
    'Dar es Salaam-Mtwara': 48000,
    'Dar es Salaam-Kigoma': 98000,
    'Dar es Salaam-Morogoro': 8000,
    'Dar es Salaam-Kahama': 55000,
    'Dar es Salam-Bukoba': 105000,
  };

  static double priceFor(String from, String to) {
    final directRoute = '$from-$to';
    final reverseRoute = '$to-$from';

    return _featuredRoutePrices[directRoute] ??
        _featuredRoutePrices[reverseRoute] ??
        defaultPrice;
  }
}
