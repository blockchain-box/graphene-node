#!/usr/bin/env bash

# Require bash: running with `sh` (dash) will fail on some constructs (e.g. [[ ]] and pipefail).
if [ -z "${BASH_VERSION:-}" ]; then
  if command -v bash >/dev/null 2>&1; then
    # Re-exec the script with bash preserving args
    exec bash "$0" "$@"
  fi
  echo "This script requires bash. Install bash or run it with: bash $0" >&2
  exit 1
fi

set -euo pipefail

# install_linux.sh
# Idempotentes Installationsskript für Docker und Docker Compose (Plugin) auf Linux.
# Unterstützte Distros: Debian/Ubuntu, RHEL/CentOS/Fedora, Arch. Fallback: Docker convenience script.
# Am Ende kann optional das lokale Startskript `deploy/start.local.sh` ausgeführt werden.

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
START_SCRIPT="$REPO_ROOT/deploy/start.local.sh"

usage() {
  cat <<EOF
Usage: $0 [--yes|--run]
  --yes / -y    : non-interactive, will run start script automatically after install
  --run / -r    : same as --yes
  --help / -h   : show this help

This script will install Docker Engine and the Docker Compose plugin and enable/start the docker service.
EOF
}

RUN_START=false

while [[ ${1:-} != "" ]]; do
  case "$1" in
    -y|--yes|-r|--run)
      RUN_START=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown arg: $1"
      usage
      exit 2
      ;;
  esac
done

# Helpers
log() { echo "[install_linux] $*"; }
err() { echo "[install_linux] ERROR: $*" >&2; }

# Ensure running with sudo or root when needed
SUDO=""
if [[ $(id -u) -ne 0 ]]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO=sudo
  else
    err "Please run this script as root or install sudo.";
    exit 1
  fi
fi

detect_distro() {
  if [ -f /etc/os-release ]; then
    . /etc/os-release
    echo "$ID"
  else
    echo "unknown"
  fi
}

DISTRO=$(detect_distro)
log "Detected distro: $DISTRO"

install_on_debian() {
  log "Installing prerequisites for Debian/Ubuntu"
  $SUDO apt-get update -y
  $SUDO apt-get install -y ca-certificates curl gnupg lsb-release

  log "Adding Docker official GPG key and repository"
  $SUDO mkdir -p /etc/apt/keyrings
  . /etc/os-release
  DISTRO_ID="${ID:-ubuntu}"
  ARCH="$(dpkg --print-architecture)"
  CODENAME="$(lsb_release -cs)"

  curl -fsSL "https://download.docker.com/linux/${DISTRO_ID}/gpg" | $SUDO gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  echo "deb [arch=${ARCH} signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${DISTRO_ID} ${CODENAME} stable" | $SUDO tee /etc/apt/sources.list.d/docker.list > /dev/null

  $SUDO apt-get update -y
  log "Installing Docker Engine and docker-compose plugin"
  $SUDO apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
}

install_on_rhel() {
  # Works for RHEL/CentOS/Fedora (dnf preferred)
  PKG_MANAGER="yum"
  if command -v dnf >/dev/null 2>&1; then
    PKG_MANAGER=dnf
  fi
  log "Using package manager: $PKG_MANAGER"

  $SUDO $PKG_MANAGER install -y yum-utils
  $SUDO yum-config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
  $SUDO $PKG_MANAGER install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
}

install_on_fedora() {
  log "Installing on Fedora"
  $SUDO dnf -y install dnf-plugins-core
  $SUDO dnf config-manager --add-repo https://download.docker.com/linux/fedora/docker-ce.repo
  $SUDO dnf -y install docker-ce docker-ce-cli containerd.io docker-compose-plugin
}

install_on_arch() {
  log "Installing on Arch/Manjaro"
  $SUDO pacman -Syu --noconfirm
  $SUDO pacman -S --noconfirm docker docker-compose
}

install_docker_fallback() {
  log "Falling back to Docker convenience script (get.docker.com)"
  curl -fsSL https://get.docker.com | $SUDO sh
  # Try to install docker-compose plugin via pip as fallback (optional)
  if ! command -v docker-compose >/dev/null 2>&1; then
    if command -v pip3 >/dev/null 2>&1; then
      $SUDO pip3 install docker-compose
    fi
  fi
}

install_legacy_compose() {
  # Ensure a docker-compose binary is present (legacy), non-interactive.
  if command -v docker-compose >/dev/null 2>&1; then
    log "Legacy docker-compose already installed: $(docker-compose --version 2>/dev/null || true)"
    return 0
  fi

  # Map uname arch to compose binary name
  ARCH_M="$(uname -m)"
  case "${ARCH_M}" in
    x86_64|amd64)
      COMPOSE_ARCH="x86_64"
      ;;
    aarch64|arm64)
      COMPOSE_ARCH="aarch64"
      ;;
    *)
      log "Unknown architecture ${ARCH_M}, attempting pip3 install as fallback"
      if command -v pip3 >/dev/null 2>&1; then
        $SUDO pip3 install docker-compose
        return $?
      else
        err "Cannot determine compose binary for arch ${ARCH_M} and pip3 not available"
        return 1
      fi
      ;;
  esac

  DOWNLOAD_URL="https://github.com/docker/compose/releases/latest/download/docker-compose-linux-${COMPOSE_ARCH}"
  TARGET="/usr/local/bin/docker-compose"

  log "Downloading legacy docker-compose from ${DOWNLOAD_URL} to ${TARGET}"
  if command -v curl >/dev/null 2>&1; then
    $SUDO curl -fsSL "${DOWNLOAD_URL}" -o "${TARGET}"
  elif command -v wget >/dev/null 2>&1; then
    $SUDO wget -qO "${TARGET}" "${DOWNLOAD_URL}"
  else
    err "Neither curl nor wget available to download docker-compose"
    return 1
  fi

  $SUDO chmod +x "${TARGET}"
  log "Installed docker-compose binary: $($SUDO ${TARGET} --version 2>/dev/null || echo 'unknown')"
}

install_git_lfs() {
  # Helper to check availability via subcommand or binary
  is_git_lfs_available() {
    if command -v git >/dev/null 2>&1 && git lfs version >/dev/null 2>&1; then
      return 0
    fi
    if command -v git-lfs >/dev/null 2>&1; then
      return 0
    fi
    return 1
  }

  # If already available, ensure hooks are installed and return
  if is_git_lfs_available; then
    log "git-lfs already available: $(git lfs version 2>/dev/null || git-lfs --version 2>/dev/null || true)"
    # Try to initialize using git lfs subcommand, fallback to git-lfs
    if command -v git >/dev/null 2>&1 && git lfs install --system >/dev/null 2>&1; then
      return 0
    fi
    if command -v git-lfs >/dev/null 2>&1 && git-lfs install --system >/dev/null 2>&1; then
      return 0
    fi
    # continue to attempt installation if initialization failed
  fi

  log "Installing git-lfs for distro: $DISTRO"
  case "$DISTRO" in
    ubuntu|debian)
      # Try native package first
      if $SUDO apt-get update -y && $SUDO apt-get install -y git-lfs; then
        true
      else
        log "Trying packagecloud installer for git-lfs"
        curl -fsSL https://packagecloud.io/install/repositories/github/git-lfs/script.deb.sh | $SUDO bash && $SUDO apt-get install -y git-lfs
      fi
      ;;
    centos|rhel)
      PKG_MANAGER="yum"
      if command -v dnf >/dev/null 2>&1; then
        PKG_MANAGER=dnf
      fi
      if ! $SUDO $PKG_MANAGER install -y git-lfs 2>/dev/null; then
        log "Trying packagecloud rpm installer for git-lfs"
        curl -fsSL https://packagecloud.io/install/repositories/github/git-lfs/script.rpm.sh | $SUDO bash && $SUDO $PKG_MANAGER install -y git-lfs
      fi
      ;;
    fedora)
      if ! $SUDO dnf -y install git-lfs 2>/dev/null; then
        log "Trying packagecloud rpm installer for git-lfs"
        curl -fsSL https://packagecloud.io/install/repositories/github/git-lfs/script.rpm.sh | $SUDO bash && $SUDO dnf -y install git-lfs
      fi
      ;;
    arch)
      $SUDO pacman -Sy --noconfirm git-lfs || $SUDO pacman -S --noconfirm git-lfs
      ;;
    *)
      log "Distro not explicitly supported for git-lfs installation: attempting packagecloud rpm script then deb script"
      if command -v curl >/dev/null 2>&1; then
        curl -fsSL https://packagecloud.io/install/repositories/github/git-lfs/script.rpm.sh | $SUDO bash 2>/dev/null || true
        curl -fsSL https://packagecloud.io/install/repositories/github/git-lfs/script.deb.sh | $SUDO bash 2>/dev/null || true
        # try common package managers
        if command -v apt-get >/dev/null 2>&1; then
          $SUDO apt-get update -y && $SUDO apt-get install -y git-lfs || true
        fi
        if command -v dnf >/dev/null 2>&1; then
          $SUDO dnf -y install git-lfs || true
        fi
      fi
      ;;
  esac

  # Initialize and verify availability (try both invocation styles)
  if command -v git >/dev/null 2>&1 && git lfs install --system >/dev/null 2>&1; then
    :
  elif command -v git-lfs >/dev/null 2>&1 && git-lfs install --system >/dev/null 2>&1; then
    :
  fi

  # Final verification: require `git lfs version` to succeed
  if command -v git >/dev/null 2>&1 && git lfs version >/dev/null 2>&1; then
    log "git-lfs installed and available: $(git lfs version 2>/dev/null)"
    return 0
  fi
  # As last resort, check for git-lfs binary
  if command -v git-lfs >/dev/null 2>&1; then
    log "git-lfs binary present but 'git lfs' subcommand not reporting version; binary: $(git-lfs --version 2>/dev/null || echo 'unknown')"
    return 0
  fi

  err "Failed to install git-lfs automatically. Please install git-lfs manually (e.g. 'curl -s https://packagecloud.io/install/repositories/github/git-lfs/script.deb.sh | sudo bash' then 'sudo apt-get install git-lfs')"
  return 1
}

# Install based on detected distro
case "$DISTRO" in
  ubuntu|debian)
    install_on_debian
    ;;
  centos|rhel)
    install_on_rhel
    ;;
  fedora)
    install_on_fedora
    ;;
  arch)
    install_on_arch
    ;;
  *)
    log "Distro not recognized or unsupported: $DISTRO"
    install_docker_fallback
    ;;
esac

## Ensure legacy docker-compose binary is present non-interactively
install_legacy_compose || log "Warning: failed to install legacy docker-compose; continuing"

## Ensure git-lfs is installed (required for some repository assets)
install_git_lfs || { err "git-lfs installation failed"; exit 1; }

# Start and enable docker
log "Enabling and starting docker service"
$SUDO systemctl enable --now docker

# Add current user to docker group so docker can be used without sudo
if [[ $(id -u) -ne 0 ]]; then
  USERNAME=$(id -un)
  if $SUDO getent group docker >/dev/null 2>&1; then
    log "Adding user $USERNAME to docker group"
    $SUDO usermod -aG docker "$USERNAME" || true
  else
    log "Creating docker group and adding user $USERNAME"
    $SUDO groupadd -f docker || true
    $SUDO usermod -aG docker "$USERNAME" || true
  fi
  log "Note: You may need to log out and log back in for group changes to take effect."
fi

# Verify installations
log "Verifying installations"
if command -v docker >/dev/null 2>&1; then
  log "Docker installed: $(docker --version)"
else
  err "Docker binary not found after install"
  exit 1
fi

# Prefer `docker compose` (plugin) but allow `docker-compose`
COMPOSE_CMD=""
if docker compose version >/dev/null 2>&1; then
  COMPOSE_CMD="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE_CMD="docker-compose"
else
  err "docker compose (plugin) or docker-compose not available"
  exit 1
fi
log "Compose command: $COMPOSE_CMD"

# Optionally run the start script
if [ "$RUN_START" = true ]; then
  if [ -x "$START_SCRIPT" ]; then
    log "Running start script: $START_SCRIPT"
    # If not root, run with sudo to ensure docker commands succeed without waiting for relogin
    if [[ $(id -u) -ne 0 ]]; then
      $SUDO bash "$START_SCRIPT"
    else
      bash "$START_SCRIPT"
    fi
  else
    err "Start script not found or not executable: $START_SCRIPT"
    exit 1
  fi
else
  # Ask user whether to run it now
  read -r -p "Do you want to run the local start script now? [y/N] " answer
  case "$answer" in
    [yY][eE][sS]|[yY])
      if [ -x "$START_SCRIPT" ]; then
        if [[ $(id -u) -ne 0 ]]; then
          $SUDO bash "$START_SCRIPT"
        else
          bash "$START_SCRIPT"
        fi
      else
        err "Start script not found or not executable: $START_SCRIPT"
        exit 1
      fi
      ;;
    *)
      log "Installation complete. To start the local stack run:"
      echo "  bash $START_SCRIPT"
      ;;
  esac
fi

log "Done."
