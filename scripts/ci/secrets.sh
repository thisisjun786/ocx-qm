#!/usr/bin/env bash
set -euo pipefail

# A dedicated tool directory and explicit inputs prevent repository ignore files
# and inline comments from suppressing findings. Workflow edits still need review.
repo_root=$(git rev-parse --show-toplevel)
git_dir=$(git rev-parse --absolute-git-dir)
scan_dir=$(mktemp -d)
trap 'rm -rf "$scan_dir"' EXIT
unset GITLEAKS_CONFIG GITLEAKS_CONFIG_TOML

version=8.30.1
archive="gitleaks_${version}_linux_x64.tar.gz"
checksum=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb
curl --fail --silent --show-error --location \
  "https://github.com/gitleaks/gitleaks/releases/download/v${version}/${archive}" \
  --output "$scan_dir/$archive"
printf '%s  %s\n' "$checksum" "$scan_dir/$archive" | sha256sum --check --status
tar -xzf "$scan_dir/$archive" -C "$scan_dir" gitleaks
: > "$scan_dir/empty.ignore"

# Gitleaks also reads <scan-target>/.gitleaksignore even with an explicit ignore
# path. Scan the Git database from the tool directory, not the PR working tree.
cd "$scan_dir"
./gitleaks git "$git_dir" \
  --config "$repo_root/.gitleaks.toml" \
  --gitleaks-ignore-path "$scan_dir/empty.ignore" \
  --ignore-gitleaks-allow --log-opts='--all -m' --redact --no-banner
