#!/usr/bin/env bash

set -euo pipefail

readonly schema_url="https://coderabbit.ai/integrations/schema.v2.json"
readonly validator_version="0.37.4"

if command -v check-jsonschema >/dev/null 2>&1; then
	exec check-jsonschema --schemafile "$schema_url" .coderabbit.yaml
fi

validator_dir="$(mktemp -d)"
trap 'rm -r -- "$validator_dir"' EXIT

python3 -m venv "$validator_dir"
"$validator_dir/bin/python" -m pip install \
	--disable-pip-version-check \
	--quiet \
	"check-jsonschema==$validator_version"
"$validator_dir/bin/check-jsonschema" --schemafile "$schema_url" .coderabbit.yaml
