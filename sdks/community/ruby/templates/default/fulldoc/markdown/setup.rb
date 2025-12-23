# frozen_string_literal: true

require "set"
require "rdoc"

include Helpers::ModuleHelper

TARGET_PAGES = {
  "AgUiProtocol::Core::Events" => {
    path: "core/events",
    title: "Events",
    document_title: "Events",
    description: "Documentation for the events used in the Agent User Interaction Protocol (Ruby SDK)"
  },
  "AgUiProtocol::Core::Types" => {
    path: "core/types",
    title: "Types",
    document_title: "Core Types",
    description: "Documentation for the core types used in the Agent User Interaction Protocol (Ruby SDK)"
  },
  "AgUiProtocol::Encoder" => {
    path: "encoder/overview",
    title: "Overview",
    document_title: "Event Encoder",
    description: "Documentation for encoding Agent User Interaction Protocol events (Ruby SDK)"
  }
}.freeze

def init
  define_custom_tags

  options.objects = objects = run_verifier(options.objects)

  options.delete(:objects)
  options.delete(:files)

  options.serializer.extension = "mdx"

  install_target_page_paths

  objects.each do |object|
    next if object.name == :root
    next unless TARGET_PAGES.key?(object.path)

    begin
      Templates::Engine.with_serializer(object, options.serializer) { serialize(object) }
    rescue => e
      path = options.serializer.serialized_path(object)
      log.error "Exception occurred while generating '#{path}'"
      log.backtrace(e)
    end
  end
end

def define_custom_tags
  return unless defined?(YARD::Tags::Library)

  begin
    YARD::Tags::Library.define_tag("Category", :category)
    YARD::Tags::Library.define_tag("Document Title", :document_title)
  rescue
    nil
  end
end

def install_target_page_paths
  target_pages = TARGET_PAGES
  extension = options.serializer.extension

  serializer = options.serializer
  return if serializer.respond_to?(:__ag_ui_target_pages)

  class << serializer
    attr_accessor :__ag_ui_target_pages, :__ag_ui_extension

    alias_method :__ag_ui_original_serialized_path, :serialized_path

    def serialized_path(object)
      if __ag_ui_target_pages && (cfg = __ag_ui_target_pages[object.path])
        "#{cfg[:path]}.#{__ag_ui_extension}"
      else
        __ag_ui_original_serialized_path(object)
      end
    end
  end

  serializer.__ag_ui_target_pages = target_pages
  serializer.__ag_ui_extension = extension
end

def frontmatter(title:, description:)
  <<~MDX
    ---
    title: "#{title}"
    description: "#{description}"
    ---

  MDX
end

def target_page_cfg(path)
  TARGET_PAGES.fetch(path)
end

def page_header(out, path)
  cfg = target_page_cfg(path)
  out << frontmatter(title: cfg.fetch(:title), description: cfg.fetch(:description))
  out << "# #{cfg.fetch(:document_title)}\n\n"
end

def append_doc(out, docstring)
  doc = rdoc_to_md(docstring).to_s.strip
  out << "#{doc}\n\n" unless doc.empty?
end

def append_tags(out, object)
  tags = render_tags(object).to_s.strip
  out << "#{tags}\n\n" unless tags.empty?
end

def inline_code(value)
  "`#{value}`"
end

def initializer_method(object)
  method_object = Registry.at("#{object.path}#initialize")
  return method_object if method_object

  if object.respond_to?(:meths)
    object.meths(inherited: false, included: false).find do |m|
      m.scope == :instance && m.name(false).to_s == "initialize"
    end
  end
end

def initializer_param_tags(object)
  method_object = initializer_method(object)
  return [] unless method_object

  tags = method_object.tags.select { |t| t.tag_name == "param" }
  return tags unless tags.empty?

  file = method_object.respond_to?(:file) ? method_object.file : nil
  line = method_object.respond_to?(:line) ? method_object.line : nil
  return [] if file.nil? || line.nil?

  parse_param_tags_from_source(file, line)
end

def parse_param_tags_from_source(file, line)
  return [] unless File.file?(file)

  lines = File.readlines(file)
  start_idx = [line.to_i - 2, lines.size - 1].min
  return [] if start_idx < 0

  search_window = 120
  first_param_idx = nil

  idx = start_idx
  min_idx = [0, start_idx - search_window].max
  while idx >= min_idx
    stripped = lines[idx].to_s.strip
    if stripped.match?(/^#\s*@param\b/)
      first_param_idx = idx
      break
    end
    idx -= 1
  end

  return [] unless first_param_idx

  collected = []
  idx = first_param_idx
  while idx >= 0
    raw = lines[idx]
    break unless raw

    stripped = raw.strip
    break unless stripped.start_with?("#") || stripped.empty?

    if (m = stripped.match(/^#\s*@param\s+(\w+)\s*(\[[^\]]+\])?\s*(.*)$/))
      name = m[1]
      type_part = m[2].to_s
      text = m[3].to_s.strip
      types = type_part.gsub(/\A\[|\]\z/, "").split(/\s*\|\s*|\s*,\s*/).reject(&:empty?)
      collected << { name: name, types: types, text: text }
    end

    idx -= 1
  end

  collected.reverse
end

def param_tag_name(tag)
  tag.respond_to?(:name) ? tag.name : tag[:name]
end

def param_tag_types(tag)
  tag.respond_to?(:types) ? tag.types : tag[:types]
end

def param_tag_text(tag)
  tag.respond_to?(:text) ? tag.text : tag[:text]
end

def normalize_param_name(name)
  name.to_s.strip.sub(/:\z/, "").sub(/\A\*\*?/, "")
end

def initializer_param_defaults(object)
  method_object = initializer_method(object)
  return {} unless method_object && method_object.respond_to?(:parameters)

  defaults = {}
  method_object.parameters.each do |param|
    if param.is_a?(Array)
      raw_name = param[0]
      default = param[1]
      next if default.nil?

      defaults[normalize_param_name(raw_name)] = default.to_s
    else
      str = param.to_s
      next unless str.include?("=")

      raw_name, default = str.split("=", 2)
      defaults[normalize_param_name(raw_name)] = default.to_s.strip
    end
  end

  defaults
end

def optional_param?(types:, default: nil)
  return true if default
  return false unless types && types.any?

  types.any? do |t|
    v = t.to_s.strip
    v == "nil" || v == "NilClass" || v.end_with?("nil")
  end
end

def heading(level, text)
  ("#" * level) + " " + text + "\n\n"
end

def type_reference_paths_from_param_types(type_values, types_namespace_path)
  refs = []
  Array(type_values).each do |raw|
    raw.to_s
      .split(/\||,/)
      .map(&:strip)
      .reject(&:empty?)
      .each do |t|
        next if t == "nil" || t == "NilClass"

        clean = t.gsub(/\AArray<|\AHash<|\A\{|\}\z|\A\[|\]\z/, "")
        clean = clean.gsub(/\AArray\(|\)\z/, "")
        clean = clean.split(/\s+/).first.to_s
        next if clean.empty?

        if clean.include?("::")
          refs << clean
        else
          refs << "#{types_namespace_path}::#{clean}"
        end
      end
  end

  refs.uniq
end

def referenced_types_for(object, types_namespace_path)
  tags = initializer_param_tags(object)
  return [] if tags.empty?

  type_values = tags.flat_map { |t| Array(param_tag_types(t)).map { |v| v.to_s.strip } }
  paths = type_reference_paths_from_param_types(type_values, types_namespace_path)
  paths
    .map { |p| Registry.at(p) }
    .compact
    .select { |o| o.respond_to?(:path) && o.path.start_with?(types_namespace_path + "::") }
end

def category_for(object)
  direct = category_value_from_object(object)
  return direct unless direct.nil?

  ns = object.respond_to?(:namespace) ? object.namespace : nil
  while ns && ns.respond_to?(:path) && ns.path.to_s != "root"
    inherited = category_value_from_object(ns)
    return inherited unless inherited.nil?
    ns = ns.respond_to?(:namespace) ? ns.namespace : nil
  end

  if object.respond_to?(:inheritance_tree)
    object.inheritance_tree(true).each do |ancestor|
      next if ancestor == object
      next unless ancestor.respond_to?(:path)
      next if ancestor.path.to_s == "root"

      inherited = category_value_from_object(ancestor)
      return inherited unless inherited.nil?
    end
  end

  nil
end

def category_value_from_object(object)
  tags = safe_tags(object)
  tag = tags.find { |t| t.tag_name == "category" }
  value = tag&.text.to_s.strip
  return value unless value.to_s.empty?

  file = object.respond_to?(:file) ? object.file : nil
  line = object.respond_to?(:line) ? object.line : nil
  return nil if file.nil? || line.nil?

  parse_category_from_source(file, line)
end

def safe_tags(object)
  object.tags
rescue
  []
end

def parse_category_from_source(file, line)
  return nil unless File.file?(file)

  block = doc_comment_block_for_line(file, line)
  block.each do |stripped|
    if (m = stripped.match(/^#\s*@category\s+(.+)$/))
      value = m[1].to_s.strip
      return value unless value.empty?
      return nil
    end
  end

  nil
end

def doc_comment_block_for_line(file, line)
  return [] unless File.file?(file)

  lines = File.readlines(file)
  idx = [line.to_i - 2, lines.size - 1].min
  return [] if idx < 0

  block = []
  while idx >= 0
    raw = lines[idx]
    break unless raw

    stripped = raw.strip
    break unless stripped.start_with?("#") || stripped.empty?

    block << stripped
    idx -= 1
  end

  block.reverse
end

def render_type_object(out, object, heading_level:, types_namespace_path:, rendered:, top_level_paths:, category_children:, category_parent_path_by_title:)
  return if rendered.include?(object.path)

  rendered << object.path

  out << heading(heading_level, object.name.to_s)
  out << "#{inline_code(object.path)}\n\n"

  append_doc(out, object.docstring)
  append_tags(out, object)

  table = render_params_table_for(object)
  out << table unless table.empty?

  Array(category_children[object.path])
    .sort_by { |o| o.name.to_s }
    .each do |child|
      next if child.path == object.path
      next if %w[Model BaseMessage].include?(child.name.to_s)

      next_level = [heading_level + 1, 4].min
      render_type_object(
        out,
        child,
        heading_level: next_level,
        types_namespace_path: types_namespace_path,
        rendered: rendered,
        top_level_paths: top_level_paths,
        category_children: category_children,
        category_parent_path_by_title: category_parent_path_by_title,
      )
    end

  referenced = referenced_types_for(object, types_namespace_path)
  parent_category = category_for(object)
  referenced.each do |child|
    next if child.path == object.path
    next if %w[Model BaseMessage].include?(child.name.to_s)
    next if top_level_paths.include?(child.path)

    child_own_category = category_for(child)
    if child_own_category && !child_own_category.to_s.strip.empty?
      nesting_parent_path = category_parent_path_by_title[child_own_category.to_s.strip]
      if nesting_parent_path
        next if nesting_parent_path != object.path
      else
        next
      end
    end

    child_category = category_for(child)
    next if parent_category && child_category && parent_category != child_category

    next_level = [heading_level + 1, 4].min
    render_type_object(
      out,
      child,
      heading_level: next_level,
      types_namespace_path: types_namespace_path,
      rendered: rendered,
      top_level_paths: top_level_paths,
      category_children: category_children,
      category_parent_path_by_title: category_parent_path_by_title,
    )
  end
end

def render_params_table_for(object)
  tags = initializer_param_tags(object)
  return "" if tags.empty?

  defaults = initializer_param_defaults(object)

  headers = ["Property", "Type", "Description"]
  rows = []

  tags.each do |t|
    name = normalize_param_name(param_tag_name(t))

    types = param_tag_types(t)
    type_values = (types || []).map { |v| v.to_s.strip }
    non_nil_types = type_values.reject { |v| v == "nil" || v == "NilClass" }
    display_types = non_nil_types.empty? ? type_values : non_nil_types

    is_optional = optional_param?(types: type_values, default: defaults[name])
    type = display_types.any? ? "`#{display_types.join(" , ")}`" : ""
    type = "#{type} (optional)" if is_optional
    desc = param_tag_text(t).to_s.strip

    default = defaults[name]
    if default && !default.empty?
      suffix = ", Default: `#{default}`."
      desc = desc.empty? ? suffix : "#{desc} #{suffix}".strip
    end

    prop_cell = "`#{name}`"
    type_cell = type.to_s
    desc_cell = desc.to_s

    [prop_cell, type_cell, desc_cell].each_with_index do |val, idx|
      v = val.to_s
      v = v.gsub("|", "\\|")
      v = v.gsub("\n", "<br />")
      case idx
      when 0 then prop_cell = v
      when 1 then type_cell = v
      when 2 then desc_cell = v
      end
    end

    rows << [prop_cell, type_cell, desc_cell]
  end

  widths = headers.each_index.map do |i|
    ([headers[i]] + rows.map { |r| r[i].to_s }).map { |v| v.length }.max
  end

  widths = widths.map { |w| [w, 3].max }

  out = +"| #{headers[0].ljust(widths[0])} | #{headers[1].ljust(widths[1])} | #{headers[2].ljust(widths[2])} |\n"
  out << "| #{("-" * widths[0])} | #{("-" * widths[1])} | #{("-" * widths[2])} |\n"
  rows.each do |r|
    out << "| #{r[0].ljust(widths[0])} | #{r[1].ljust(widths[1])} | #{r[2].ljust(widths[2])} |\n"
  end
  out << "\n"
  out
end

def locate_method_line_in_file(file, method_name)
  return nil unless File.file?(file)

  lines = File.readlines(file)
  rx = /^\s*def\s+#{Regexp.escape(method_name)}(\b|\s*\(|\s*$)/
  idx = lines.find_index { |l| l.to_s.match?(rx) }
  idx ? (idx + 1) : nil
rescue
  nil
end

def method_source_location(method_object, owner: nil)
  file = method_object.respond_to?(:file) ? method_object.file : nil
  line = method_object.respond_to?(:line) ? method_object.line : nil

  if (file.nil? || line.nil?) && owner
    ofile = owner.respond_to?(:file) ? owner.file : nil
    if ofile && File.file?(ofile)
      file ||= ofile
      line ||= locate_method_line_in_file(ofile, method_object.name(false).to_s)
    end
  end

  [file, line]
end

def method_param_tags(method_object, owner: nil)
  tags = method_object.tags.select { |t| t.tag_name == "param" }
  return tags unless tags.empty?

  file, line = method_source_location(method_object, owner: owner)
  return [] if file.nil? || line.nil?

  parsed = parse_method_doc_from_source(file, line)
  parsed.fetch(:params, [])
rescue
  []
end

def method_return_tag(method_object, owner: nil)
  tag = method_object.tags.find { |t| t.tag_name == "return" }
  return tag if tag

  file, line = method_source_location(method_object, owner: owner)
  return nil if file.nil? || line.nil?

  parsed = parse_method_doc_from_source(file, line)
  parsed[:return]
rescue
  nil
end

def method_description_from_source(method_object, owner: nil)
  file, line = method_source_location(method_object, owner: owner)
  return "" if file.nil? || line.nil?

  parsed = parse_method_doc_from_source(file, line)
  parsed.fetch(:description, "").to_s.strip
rescue
  ""
end

def return_tag_types(tag)
  if tag.respond_to?(:types)
    tag.types
  else
    tag[:types]
  end
end

def return_tag_text(tag)
  if tag.respond_to?(:text)
    tag.text
  else
    tag[:text]
  end
end

def parse_method_doc_from_source(file, line)
  return { description: "", params: [], return: nil } unless File.file?(file)

  lines = File.readlines(file)
  idx = [line.to_i - 2, lines.size - 1].min
  return { description: "", params: [], return: nil } if idx < 0

  collected = []
  scanned = 0
  max_scan = 80

  while idx >= 0 && scanned < max_scan
    scanned += 1
    raw = lines[idx]
    break unless raw

    stripped = raw.strip

    if stripped.start_with?("#") || stripped.empty?
      collected << stripped
      idx -= 1
      next
    end

    if stripped.start_with?("sig") || stripped == "end" || stripped.include?("params(") || stripped.include?("returns(") || stripped.end_with?(".void") || stripped.include?("T.nilable")
      idx -= 1
      next
    end

    break
  end

  block = collected.reverse

  desc_lines = []
  params = []
  return_tag = nil

  block.each do |str|
    next unless str.start_with?("#")
    s = str.sub(/^#\s?/, "").rstrip

    if (m = s.match(/^@param\s+(\w+)\s*(\[[^\]]+\])?\s*(.*)$/))
      name = m[1]
      type_part = m[2].to_s
      text = m[3].to_s.strip
      types = type_part.gsub(/\A\[|\]\z/, "").split(/\s*\|\s*|\s*,\s*/).reject(&:empty?)
      params << { name: name, types: types, text: text }
      next
    end

    if (m = s.match(/^@return\s*(\[[^\]]+\])?\s*(.*)$/))
      type_part = m[1].to_s
      text = m[2].to_s.strip
      types = type_part.gsub(/\A\[|\]\z/, "").split(/\s*\|\s*|\s*,\s*/).reject(&:empty?)
      return_tag = { types: types, text: text }
      next
    end

    next if s.start_with?("@")
    desc_lines << s
  end

  description = desc_lines.join("\n").strip

  { description: description, params: params, return: return_tag }
end

def method_signature_for(method_object, owner: nil)
  name = method_object.name(false).to_s
  tags = method_param_tags(method_object, owner: owner)
  params = tags.map { |t| normalize_param_name(param_tag_name(t)) }.join(", ")
  sig = params.empty? ? name : "#{name}(#{params})"

  return sig if name == "initialize"

  sig
end

def render_params_table_for_method(method_object, owner: nil)
  tags = method_param_tags(method_object, owner: owner)
  return "" if tags.empty?

  headers = ["Parameter", "Type", "Description"]
  rows = []

  tags.each do |t|
    name = normalize_param_name(param_tag_name(t))

    types = param_tag_types(t)
    type_values = (types || []).map { |v| v.to_s.strip }
    non_nil_types = type_values.reject { |v| v == "nil" || v == "NilClass" }
    display_types = non_nil_types.empty? ? type_values : non_nil_types

    is_optional = optional_param?(types: type_values, default: nil)
    type = display_types.any? ? "`#{display_types.join(" , ")}`" : ""
    type = "#{type} (optional)" if is_optional
    desc = param_tag_text(t).to_s.strip

    rows << ["`#{name}`", type.to_s, desc.to_s]
  end

  widths = headers.each_index.map do |i|
    ([headers[i]] + rows.map { |r| r[i].to_s }).map { |v| v.length }.max
  end
  widths = widths.map { |w| [w, 3].max }

  out = +"| #{headers[0].ljust(widths[0])} | #{headers[1].ljust(widths[1])} | #{headers[2].ljust(widths[2])} |\n"
  out << "| #{("-" * widths[0])} | #{("-" * widths[1])} | #{("-" * widths[2])} |\n"
  rows.each do |r|
    out << "| #{r[0].ljust(widths[0])} | #{r[1].ljust(widths[1])} | #{r[2].ljust(widths[2])} |\n"
  end
  out << "\n"
  out
end

def render_returns_for_method(method_object, owner: nil)
  return "" if method_object.name(false).to_s == "initialize"

  tag = method_return_tag(method_object, owner: owner)
  return "" unless tag

  text = return_tag_text(tag).to_s.strip
  types = Array(return_tag_types(tag)).map { |t| t.to_s.strip }.reject(&:empty?)
  type_str = types.any? ? "`#{types.join(" | ")}`" : ""

  payload = [type_str, text].reject { |v| v.to_s.strip.empty? }.join(": ")
  payload = type_str if payload.to_s.strip.empty?
  return "" if payload.to_s.strip.empty?

  "**Returns**: #{payload}\n\n"
end

def extract_virtual_sections(markdown)
  lines = markdown.to_s.split("\n")
  preamble = []
  sections = {}
  order = []

  current_title = nil
  current_lines = []

  flush = lambda do
    if current_title
      sections[current_title] = current_lines.join("\n").strip
      order << current_title
    else
      preamble.concat(current_lines)
    end
    current_lines = []
  end

  lines.each do |line|
    if (m = line.match(/^##\s+(.+)\s*$/))
      flush.call
      current_title = m[1].to_s.strip
      next
    end

    current_lines << line
  end

  flush.call

  [preamble.join("\n").strip, sections, order]
end

def serialize(object)
  case object.path
  when "AgUiProtocol::Core::Events"
    serialize_events_page
  when "AgUiProtocol::Core::Types"
    serialize_types_page
  when "AgUiProtocol::Encoder"
    serialize_encoder_page
  else
    ""
  end
end

def serialize_events_page
  events_module = Registry.at("AgUiProtocol::Core::Events")
  event_type_module = Registry.at("AgUiProtocol::Core::Events::EventType")
  base_event = Registry.at("AgUiProtocol::Core::Events::BaseEvent")

  out = +""
  page_header(out, "AgUiProtocol::Core::Events")
  return out unless events_module

  module_doc = rdoc_to_md(events_module.docstring).to_s.strip
  preamble_doc, section_docs, section_order = extract_virtual_sections(module_doc)
  out << "#{preamble_doc}\n\n" unless preamble_doc.empty?

  classes = events_module.children.grep(CodeObjects::ClassObject)
  classes = classes.reject { |c| c.path == "AgUiProtocol::Core::Events::BaseEvent" }

  lifecycle = classes.select { |c| c.name.to_s.start_with?("Run", "Step") }
  text = classes.select { |c| c.name.to_s.start_with?("TextMessage", "Thinking") }
  tool = classes.select { |c| c.name.to_s.start_with?("ToolCall") }
  state = classes.select { |c| c.name.to_s.start_with?("State", "Messages", "Activity") }
  special = classes.select { |c| c.name.to_s.start_with?("Raw", "Custom") }

  if event_type_module
    out << "## EventType\n\n"
    out << "#{inline_code(event_type_module.path)}\n\n"
    append_doc(out, event_type_module.docstring)

    constants = event_type_module.constants(included: false, inherited: false)
    if constants.any?
      out << "```ruby\n"
      constants.sort_by { |c| c.name(false).to_s }.each do |c|
        out << "#{event_type_module.path}::#{c.name(false)}\n"
      end
      out << "```\n\n"
    end
  end

  if base_event
    out << "## BaseEvent\n\n"
    out << "#{inline_code(base_event.path)}\n\n"
    append_doc(out, base_event.docstring)
    append_tags(out, base_event)

    table = render_params_table_for(base_event)
    out << table unless table.empty?
  end

  groups = [
    ["Lifecycle Events", lifecycle],
    ["Text Message Events", text],
    ["Tool Call Events", tool],
    ["State Management Events", state],
    ["Special Events", special]
  ]

  groups_by_title = groups.to_h
  ordered_group_titles = []
  section_order.each do |title|
    next unless groups_by_title.key?(title)
    ordered_group_titles << title
  end
  (groups_by_title.keys - ordered_group_titles).each { |t| ordered_group_titles << t }

  ordered_group_titles.each do |title|
    list = groups_by_title[title]
    next if list.empty?

    out << "## #{title}\n\n"

    section_doc = section_docs[title].to_s.strip
    out << "#{section_doc}\n\n" unless section_doc.empty?

    list.sort_by { |c| c.name.to_s }.each do |klass|
      out << "### #{klass.name}\n\n"
      out << "#{inline_code(klass.path)}\n\n"

      append_doc(out, klass.docstring)
      append_tags(out, klass)

      table = render_params_table_for(klass)
      out << table unless table.empty?
    end
  end

  out
end

def serialize_types_page
  types_module = Registry.at("AgUiProtocol::Core::Types")
  out = +""
  page_header(out, "AgUiProtocol::Core::Types")
  document_title = target_page_cfg("AgUiProtocol::Core::Types").fetch(:document_title).to_s
  return out unless types_module

  types_doc = rdoc_to_md(types_module.docstring).to_s.strip
  preamble_doc, section_docs, section_order = extract_virtual_sections(types_doc)
  out << "#{preamble_doc}\n\n" unless preamble_doc.empty?

  children = types_module.children
  types_namespace_path = types_module.path

  all = children
    .grep(CodeObjects::Base)
    .reject { |o| ["Model", "BaseMessage"].include?(o.name.to_s) }

  rendered = Set.new

  top_level_paths = Set.new(all.map(&:path))

  category_parent_path_by_title = {}
  all.each do |obj|
    name_title = obj.name.to_s.strip
    category_parent_path_by_title[name_title] = obj.path unless name_title.empty?
  end

  category_children = Hash.new { |h, k| h[k] = [] }

  categories_in_order = []
  grouped = Hash.new { |h, k| h[k] = [] }
  root_bucket = "__root__"

  all.each do |obj|
    category = category_for(obj)

    category_str = category.to_s.strip

    if !category_str.empty?
      nesting_parent_path = category_parent_path_by_title[category_str]
      if nesting_parent_path
        category_children[nesting_parent_path] << obj
        next
      end
    end

    key = if category_str.empty? || category_str == document_title
      root_bucket
    else
      category_str
    end

    if !grouped.key?(key)
      categories_in_order << key
    elsif !categories_in_order.include?(key)
      categories_in_order << key
    end

    grouped[key] << obj
  end

  ordered_keys = []
  ordered_keys << root_bucket if grouped.key?(root_bucket) && grouped[root_bucket].any?
  section_order.each do |title|
    next unless grouped.key?(title)
    next if ordered_keys.include?(title)
    ordered_keys << title
  end
  (grouped.keys - ordered_keys).sort.each { |k| ordered_keys << k }

  ordered_keys.each do |key|
    list = grouped[key]
    next if list.empty?

    out << heading(2, key) unless key == root_bucket

    if key != root_bucket
      section_doc = section_docs[key].to_s.strip
      out << "#{section_doc}\n\n" unless section_doc.empty?
    end

    base_level = key == root_bucket ? 2 : 3

    list
      .sort_by { |o| o.name.to_s }
      .each do |obj|
        render_type_object(
          out,
          obj,
          heading_level: base_level,
          types_namespace_path: types_namespace_path,
          rendered: rendered,
          top_level_paths: top_level_paths,
          category_children: category_children,
          category_parent_path_by_title: category_parent_path_by_title,
        )
      end
  end

  out << "## State\n\n"
  out << "`State` is represented as `Any`.\n\n"
  out << "The state type is flexible and can hold any data structure needed by the agent implementation.\n"

  out
end

def serialize_encoder_page
  encoder = Registry.at("AgUiProtocol::Encoder")
  out = +""
  page_header(out, "AgUiProtocol::Encoder")

  if encoder
    append_doc(out, encoder.docstring)
    append_tags(out, encoder)
  end

  if encoder
    encoder.children
      .grep(CodeObjects::ClassObject)
      .sort_by { |c| c.name.to_s }
      .each do |klass|
        out << "## #{klass.name}\n\n"
        out << "#{inline_code(klass.path)}\n\n"

        append_doc(out, klass.docstring)
        append_tags(out, klass)

        out << "### Methods\n\n"

        public_instance_methods(klass).sort_by { |m| m.name.to_s }.each do |m|
          out << "#### `#{method_signature_for(m, owner: klass)}`\n\n"

          mdoc = rdoc_to_md(m.docstring).to_s.strip
          if mdoc.empty?
            fallback_desc = method_description_from_source(m, owner: klass)
            out << "#{fallback_desc}\n\n" unless fallback_desc.empty?
          else
            out << "#{mdoc}\n\n"
          end

          table = render_params_table_for_method(m, owner: klass)
          out << table unless table.empty?

          returns = render_returns_for_method(m, owner: klass)
          out << returns unless returns.empty?
        end
      end
  end

  out
end

##
# Converts rdoc to markdown.
#
# I didn't found a way to detect yard/rdoc docstrings, so we're running docstrings through rdoc to markdown converter in all cases. If it's yard docstring, it doesn't seem to have any negative effect on end results. But absense of bugs, doesn't mean that there are no issues.
#
# @param docstring [String, YARD::Docstring]
# @return [String] markdown formatted string
def rdoc_to_md(docstring)
  RDoc::Markup::ToMarkdown.new.convert(docstring)
end

##
# Formats yard tags belonging to a object.
#
# This is mostly a feature of yard and rdoc doesn't have any of that. Rdoc supports ":nodoc:" and other tags. Yard claims to have full support for rdoc, doesn't really handle tags like ":nodoc:" or anything else from rdoc.
#
# There is an attempt to handle @example tag differently, we surround it with a code block.
#
# @see https://rubydoc.info/gems/yard/file/docs/TagsArch.md
#
# @param object [YARD::CodeObjects::Base]
# @return [String] markdown formatted string of Tags

def render_tags(object)
  result = +""
  examples = []

  object.tags.each do |tag|
    next if %w[attr_reader param document_title].include?(tag.tag_name)

    if tag.tag_name == "example"
      examples << tag
      next
    end

    result << "**@#{tag.tag_name}** [#{tag.types&.join(', ')}] #{tag.text}\n\n"
  end

  examples.each do |tag|
    result << "\n**@#{tag.tag_name}**\n```ruby\n#{tag.text}\n```"
  end

  result
end

def public_method_list(object)
  prune_method_listing(
    object.meths(inherited: false, visibility: [:public]),
    included: false,
  ).sort_by { |m| m.name.to_s }
end

def public_instance_methods(object)
  public_method_list(object).select { |o| o.scope == :instance }
end