from __future__ import annotations

import json
import sys

from .protocol import handle_request

MAX_STDIN_LINE_BYTES = 1_000_000


def main() -> int:
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            if len(line.encode("utf-8", errors="replace")) > MAX_STDIN_LINE_BYTES:
                response = {"ok": False, "command": "", "error": {"code": "request_too_large", "message": "Feature worker request line exceeded size limit."}}
                print(json.dumps(response, sort_keys=True), flush=True)
                continue
            request = json.loads(line)
            response = handle_request(request)
        except Exception as error:  # pragma: no cover - process boundary
            response = {"ok": False, "command": "", "error": {"code": "invalid_json", "message": str(error)}}
        print(json.dumps(response, sort_keys=True), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
