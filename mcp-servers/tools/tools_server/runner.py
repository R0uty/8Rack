"""Runs one catalog command, with no shell, a timeout, output caps and path containment.

8Rack keeps the approval gate, scope check and history; this server just executes an already-approved
command and returns the raw stdout/stderr/exit code 8Rack's parsers need. Argv only - never a shell
string - so there's no quoting/word-splitting to abuse. The server owns path containment for its own
filesystem, because 8Rack's own workspace check is about a different machine.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import signal
import time
from pathlib import Path
from typing import TypedDict

from mcp.server.mcpserver.exceptions import ToolError

from .catalog import CommandSpec
from .config import Settings


class CommandResult(TypedDict):
    tool: str
    command: str
    stdout: str
    stderr: str
    exitCode: int | None
    success: bool
    timedOut: bool
    truncated: bool
    executionTimeMs: int


def _looks_like_path(arg: str) -> bool:
    return "/" in arg or arg in {".", ".."}


def _assert_args_contained(args: list[str], workspace_root: Path) -> None:
    """Mirrors 8Rack's toolManager path check, for this server's own filesystem. A path-shaped argument
    must resolve inside the workspace; a leading "~" is refused outright (it isn't tilde-expanded here,
    and a tool that expands it itself would read the real home directory)."""

    real_base = Path(os.path.realpath(workspace_root))
    for arg in args:
        if not isinstance(arg, str):
            raise ToolError("every argument must be a string")
        if arg.startswith("~"):
            raise ToolError(f'argument "{arg}" starts with "~" - use an absolute or workspace-relative path instead')
        if not _looks_like_path(arg):
            continue
        resolved = Path(os.path.realpath(real_base / arg))
        if resolved != real_base and real_base not in resolved.parents:
            raise ToolError(f'argument "{arg}" resolves outside the workspace root ({real_base})')


def _truncate(data: bytes, limit: int) -> tuple[str, bool]:
    truncated = len(data) > limit
    return data[:limit].decode("utf-8", "replace"), truncated


async def run_command(spec: CommandSpec, args: list[str], settings: Settings) -> CommandResult:
    if not isinstance(args, list) or any(not isinstance(a, str) for a in args):
        raise ToolError("arguments must be an array of strings")

    _assert_args_contained(args, settings.workspace_root)

    executable = shutil.which(spec.executable, path=os.environ.get("PATH")) or (
        spec.executable if os.path.isabs(spec.executable) and os.path.exists(spec.executable) else None
    )
    if executable is None:
        raise ToolError(f'the "{spec.id}" tool\'s executable ("{spec.executable}") is not installed on the scanning host')

    argv = [executable, *spec.default_args, *args]
    command = " ".join([spec.executable, *spec.default_args, *args])
    timeout = spec.timeout_s if spec.timeout_s is not None else settings.command_timeout_s

    started = time.monotonic()
    # New session so the whole process tree can be killed on timeout or when the client goes away -
    # as 8Rack's toolExecutor does. stdin is closed so a tool waiting on input can't hang forever.
    proc = await asyncio.create_subprocess_exec(
        *argv,
        cwd=str(settings.workspace_root),
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        start_new_session=True,
    )

    timed_out = False
    try:
        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            timed_out = True
            _kill_group(proc)
            stdout, stderr = await proc.communicate()
    except asyncio.CancelledError:
        # 8Rack aborted the request (cancel/disconnect) - kill the tree rather than orphan it.
        _kill_group(proc)
        raise

    out_text, out_trunc = _truncate(stdout or b"", settings.max_output_bytes)
    err_text, err_trunc = _truncate(stderr or b"", settings.max_output_bytes)
    exit_code = proc.returncode
    if timed_out:
        err_text = f"{err_text}\n(command timed out after {timeout:g}s)".lstrip("\n")

    return CommandResult(
        tool=spec.id,
        command=command,
        stdout=out_text,
        stderr=err_text,
        exitCode=exit_code,
        success=(exit_code == 0) and not timed_out,
        timedOut=timed_out,
        truncated=out_trunc or err_trunc,
        executionTimeMs=round((time.monotonic() - started) * 1000),
    )


def _kill_group(proc: asyncio.subprocess.Process) -> None:
    if proc.returncode is not None:
        return
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        try:
            proc.kill()
        except ProcessLookupError:
            pass
