require "minitest/reporters"
require "shoulda-context"
require_relative "../lib/ag_ui_protocol"

Minitest::Reporters.use! [Minitest::Reporters::DefaultReporter.new(:color => true)]

require "minitest/autorun"
