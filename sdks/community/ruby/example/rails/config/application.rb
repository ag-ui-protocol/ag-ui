require "rails"
require "action_controller/railtie"

module AgUiRailsExample
  class Application < Rails::Application
    config.load_defaults "7.1"
    config.api_only = true

    config.eager_load = false
    config.secret_key_base = ENV.fetch("SECRET_KEY_BASE", "dummy_secret_key_base")
  end
end
