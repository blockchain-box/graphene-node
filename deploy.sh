#!/usr/bin/env bash

# ==============================================
# Docker Compose Deployment Script for Graphene
# Cross-platform compatible (Linux, macOS, WSL)
# ==============================================

set -euo pipefail

# Detect if output supports colors
supports_colors() {
    if [[ -t 1 ]] && [[ "$(tput colors 2>/dev/null)" -ge 8 ]]; then
        return 0
    elif [[ "${TERM:-}" == "xterm"* ]] || [[ "${TERM:-}" == "screen"* ]] || [[ "${TERM:-}" == "tmux"* ]]; then
        return 0
    elif [[ -n "${COLORTERM:-}" ]]; then
        return 0
    fi
    return 1
}

# Setup colors
if supports_colors; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    BLUE='\033[0;34m'
    CYAN='\033[0;36m'
    MAGENTA='\033[0;35m'
    NC='\033[0m' # No Color
    BOLD='\033[1m'
    DIM='\033[2m'
else
    RED=''; GREEN=''; YELLOW=''; BLUE=''; CYAN=''; MAGENTA=''; NC=''; BOLD=''; DIM=''
fi

# Helper function to print with colors
colored_echo() {
    local color="$1"
    shift
    if supports_colors; then
        echo -e "${color}$*${NC}"
    else
        echo "$*"
    fi
}

# Script info
SCRIPT_NAME="$(basename "$0")"
SCRIPT_VERSION="1.0.0"

# Default values
DEFAULT_NODE_ENV="local"
SUPPORTED_ENVS=("local" "test" "live")

# ==============================================
# FUNCTIONS
# ==============================================

print_usage() {
    colored_echo "$BOLD" "${SCRIPT_NAME} - Graphene Network Deployment Script"
    colored_echo "$DIM" "Version: ${SCRIPT_VERSION}"
    echo
    colored_echo "$BOLD" "Usage:"
    echo "  ${SCRIPT_NAME} [OPTIONS] [ENVIRONMENT]"
    echo
    colored_echo "$BOLD" "Environments:"
    colored_echo "$GREEN"   " local        - Local environment (default)"
    colored_echo "$YELLOW"  " test         - Test environment"
    colored_echo "$MAGENTA" " live         - Live/production environment"
    echo
    colored_echo "$BOLD" "Options:"
    echo "  -h, --help          Show this help message"
    echo "  -v, --version       Show version information"
    echo "  -s, --stop          Stop services only (no start)"
    echo "  -r, --restart       Restart services (stop & start)"
    echo "  -c, --clean         Stop and remove containers, networks"
    echo "  -l, --logs          Show logs after starting"
    echo "  --no-build          Skip Docker image building"
    echo "  --no-git-lfs        Skip Git LFS operations"
    echo "  --validate-only     Validate configuration only"
    echo "  --skip-network      Skip network creation"
    echo
    colored_echo "$BOLD" "Examples:"
    echo "  ${SCRIPT_NAME}                    # Start local environment"
    echo "  ${SCRIPT_NAME} staging            # Start staging environment"
    echo "  ${SCRIPT_NAME} production         # Start production environment"
    echo "  ${SCRIPT_NAME} --stop             # Stop all services"
    echo "  ${SCRIPT_NAME} --restart staging  # Restart staging environment"
    echo "  ${SCRIPT_NAME} --clean local      # Clean local environment"
    echo "  ${SCRIPT_NAME} --logs development # Start development and show logs"
    echo
    colored_echo "$BOLD" "Environment Variables:"
    echo "  COMPOSE_PATH_SEPARATOR    Path separator for compose files"
    echo "  DOCKER_BUILDKIT           Enable BuildKit (default: 1)"
    echo "  COMPOSE_DOCKER_CLI_BUILD  Use Docker CLI for building"
}

 # Update other print functions to use echo -e
 print_error() {
     echo -e "${RED}[ERROR]${NC} $1" >&2
 }

 print_warning() {
     echo -e "${YELLOW}[WARNING]${NC} $1"
 }

 print_info() {
     echo -e "${BLUE}[INFO]${NC} $1"
 }

 print_success() {
     echo -e "${GREEN}[SUCCESS]${NC} $1"
 }

 print_step() {
     echo -e "${CYAN}▶${NC} ${BOLD}$1${NC}"
 }

validate_command() {
    if ! command -v "$1" >/dev/null 2>&1; then
        print_error "Command '$1' is required but not installed"
        return 1
    fi
}

validate_file() {
    if [[ ! -f "$1" ]]; then
        print_error "Required file not found: $1"
        return 1
    fi
}

validate_directory() {
    if [[ ! -d "$1" ]]; then
        print_error "Required directory not found: $1"
        return 1
    fi
}

validate_env() {
    local env="$1"
    for supported in "${SUPPORTED_ENVS[@]}"; do
        if [[ "$env" == "$supported" ]]; then
            return 0
        fi
    done
    print_error "Unsupported environment: '$env'"
    print_error "Supported environments: ${SUPPORTED_ENVS[*]}"
    return 1
}

check_docker() {
    if ! docker info >/dev/null 2>&1; then
        print_error "Docker daemon is not running or not accessible"
        print_info "Make sure Docker is installed and running"
        print_info "On Windows, ensure Docker Desktop is running"
        print_info "On Linux/macOS, try: sudo systemctl start docker"
        exit 1
    fi
}

check_docker_compose() {
    # Check for Docker Compose V2 (docker compose) or V1 (docker-compose)
    if docker compose version >/dev/null 2>&1; then
        COMPOSE_CMD="docker compose"
        print_info "Using Docker Compose V2 (docker compose)"
    elif command -v docker-compose >/dev/null 2>&1; then
        COMPOSE_CMD="docker-compose"
        print_info "Using Docker Compose V1 (docker-compose)"
    else
        print_error "Docker Compose is not installed"
        print_info "Install Docker Compose: https://docs.docker.com/compose/install/"
        exit 1
    fi
}

load_config() {
    local node_env="$1"

    # Base paths
    local config_dir="config/env/${node_env}"
    local services_dir="services"

    # Files to validate
    COMPOSE_FILE_VALIDATOR="${services_dir}/docker.compose.validator.yml"
    COMPOSE_FILE_SENTRY="${services_dir}/docker.compose.sentry.yml"
    COMMON_ENV_FILE="${config_dir}/.env.common"
    VALIDATOR_ENV_FILE="${config_dir}/.env.validator"
    SENTRY_ENV_FILE="${config_dir}/.env.sentry"

    # Network and deployment names
    NETWORK_NAME="graphene-net"
    DEPLOYMENT_ID="graphene_deployment_${node_env}"

    # Validate all required files and directories
    print_step "Validating configuration for '$node_env' environment"

    validate_directory "$config_dir" || exit 1
    validate_directory "$services_dir" || exit 1
    validate_file "$COMPOSE_FILE_VALIDATOR" || exit 1
    validate_file "$COMPOSE_FILE_SENTRY" || exit 1
    validate_file "$COMMON_ENV_FILE" || exit 1
    validate_file "$VALIDATOR_ENV_FILE" || exit 1
    validate_file "$SENTRY_ENV_FILE" || exit 1

    # Check for optional .env.local files
    if [[ -f "${config_dir}/.env.local" ]]; then
        LOCAL_ENV_FILE="${config_dir}/.env.local"
        print_info "Found local override file: $LOCAL_ENV_FILE"
    else
        LOCAL_ENV_FILE=""
    fi

    print_success "Configuration validated successfully"
}

create_network() {
    print_step "Checking network: $NETWORK_NAME"

    if docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
        print_info "Network '$NETWORK_NAME' already exists"
    else
        print_info "Creating network: $NETWORK_NAME"
        if docker network create "$NETWORK_NAME"; then
            print_success "Network created successfully"
        else
            print_error "Failed to create network"
            exit 1
        fi
    fi
}

git_lfs_pull() {
    if [[ "$SKIP_GIT_LFS" == true ]]; then
        print_info "Skipping Git LFS operations"
        return 0
    fi

    print_step "Checking Git LFS"

    if command -v git-lfs >/dev/null 2>&1; then
        if git rev-parse --git-dir >/dev/null 2>&1; then
            print_info "Initializing Git LFS"
            if git lfs install; then
                print_info "Pulling Git LFS objects"
                if git lfs pull; then
                    print_success "Git LFS operations completed"
                else
                    print_warning "Git LFS pull failed, continuing anyway"
                fi
            else
                print_warning "Git LFS install failed, continuing anyway"
            fi
        else
            print_info "Not a Git repository, skipping Git LFS"
        fi
    else
        print_warning "Git LFS not installed, skipping"
        print_info "Install Git LFS: https://git-lfs.github.com/"
    fi
}

deploy_service() {
    local service_type="$1"  # "validator" or "sentry"
    local compose_file="$2"
    local env_files=("$3")
    local project_name="${DEPLOYMENT_ID}_${service_type}"

    print_step "Deploying ${service_type} services"
    echo -e "  Project: ${BOLD}$project_name${NC}"
    echo -e "  Compose: $compose_file"
    echo -e "  Env files: ${env_files[*]}"

    # Stop if restarting or cleaning
    print_info "Stopping ${service_type} services..."
    $COMPOSE_CMD -f "$compose_file" -p "$project_name" down --remove-orphans || true

    # Exit if only stopping
    if [[ "$STOP_ONLY" == true ]]; then
        return 0
    fi

    # Remove if cleaning
    if [[ "$CLEAN" == true ]]; then
        print_info "Removing ${service_type} volumes..."
        $COMPOSE_CMD -f "$compose_file" -p "$project_name" down -v --remove-orphans 2>/dev/null || true
        return 0
    fi

    # Start services
    local build_arg="--build"
    if [[ "$NO_BUILD" == true ]]; then
        build_arg=""
        print_info "Skipping build (--no-build flag)"
    fi

    print_info "Starting services with env files: ${env_files[*]}"

    local start_cmd="$COMPOSE_CMD -f $compose_file ${env_files[*]} -p $project_name up -d $build_arg"
    echo -e "${DIM}Command: $start_cmd${NC}"

    if eval "$start_cmd"; then
        print_success "${service_type} services started successfully"

        # Check service status
        print_info "Checking ${service_type} service status..."
        $COMPOSE_CMD -f "$compose_file" ${env_files[*]} -p "$project_name" ps
    else
        print_error "Failed to start ${service_type} services"
        return 1
    fi
}

show_logs() {
    print_step "Showing logs for all services"

    for service_type in "validator" "sentry"; do
        local compose_file="${services_dir}/docker.compose.${service_type}.yml"
        local project_name="${DEPLOYMENT_ID}_${service_type}"

        if [[ -f "$compose_file" ]]; then
            echo -e "\n${CYAN}=== ${service_type^^} LOGS ===${NC}"
            $COMPOSE_CMD -f "$compose_file" -p "$project_name" logs --tail=50 2>/dev/null || true
        fi
    done
}

validate_configuration() {
    print_step "Validating Docker Compose configurations"

    for compose_file in "$COMPOSE_FILE_VALIDATOR" "$COMPOSE_FILE_SENTRY"; do
        echo -e "Validating: ${BOLD}$(basename "$compose_file")${NC}"
        if $COMPOSE_CMD -f "$compose_file" config >/dev/null 2>&1; then
            print_info "  ✓ Valid configuration"
        else
            print_error "  ✗ Invalid configuration in $compose_file"
            $COMPOSE_CMD -f "$compose_file" config 2>&1 | head -20
            return 1
        fi
    done

    print_success "All configurations are valid"
}

# ==============================================
# MAIN SCRIPT
# ==============================================

main() {
    # Parse command line arguments
    NODE_ENV="$DEFAULT_NODE_ENV"
    STOP_ONLY=false
    RESTART=false
    CLEAN=false
    SHOW_LOGS=false
    NO_BUILD=false
    SKIP_GIT_LFS=false
    VALIDATE_ONLY=false
    SKIP_NETWORK=false

    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            -h|--help)
                print_usage
                exit 0
                ;;
            -v|--version)
                print_version
                exit 0
                ;;
            -s|--stop)
                STOP_ONLY=true
                shift
                ;;
            -r|--restart)
                RESTART=true
                shift
                ;;
            -c|--clean)
                CLEAN=true
                shift
                ;;
            -l|--logs)
                SHOW_LOGS=true
                shift
                ;;
            --no-build)
                NO_BUILD=true
                shift
                ;;
            --no-git-lfs)
                SKIP_GIT_LFS=true
                shift
                ;;
            --validate-only)
                VALIDATE_ONLY=true
                shift
                ;;
            --skip-network)
                SKIP_NETWORK=true
                shift
                ;;
            -*)
                print_error "Unknown option: $1"
                print_usage
                exit 1
                ;;
            *)
                NODE_ENV="$1"
                shift
                ;;
        esac
    done

    # Validate environment
    validate_env "$NODE_ENV" || exit 1

    # Print deployment info
    echo -e "${BOLD}${CYAN}══════════════════════════════════════════════════════════${NC}"
    echo -e "${BOLD}Graphene Network Deployment${NC}"
    echo -e "${DIM}Environment: ${BOLD}$NODE_ENV${NC}${DIM}"
    echo -e "Mode: $([ "$STOP_ONLY" == true ] && echo "STOP" || \
                    [ "$RESTART" == true ] && echo "RESTART" || \
                    [ "$CLEAN" == true ] && echo "CLEAN" || \
                    [ "$VALIDATE_ONLY" == true ] && echo "VALIDATE" || \
                    echo "DEPLOY")${NC}"
    echo -e "${CYAN}══════════════════════════════════════════════════════════${NC}\n"

    # Check prerequisites
    print_step "Checking prerequisites"
    validate_command "docker"
    check_docker
    check_docker_compose
    validate_command "git"

    # Load and validate configuration
    load_config "$NODE_ENV"

    # Validate configuration only
    if [[ "$VALIDATE_ONLY" == true ]]; then
        validate_configuration
        echo -e "\n${GREEN}✓ Configuration validation completed successfully${NC}"
        exit 0
    fi

    # Git LFS operations
    git_lfs_pull

    # Create network if needed
    if [[ "$SKIP_NETWORK" == false ]]; then
        create_network
    else
        print_info "Skipping network creation (--skip-network flag)"
    fi

    # Prepare env files array
    ENV_FILES_VALIDATOR=("--env-file $COMMON_ENV_FILE" "--env-file $VALIDATOR_ENV_FILE")
    ENV_FILES_SENTRY=("--env-file $COMMON_ENV_FILE" "--env-file $SENTRY_ENV_FILE")

    # Add local override if exists
    if [[ -n "$LOCAL_ENV_FILE" ]]; then
        ENV_FILES_VALIDATOR+=("$LOCAL_ENV_FILE")
        ENV_FILES_SENTRY+=("$LOCAL_ENV_FILE")
    fi

    # Deploy services
    if deploy_service "validator" "$COMPOSE_FILE_VALIDATOR" "${ENV_FILES_VALIDATOR[*]}"; then
        print_success "Validator deployment completed"
    else
        print_error "Validator deployment failed"
        if [[ "$STOP_ONLY" == false ]] && [[ "$CLEAN" == false ]]; then
            exit 1
        fi
    fi

    if deploy_service "sentry" "$COMPOSE_FILE_SENTRY" "${ENV_FILES_SENTRY[*]}"; then
        print_success "Sentry deployment completed"
    else
        print_error "Sentry deployment failed"
        if [[ "$STOP_ONLY" == false ]] && [[ "$CLEAN" == false ]]; then
            exit 1
        fi
    fi

    # Show logs if requested
    if [[ "$SHOW_LOGS" == true ]] && [[ "$STOP_ONLY" == false ]] && [[ "$CLEAN" == false ]]; then
        show_logs
    fi

    # Final status
    if [[ "$STOP_ONLY" == true ]]; then
        print_success "All services stopped successfully"
    elif [[ "$CLEAN" == true ]]; then
        print_success "All services cleaned up successfully"
    else
        print_success "Deployment completed successfully!"
        echo -e "\n${BOLD}Deployment Summary:${NC}"
        echo -e "  Environment: ${GREEN}$NODE_ENV${NC}"
        echo -e "  Network: ${CYAN}$NETWORK_NAME${NC}"
        echo -e "  Validator Project: ${DEPLOYMENT_ID}_validator"
        echo -e "  Sentry Project: ${DEPLOYMENT_ID}_sentry"

        # Show running containers
        echo -e "\n${BOLD}Running Containers:${NC}"
        docker ps --filter "label=com.docker.compose.project" \
                  --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" \
                  | grep -E "(${DEPLOYMENT_ID}_validator|${DEPLOYMENT_ID}_sentry)" || true
    fi
}

# Handle bash requirement
if [ -z "${BASH_VERSION:-}" ]; then
    # Try to re-exec with bash if available
    if command -v bash >/dev/null 2>&1; then
        exec bash "$0" "$@"
    fi
    echo "This script requires bash. Please run with: bash $0" >&2
    exit 1
fi

# Run main function
main "$@"