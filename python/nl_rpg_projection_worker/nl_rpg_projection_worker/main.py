from __future__ import annotations

import json
import sys
from typing import BinaryIO, TextIO

from .protocol import handle_request

MAX_STDIN_LINE_BYTES = 1_000_000


def _line_has_newline(line: bytes | str) -> bool:
    return line.endswith(b"\n") if isinstance(line, bytes) else line.endswith("\n")


def _line_length(line: bytes | str) -> int:
    return len(line) if isinstance(line, bytes) else len(line.encode("utf-8", errors="replace"))


def _decode_line(line: bytes | str) -> str:
    return line.decode("utf-8", errors="replace") if isinstance(line, bytes) else line


def read_bounded_stdin_line(stream: BinaryIO | TextIO, max_bytes: int = MAX_STDIN_LINE_BYTES) -> str | None:
    line = stream.readline(max_bytes + 1)
    if line in (b"", ""):
        return None
    if _line_length(line) > max_bytes:
        while line and not _line_has_newline(line):
            line = stream.readline(8192)
        raise ValueError("stdin line too large")
    return _decode_line(line)


def main() -> int:
    stream = getattr(sys.stdin, "buffer", sys.stdin)
    while True:
        try:
            line = read_bounded_stdin_line(stream, MAX_STDIN_LINE_BYTES)
        except ValueError:
            response = {"ok": False, "command": "", "error": {"code": "request_too_large", "message": "Feature worker request line exceeded size limit."}}
            print(json.dumps(response, sort_keys=True), flush=True)
            continue
        if line is None:
            return 0
        if not line.strip():
            continue
        try:
            request = json.loads(line)
            response = handle_request(request)
        except Exception as error:  # pragma: no cover - process boundary
            response = {"ok": False, "command": "", "error": {"code": "invalid_json", "message": str(error)}}
        print(json.dumps(response, sort_keys=True), flush=True)


if __name__ == "__main__":
    raise SystemExit(main())
