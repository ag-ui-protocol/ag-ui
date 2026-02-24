require "yard"

begin
  require "sorbet-runtime"
rescue LoadError
  nil
end

if defined?(YARD::Tags::Library)
  begin
    YARD::Tags::Library.define_tag("Category", :category)
  rescue
    nil
  end
end

module AgUiProtocolYardExtensions
  module SorbetProxyTagsSilencer
    def tags
      if respond_to?(:path)
        p = path.to_s
        return [] if p == "T" || p == "T::Sig"
      end

      super
    end
  end
end

module AgUiProtocolYardExtensions
  def self.install_sorbet_stubs
    return unless defined?(YARD::Registry)
    return unless defined?(YARD::CodeObjects::ModuleObject)

    begin
      t_mod = YARD::Registry.at("T")
      unless t_mod
        t_mod = YARD::CodeObjects::ModuleObject.new(:root, :T)
        YARD::Registry.register(t_mod)
      end

      sig_mod = YARD::Registry.at("T::Sig")
      unless sig_mod
        sig_mod = YARD::CodeObjects::ModuleObject.new(t_mod, :Sig)
        YARD::Registry.register(sig_mod)
      end
    rescue
      nil
    end
  end
end

AgUiProtocolYardExtensions.install_sorbet_stubs

module AgUiProtocolYardExtensions
  module SorbetSigSilencer
    def process
      src = statement.respond_to?(:source) ? statement.source.to_s.strip : ""
      return if src.start_with?("sig")

      super
    end
  end
end

if defined?(YARD::Handlers::Ruby::DSLHandler)
  YARD::Handlers::Ruby::DSLHandler.prepend(AgUiProtocolYardExtensions::SorbetSigSilencer)
end

if defined?(YARD::CodeObjects::Proxy)
  YARD::CodeObjects::Proxy.prepend(AgUiProtocolYardExtensions::SorbetProxyTagsSilencer)
end
