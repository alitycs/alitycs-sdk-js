#!/usr/bin/env ruby
# frozen_string_literal: true

require "open3"
require "optparse"
require "psych"
require "set"

GIT_ACTION_REFERENCE = /\A[^@\s]+@[0-9a-f]{40}\z/
DOCKER_ACTION_REFERENCE = /\Adocker:\/\/[^@\s]+@sha256:[0-9a-f]{64}\z/
LOCAL_ACTION_REFERENCE = %r{\A\./[^\s]+\z}
WORKFLOW_PATH = %r{\A\.github/workflows/.+\.ya?ml\z}
ACTION_METADATA_PATH = %r{(?:\A|/)action\.ya?ml\z}

options = {}
parser =
  OptionParser.new do |flags|
    flags.banner = "Usage: verify-workflow-pins.rb [--git-ref SHA | --stdin LABEL]"
    flags.on("--git-ref SHA", "Read tracked workflow and action files from this commit") do |value|
      options[:git_ref] = value
    end
    flags.on("--stdin LABEL", "Validate one YAML document read from standard input") do |value|
      options[:stdin] = value
    end
  end
parser.parse!

abort parser.to_s unless ARGV.empty?
if options[:git_ref] && options[:stdin]
  abort "--git-ref and --stdin are mutually exclusive"
end
if options[:git_ref] && !options[:git_ref].match?(/\A[0-9a-f]{40}\z/)
  abort "--git-ref must be a full lowercase commit SHA"
end

def git_output(*arguments)
  stdout, stderr, status = Open3.capture3("git", *arguments)
  return stdout if status.success?

  raise "git #{arguments.first} failed: #{stderr.strip}"
end

def policy_path?(path)
  path.match?(WORKFLOW_PATH) || path.match?(ACTION_METADATA_PATH)
end

def sources_for(options)
  return { options[:stdin] => $stdin.read } if options[:stdin]

  listing =
    if options[:git_ref]
      git_output("ls-tree", "-rz", "--name-only", options[:git_ref])
    else
      git_output("ls-files", "-z")
    end
  paths = listing.split("\0").select { |path| policy_path?(path) }.sort
  raise "no tracked workflow or action metadata files were found" if paths.empty?

  paths.to_h do |path|
    content =
      if options[:git_ref]
        git_output("show", "#{options[:git_ref]}:#{path}")
      else
        File.binread(path)
      end
    [path, content]
  end
end

def register_anchor(node, anchors)
  return unless node.respond_to?(:anchor)
  return if node.is_a?(Psych::Nodes::Alias) || node.anchor.nil?

  anchors[node.anchor] = node
end

def resolve_alias(node, anchors)
  seen = Set.new
  while node.is_a?(Psych::Nodes::Alias)
    return nil if seen.include?(node.anchor)

    seen.add(node.anchor)
    node = anchors[node.anchor]
    return nil if node.nil?
  end
  node
end

def scalar_value(node, anchors)
  resolved = resolve_alias(node, anchors)
  resolved.value if resolved.is_a?(Psych::Nodes::Scalar)
end

def each_uses(node, anchors = {}, &block)
  register_anchor(node, anchors)

  if node.is_a?(Psych::Nodes::Mapping)
    node.children.each_slice(2) do |key, value|
      register_anchor(key, anchors)
      register_anchor(value, anchors)
      if scalar_value(key, anchors) == "uses"
        location = "line #{key.start_line + 1}, column #{key.start_column + 1}"
        yield scalar_value(value, anchors), location
      end
      each_uses(key, anchors, &block)
      each_uses(value, anchors, &block)
    end
  elsif node.respond_to?(:children) && node.children
    node.children.each { |child| each_uses(child, anchors, &block) }
  end
end

def local_reference_exists?(reference, sources)
  path = reference.delete_prefix("./").sub(%r{/+\z}, "")
  candidates =
    if path.match?(WORKFLOW_PATH)
      [path]
    else
      ["#{path}/action.yml", "#{path}/action.yaml"]
    end
  candidates.any? { |candidate| sources.key?(candidate) }
end

begin
  sources = sources_for(options)
  errors = []
  local_count = 0
  pinned_count = 0

  sources.each do |path, content|
    begin
      stream = Psych.parse_stream(content, filename: path)
      each_uses(stream) do |reference, location|
        if reference.nil?
          errors << "#{path}: #{location} uses must be a scalar string"
        elsif reference.start_with?("docker://")
          if reference.match?(DOCKER_ACTION_REFERENCE)
            pinned_count += 1
          else
            errors << "#{path}: #{location} uses an unpinned Docker image #{reference.inspect}"
          end
        elsif reference.start_with?("./")
          if reference.match?(LOCAL_ACTION_REFERENCE) &&
              (options[:stdin] || local_reference_exists?(reference, sources))
            local_count += 1
          else
            errors << "#{path}: #{location} has an invalid local action reference #{reference.inspect}"
          end
        elsif reference.match?(GIT_ACTION_REFERENCE)
          pinned_count += 1
        else
          errors << "#{path}: #{location} uses a mutable action reference #{reference.inspect}"
        end
      end
    rescue Psych::Exception => error
      errors << "#{path}: invalid YAML: #{error.message.lines.first&.strip}"
    end
  end

  unless errors.empty?
    errors.each { |error| warn "error: #{error}" }
    exit 1
  end

  puts(
    "Workflow action references verified: #{pinned_count} immutable third-party, " \
      "#{local_count} local",
  )
rescue StandardError => error
  warn "error: #{error.message}"
  exit 1
end
