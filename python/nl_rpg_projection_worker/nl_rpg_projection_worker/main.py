from __future__ import annotations

import json
import sys

from .protocol import handle_request


def main() -> int:
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            request = json.loads(line)
            response = handle_request(request)
        except Exception as error:  # pragma: no cover - process boundary
            response = {"ok": False, "command": "", "error": {"code": "invalid_json", "message": str(error)}}
        print(json.dumps(response, sort_keys=True), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
