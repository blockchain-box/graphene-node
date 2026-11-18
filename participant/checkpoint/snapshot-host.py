# Checkpoint operations for the fixed participant Compose project.
"""Fixed full-snapshot protocol. Public artifacts never contain host configuration or keys."""

import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import urllib.request
import socket
from urllib.parse import urlsplit

ARTIFACTS = ("genesis.json", "app-state.json", "mpt.tar.gz", "tendermint.tar.gz")


def require(value, message):
    if not value:
        raise ValueError(message)


class SnapshotCommandError(subprocess.CalledProcessError):
    def __str__(self):
        return (self.stderr or "Snapshot command failed").strip()[-1500:]


def command(args, cwd=None, env=None, input=None, timeout=900):
    try:
        return subprocess.run(
            args, cwd=cwd, env=env, input=input, text=True,
            capture_output=True, check=True, timeout=timeout,
        ).stdout
    except subprocess.CalledProcessError as error:
        raise SnapshotCommandError(error.returncode, error.cmd, output=error.output, stderr=error.stderr) from None



def write(file, value):
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = file.with_name(file.name + ".tmp")
    temporary.write_text(json.dumps(value))
    temporary.chmod(0o600)
    temporary.replace(file)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError("Snapshot redirects are forbidden")


def snapshot_url(base, identifier):
    parsed = urlsplit(base)
    try:
        addresses = [ipaddress.ip_address(row[4][0]) for row in socket.getaddrinfo(parsed.hostname, None)]
    except (ValueError, TypeError, OSError):
        raise ValueError(
            "Snapshot downloads require the source sentry public IPv4"
        ) from None
    require(
        addresses and all(address.is_global for address in addresses)
        and ((parsed.scheme == "http" and parsed.port == 26657 and parsed.hostname.replace('.', '').isdigit())
             or (parsed.scheme == "https" and parsed.port in (None, 443)))
        and not parsed.username
        and not parsed.password
        and not parsed.query
        and not parsed.fragment
        and parsed.path == "/checkpoints/" + identifier + "/",
        "Invalid public snapshot location",
    )
    return base


def download(base, identifier, files, destination):
    snapshot_url(base, identifier)
    require(set(files) == set(ARTIFACTS), "Invalid snapshot download list")
    require(not destination.is_symlink(), "Unsafe snapshot cache directory")
    destination.mkdir(parents=True, exist_ok=True, mode=0o700)
    opener = urllib.request.build_opener(NoRedirect())
    for name in ARTIFACTS:
        spec = files[name]
        size = spec["bytes"]
        require(
            type(size) is int
            and 0 < size <= (4 * 1024**2 if name.endswith(".json") else 64 * 1024**3)
            and re.fullmatch("[a-f0-9]{64}", spec["sha256"]),
            "Invalid snapshot download size/hash",
        )
        final = destination / name
        partial = destination / (name + ".partial")
        require(
            not final.is_symlink() and not partial.is_symlink(),
            "Snapshot downloads cannot be symbolic links",
        )

        def checksum(file):
            digest = hashlib.sha256()
            with file.open("rb") as handle:
                for chunk in iter(lambda: handle.read(1024**2), b""):
                    digest.update(chunk)
            return digest

        if (
            final.is_file()
            and final.stat().st_size == size
            and checksum(final).hexdigest() == spec["sha256"]
        ):
            continue
        for attempt in range(3):
            try:
                offset = partial.stat().st_size if partial.exists() else 0
                require(offset <= size, "Partial snapshot exceeds the signed size")
                digest = checksum(partial) if offset else hashlib.sha256()
                if offset == size:
                    require(
                        digest.hexdigest() == spec["sha256"],
                        "Snapshot download checksum mismatch",
                    )
                    partial.replace(final)
                    break
                headers = {"User-Agent": "GrapheneSnapshot/2"}
                if offset:
                    headers["Range"] = "bytes=" + str(offset) + "-"
                request = urllib.request.Request(base + name, headers=headers)
                with opener.open(request, timeout=60) as response:
                    if offset and response.status == 206:
                        require(
                            response.headers.get("Content-Range")
                            == f"bytes {offset}-{size - 1}/{size}",
                            "Invalid snapshot download range",
                        )
                    else:
                        require(response.status == 200, "Snapshot download failed")
                        if partial.exists():
                            partial.unlink()
                        offset = 0
                        digest = hashlib.sha256()
                    flags = (
                        os.O_WRONLY
                        | os.O_CREAT
                        | (os.O_APPEND if offset else os.O_EXCL)
                        | getattr(os, "O_NOFOLLOW", 0)
                    )
                    with os.fdopen(
                        os.open(partial, flags, 0o600), "ab" if offset else "wb"
                    ) as target:
                        received = offset
                        for chunk in iter(lambda: response.read(1024**2), b""):
                            received += len(chunk)
                            require(
                                received <= size,
                                "Snapshot exceeds its signed download size",
                            )
                            digest.update(chunk)
                            target.write(chunk)
                if received < size:
                    raise OSError("Snapshot download interrupted")
                require(
                    digest.hexdigest() == spec["sha256"],
                    "Snapshot download checksum mismatch",
                )
                partial.replace(final)
                break
            except ValueError:
                partial.unlink(missing_ok=True)
                raise
            except OSError:
                # Unverified partials are private and never extracted. Retry with Range; verify the entire final digest.
                if attempt == 2:
                    raise
                time.sleep(2**attempt)


def operate(data):
    directory = Path(data["directory"])
    require(
        directory.is_absolute()
        and directory != Path("/")
        and directory.is_dir()
        and not directory.is_symlink(),
        "Choose the installed node directory",
    )
    require(re.fullmatch("[a-f0-9]{24}", data["id"]), "Invalid snapshot identifier")
    with (directory / ".rollout-operation.lock").open("a") as lock:
        os.chmod(lock.name, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("Another maintenance operation owns this node") from None
        return _operate(data, directory, os.environ.copy())


def _operate(data, directory, authenv):
    require(
        data["action"] == "restore",
        "Unsupported snapshot operation",
    )
    require(re.fullmatch(r"graphene-join-[a-f0-9]{16}-(validator|sentry)", data["project"]), "Invalid participant project")
    compose = json.loads((directory / "compose.json").read_text())
    network = json.loads((directory / "network.json").read_text())
    require(
        network["network_id"] == data["networkId"]
        and str(network["chain_id"]) == str(data["chainId"]),
        "Wrong snapshot network",
    )
    require(
        re.fullmatch(r"[^\s]+@sha256:[a-f0-9]{64}", data["helperImage"]),
        "Use a pinned snapshot helper image",
    )
    endpoint = authenv.get("DOCKER_HOST") or command(
        ["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]
    ).strip()
    require(
        endpoint.startswith("unix://"),
        "Snapshot operations require the host local Docker engine",
    )
    env = {**authenv, "DOCKER_HOST": endpoint}
    env.pop("DOCKER_DEFAULT_PLATFORM", None)
    env.pop("DOCKER_CONTEXT", None)
    base = ["docker", "compose", "--project-name", data["project"], "-f", "compose.json"]

    def docker(args, input=None, timeout=900, cwd=directory):
        return command(args, cwd=cwd, env=env, input=input, timeout=timeout)

    def rpc(route, cwd=directory):
        return json.loads(
            docker(
                [
                    *base,
                    "exec",
                    "-T",
                    "node",
                    "wget",
                    "-qO-",
                    "http://127.0.0.1:26657/" + route,
                ],
                cwd=cwd,
            )
        )["result"]

    def files(action, extra=None):
        payload = {
            **data,
            **(extra or {}),
            "action": action,
            "localVerification": False,
        }
        payload.pop("fileHelper", None)
        payload.pop("hostHelper", None)
        payload.pop("registry", None)
        args = [
            "docker",
            "run",
            "--rm",
            "-i",
            "--network",
            "none",
            "--user",
            "0",
            "-e",
            "GRAPHENE_SNAPSHOT_HELPER=1",
            "-v",
            str(directory) + ":/node",
        ]
        try:
            result = command(
                [
                    *args,
                    "--entrypoint",
                    "node",
                    data["helperImage"],
                    "--input-type=module",
                    "-e",
                    data["fileHelper"],
                ],
                env=env,
                input=json.dumps(payload),
                timeout=3600,
            )
        except subprocess.CalledProcessError as error:
            raise ValueError(
                (error.stderr or "Snapshot file helper failed").strip()[-600:]
            ) from None
        return json.loads(result)

    def sql(text, cwd=directory):
        return docker(
            [
                *base,
                "exec",
                "-T",
                "abci-db",
                "sh",
                "-ec",
                'PGPASSWORD="$POSTGRES_PASSWORD" psql -v ON_ERROR_STOP=1 -U postgres -d grapheneDB -At',
            ],
            input=text,
            cwd=cwd,
        )

    schema = compose["services"]["abci"]["environment"]["APP_ABCI_DB_SCHEMA"]
    require(re.fullmatch("[a-z_][a-z0-9_]*", schema), "Invalid ABCI schema")

    return restore_runtime(data, directory, docker, sql, rpc, files)


def restore_runtime(data, directory, docker, sql, rpc, files, download_files=True):
    base = ["docker", "compose", "--project-name", data["project"], "-f", "compose.json"]
    m = data["envelope"]["manifest"]
    require(
        m.get("schema") == 2 and m.get("kind") == "graphene-state-snapshot",
        "Choose a full snapshot",
    )
    work = directory / "data/.checkpoint-work" / data["id"]
    work.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Signature is checked offline before network downloads as well as before data writes.
    if download_files:
        files("validate")
        size = sum(f["bytes"] + f.get("unpackedBytes", 0) for f in m["files"].values())
        require(
            shutil.disk_usage(directory / "data").free > size + 1024**3,
            "Not enough free disk for verified snapshot staging",
        )
        download(data["baseUrl"], data["id"], m["files"], work / "capture")
    raw = docker([*base, "ps", "--all", "--format", "json"], cwd=directory).strip()
    running = (
        json.loads(raw)
        if raw.startswith("[")
        else [json.loads(line) for line in raw.splitlines() if line.strip()]
    )
    if isinstance(running, dict):
        running = [running]
    journal = directory / ".checkpoint-restore.json"
    phase = json.loads(journal.read_text()).get("phase") if journal.is_file() else None
    completed = phase == "complete"
    require(
        completed
        or phase == "verified"
        or all(
            row.get("State") not in ("running", "restarting", "paused")
            for row in running
        ),
        "Stop the target before restoring a snapshot",
    )
    prepared = files("prepare")
    if prepared["phase"] == "complete":
        return {"restored": m["id"], "height": m["height"], "alreadyComplete": True}
    try:
        if prepared["phase"] == "verified":
            files("activate")
            docker(
                [*base, "up", "-d", "--wait", "--wait-timeout", "600"], cwd=directory
            )
            require(
                rpc("block?height=" + m["height"], cwd=directory)["block_id"]["hash"]
                == m["blockHash"],
                "Restored anchor differs on recovery",
            )
            files("complete")
            return {"restored": m["id"], "height": m["height"], "resumed": True}
        docker(
            [*base, "up", "-d", "--wait", "--wait-timeout", "120", "abci-db"],
            cwd=directory,
        )
        if prepared["phase"] == "prepared":
            # Run migrations without ever starting consensus; the MPT initialized here is still disposable.
            docker(
                [*base, "up", "-d", "--wait", "--wait-timeout", "180", "abci"],
                cwd=directory,
            )
        docker([*base, "stop", "--timeout", "60", "abci", "mpt"], cwd=directory)
        result = files("install")
        sql(result["sql"], cwd=directory)
        docker(
            [*base, "up", "-d", "--wait", "--wait-timeout", "120", "mpt"], cwd=directory
        )
        root = json.loads(
            docker(
                [
                    *base,
                    "exec",
                    "-T",
                    "mpt",
                    "sh",
                    "-ec",
                    'wget -qO- --header="Authorization: Bearer $MPT_DB_API_TOKEN" '
                    'http://127.0.0.1:3000/graphene-mpt/blocks/root',
                ],
                cwd=directory,
            )
        )["root"]
        require(
            root.removeprefix("0x").lower() == m["appHash"].lower(),
            "Restored trie root differs from the signed snapshot",
        )
        docker([*base, "stop", "--timeout", "60", "mpt"], cwd=directory)
        files("finish", {"appHash": root.removeprefix("0x")})
        files("activate")
        docker([*base, "up", "-d", "--wait", "--wait-timeout", "600"], cwd=directory)
        status = rpc("status", cwd=directory)
        require(
            status["node_info"]["network"] == m["genesis"]["chain_id"]
            and int(status["sync_info"]["latest_block_height"]) >= int(m["height"]),
            "Restored node did not start on the checkpoint chain",
        )
        anchor = rpc("block?height=" + m["height"], cwd=directory)
        require(
            anchor["block_id"]["hash"] == m["blockHash"],
            "Restored consensus database differs from the snapshot anchor",
        )
        files("complete")
        return {
            "restored": m["id"],
            "height": m["height"],
            "currentHeight": status["sync_info"]["latest_block_height"],
        }
    except BaseException:
        # Never erase data or signing history to "fix" a partially installed snapshot.
        write(
            directory / ".rollout-fence.json",
            {
                "kind": "snapshot-restore",
                "operationId": data["id"],
                "error": "Restore requires inspection/retry",
            },
        )
        docker([*base, "stop", "--timeout", "60"], cwd=directory)
        raise


if __name__ == "__main__":
    os.umask(0o077)
    try:
        print(json.dumps(operate(json.load(sys.stdin))))
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print("Snapshot operation failed: " + str(error)[:600], file=sys.stderr)
        sys.exit(1)
