// Initial documents for the live-state dojo routes (`shared_state`,
// `predictive_state_updates`).
//
// This is a side registry on purpose: a closure/function cannot live in a field of a
// `const`-constructed EndpointConfig, and `availableEndpoints` is a const list. Top-level
// function references (tear-offs) ARE compile-time constants, so a const map of them is
// fine here. Pages look up `seedStateFns[endpoint.path]?.call()`.

Map<String, dynamic> _defaultRecipe() => {
      'recipe': {
        'title': 'Tomato Pasta',
        'servings': 2,
        'ingredients': [
          {'name': 'pasta', 'amount': '200g'},
          {'name': 'tomatoes', 'amount': '3'},
        ],
        'steps': [
          'Boil a large pot of salted water.',
          'Cook the pasta until al dente.',
        ],
      },
    };

/// Seed-state builders keyed by endpoint path. Each call returns a fresh, mutable
/// document so the page can edit it without aliasing the shared default.
const Map<String, Map<String, dynamic> Function()> seedStateFns = {
  'shared_state': _defaultRecipe,
  'predictive_state_updates': _defaultRecipe,
};
