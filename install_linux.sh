#!/usr/bin/env bash
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
