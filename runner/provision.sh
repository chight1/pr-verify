#!/usr/bin/env bash
# Turns the freshly installed Ubuntu into a runner like GitHub's ubuntu-24.04
# image, as far as PR Verify's jobs need it: build tools, Python, Node, Docker
# and the Actions runner. Runs once, as root, before setup takes the snapshot
# every job starts from. The one argument is the Semgrep image the workflow
# pins, pulled now rather than in every job.
set -euo pipefail

semgrep_image="$1"
if [[ ! "$semgrep_image" =~ ^[a-z0-9./_-]+@sha256:[0-9a-f]{64}$ ]]; then
  echo "Expected a Semgrep image pinned by digest, not '$semgrep_image'." >&2
  exit 1
fi
runner_home=/home/runner
tool_cache=/opt/hostedtoolcache
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export DEBIAN_FRONTEND=noninteractive

# A background apt run would hold the lock a job's own apt-get needs.
systemctl disable --now unattended-upgrades.service apt-daily.timer apt-daily-upgrade.timer
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq --no-install-recommends \
  build-essential cmake ninja-build pkg-config git curl ca-certificates jq \
  unzip zip xz-utils zstd python3 python3-venv python3-pip pipx docker.io

# The newest Node 24 from nodejs.org, checked against the SHA-256 the release
# publishes. The gate's checks run on it before a project's own setup step.
node_release=https://nodejs.org/dist/latest-v24.x
node_line="$(curl -fsSL "$node_release/SHASUMS256.txt" | grep -E '  node-v[0-9.]+-linux-x64\.tar\.xz$')"
node_archive="${node_line##* }"
curl -fsSL -o "$work/$node_archive" "$node_release/$node_archive"
(cd "$work" && sha256sum --check --strict --quiet <<< "$node_line")
tar -xJf "$work/$node_archive" -C /usr/local --strip-components 1

# The newest Actions runner, checked against the SHA-256 GitHub records for the
# release's file.
release="$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest)"
asset="$(jq -c '.assets[] | select(.name | test("^actions-runner-linux-x64-[0-9.]+\\.tar\\.gz$"))' <<< "$release")"
curl -fsSL -o "$work/runner.tar.gz" "$(jq -r .browser_download_url <<< "$asset")"
digest="$(jq -r .digest <<< "$asset")"
echo "${digest#sha256:}  $work/runner.tar.gz" | sha256sum --check --strict --quiet
install -d -o runner -g runner "$runner_home/actions-runner"
tar -xzf "$work/runner.tar.gz" -C "$runner_home/actions-runner"
"$runner_home/actions-runner/bin/installdependencies.sh"

# Where GitHub's image keeps toolchains. Setup actions install Python there,
# whose builds only work from that path, and actions read ImageOS as they do on
# GitHub's runners. The runner reads its environment from .env.
install -d -o runner -g runner "$tool_cache"
cat > "$runner_home/actions-runner/.env" <<ENV
LANG=C.UTF-8
ImageOS=ubuntu24
AGENT_TOOLSDIRECTORY=$tool_cache
RUNNER_TOOL_CACHE=$tool_cache
ENV
chown -R runner:runner "$runner_home/actions-runner"

usermod -aG docker runner
systemctl enable --now docker
docker pull --quiet "$semgrep_image"

# cloud-init did its one job during the install; without it every boot is faster.
touch /etc/cloud/cloud-init.disabled
apt-get clean
