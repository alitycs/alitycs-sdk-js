#!/usr/bin/env ruby
# frozen_string_literal: true

require "open3"
require "optparse"
require "psych"
require "set"

GIT_ACTION_REFERENCE = /\A[^@\s]+@[0-9a-f]{40}\z/
DOCKER_ACTION_REFERENCE = /\Adocker:\/\/[^@\s]+@sha256:[0-9a-f]{64}\z/
SAME_COMMIT_REFERENCE = %r{\A(?:\./|\$/)[^@\s]+\z}
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
  return [{ options[:stdin] => $stdin.read }, nil] if options[:stdin]

  listing =
    if options[:git_ref]
      git_output("ls-tree", "-rz", "--name-only", options[:git_ref])
    else
      git_output("ls-files", "-z")
    end
  tracked_paths = listing.split("\0")
  paths = tracked_paths.select { |path| policy_path?(path) }.sort
  raise "no tracked workflow or action metadata files were found" if paths.empty?

  sources =
    paths.to_h do |path|
      content =
        if options[:git_ref]
          git_output("show", "#{options[:git_ref]}:#{path}")
        else
          File.binread(path)
        end
      [path, content]
    end
  [sources, tracked_paths.to_set]
end

def document_context(document)
  anchors = {}
  positions = {}
  next_position = 0
  visit = nil
  visit = lambda do |node|
    # Psych retains source order in children for block and flow collections. Indexing the parsed
    # document therefore distinguishes same-line definitions without allowing another document's
    # anchors to leak into this one.
    positions[node.object_id] = next_position
    next_position += 1
    if node.respond_to?(:anchor) && !node.is_a?(Psych::Nodes::Alias) && !node.anchor.nil?
      (anchors[node.anchor] ||= []) << node
    end
    node.children.each { |child| visit.call(child) } if node.respond_to?(:children) && node.children
  end
  visit.call(document)
  { anchors: anchors, positions: positions }
end

def resolve_alias(node, context)
  seen = Set.new
  while node.is_a?(Psych::Nodes::Alias)
    return nil unless seen.add?(node.object_id)

    alias_position = context[:positions].fetch(node.object_id)
    node = context[:anchors].fetch(node.anchor, []).reverse.find do |candidate|
      context[:positions].fetch(candidate.object_id) < alias_position
    end
    return nil if node.nil?
  end
  node
end

def scalar_value(node, context)
  resolved = resolve_alias(node, context)
  resolved.value if resolved.is_a?(Psych::Nodes::Scalar)
end

def mapping_entries(node, context)
  resolved = resolve_alias(node, context)
  return [] unless resolved.is_a?(Psych::Nodes::Mapping)

  resolved.children.each_slice(2).to_a
end

def mapping_values(node, name, context)
  mapping_entries(node, context).filter_map do |key, value|
    [key, value] if scalar_value(key, context) == name
  end
end

def sequence_items(node, context)
  resolved = resolve_alias(node, context)
  return [] unless resolved.is_a?(Psych::Nodes::Sequence)

  resolved.children
end

def each_mapping_reference(node, name, context, reference_kind)
  mapping_values(node, name, context).each do |key, value|
    location = "line #{key.start_line + 1}, column #{key.start_column + 1}"
    yield scalar_value(value, context), location, reference_kind
  end
end

def each_steps_uses(node, context, &block)
  sequence_items(node, context).each do |step|
    each_mapping_reference(step, "uses", context, :action, &block)
  end
end

def each_workflow_uses(root, context, &block)
  mapping_values(root, "jobs", context).each do |_jobs_key, jobs|
    mapping_entries(jobs, context).each do |_job_name, job|
      each_mapping_reference(job, "uses", context, :workflow, &block)
      mapping_values(job, "steps", context).each do |_steps_key, steps|
        each_steps_uses(steps, context, &block)
      end
    end
  end
end

def each_action_metadata_reference(root, context, &block)
  mapping_values(root, "runs", context).each do |_runs_key, runs|
    each_mapping_reference(runs, "image", context, :docker_image, &block)
    mapping_values(runs, "steps", context).each do |_steps_key, steps|
      each_steps_uses(steps, context, &block)
    end
  end
end

def each_action_uses(stream, path, &block)
  stream.children.each do |document|
    context = document_context(document)
    document.children.each do |root|
      if path.match?(ACTION_METADATA_PATH)
        each_action_metadata_reference(root, context, &block)
      else
        each_workflow_uses(root, context, &block)
      end
    end
  end
end

def same_commit_candidates(reference, reference_kind)
  return [] unless reference.match?(SAME_COMMIT_REFERENCE)

  path = reference.sub(%r{\A(?:\./|\$/)}, "").sub(%r{/+\z}, "")
  return [] if path.empty?

  if reference_kind == :workflow
    path.match?(WORKFLOW_PATH) ? [path] : []
  elsif path.match?(WORKFLOW_PATH)
    []
  else
    ["#{path}/action.yml", "#{path}/action.yaml"]
  end
end

def local_dockerfile_path(metadata_path, reference)
  path = reference.sub(%r{\A\./}, "")
  segments = path.split("/", -1)
  return nil if segments.empty?
  return nil if segments.any? { |segment| segment.empty? || segment == "." || segment == ".." }
  return nil unless segments.last == "Dockerfile"

  directory = File.dirname(metadata_path)
  relative_path = segments.join("/")
  directory == "." ? relative_path : File.join(directory, relative_path)
end

begin
  sources, tracked_paths = sources_for(options)
  errors = []
  local_count = 0
  pinned_count = 0

  sources.each do |path, content|
    begin
      stream = Psych.parse_stream(content, filename: path)
      each_action_uses(stream, path) do |reference, location, reference_kind|
        if reference_kind == :docker_image
          if reference.nil?
            errors << "#{path}: #{location} image must be a scalar string"
          elsif reference.start_with?("docker://")
            if reference.match?(DOCKER_ACTION_REFERENCE)
              pinned_count += 1
            else
              errors << "#{path}: #{location} uses an unpinned Docker image #{reference.inspect}"
            end
          elsif (dockerfile_path = local_dockerfile_path(path, reference))
            if options[:stdin] || tracked_paths.include?(dockerfile_path)
              local_count += 1
            else
              errors <<
                "#{path}: #{location} references an untracked Dockerfile #{reference.inspect}"
            end
          else
            errors << "#{path}: #{location} has an invalid Docker action image #{reference.inspect}"
          end
        elsif reference.nil?
          errors << "#{path}: #{location} uses must be a scalar string"
        elsif reference.start_with?("docker://")
          if reference.match?(DOCKER_ACTION_REFERENCE)
            pinned_count += 1
          else
            errors << "#{path}: #{location} uses an unpinned Docker image #{reference.inspect}"
          end
        elsif reference.start_with?("./") || reference.start_with?("$/")
          candidates = same_commit_candidates(reference, reference_kind)
          if !candidates.empty? &&
              (options[:stdin] || candidates.any? { |candidate| sources.key?(candidate) })
            local_count += 1
          else
            errors <<
              "#{path}: #{location} has an invalid same-commit action or workflow reference " \
              "#{reference.inspect}"
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
