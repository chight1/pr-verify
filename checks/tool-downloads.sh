#!/usr/bin/env bash
# The pinned linters the gate downloads rather than installs, each checked
# against its SHA-256, and the tools it installs from PyPI and Ubuntu's archive.
# Sourced by run.sh.

# Downloads a pinned release and checks it against its SHA-256, then prints the
# path of the binary: the download itself, or the named member of its archive.
fetch_tool() {
  local url="$1" sha256="$2" member="${3:-}"
  local dir file
  dir="$(mktemp -d)"
  file="$dir/$(basename "$url")"
  curl -fsSL -o "$file" "$url" >&2 \
    && echo "$sha256  $file" | sha256sum --check --strict --quiet >&2 \
    || return 1
  if [ -z "$member" ]; then
    chmod +x "$file" && echo "$file"
  else
    tar -xzf "$file" -C "$dir" "$member" >&2 && echo "$dir/$member"
  fi
}

golangci_lint() {
  fetch_tool https://github.com/golangci/golangci-lint/releases/download/v2.15.0/golangci-lint-2.15.0-linux-amd64.tar.gz \
    9b7fe6a6bf6334b98decf8d86b11415ea7889afdabdd1959fdce23af2a9ebcea \
    golangci-lint-2.15.0-linux-amd64/golangci-lint
}
actionlint() {
  fetch_tool https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz \
    8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8 actionlint
}
shellcheck() {
  fetch_tool https://github.com/koalaman/shellcheck/releases/download/v0.11.0/shellcheck-v0.11.0.linux.x86_64.tar.gz \
    b7af85e41cc99489dcc21d66c6d5f3685138f06d34651e6d34b42ec6d54fe6f6 shellcheck-v0.11.0/shellcheck
}
hadolint() {
  fetch_tool https://github.com/hadolint/hadolint/releases/download/v2.15.1/hadolint-linux-x86_64 \
    c7187db94eeeeca956519a6af171adc31453941a1e777961f6e680f697c8c507
}

# Installs a pinned PyPI package in a virtual environment of its own and prints
# the path of its command, for a tool run many times at once, where starting
# each run through pipx would be slow.
python_tool() {
  local package="$1" command="$2" environment
  environment="$(mktemp -d)"
  python3 -m venv "$environment" >&2 \
    && "$environment/bin/pip" install --isolated --quiet --disable-pip-version-check "$package" >&2 \
    && echo "$environment/bin/$command"
}

clang_tidy() {
  python_tool clang-tidy==23.1.4 clang-tidy
}

# cppcheck publishes no binaries, so it comes from Ubuntu's signed archive,
# whose package lists are refreshed only when the runner's are out of date.
# Always the archive's copy, never one on PATH, which the install step could
# have put there.
cppcheck() {
  if ! sudo apt-get install -y -qq --no-install-recommends cppcheck > /dev/null 2>&1; then
    sudo apt-get update -qq >&2 \
      && sudo apt-get install -y -qq --no-install-recommends cppcheck > /dev/null \
      || return 1
  fi
  echo /usr/bin/cppcheck
}
