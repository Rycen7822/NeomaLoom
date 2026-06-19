import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "hermes-plugin" / "noemaloom"))

from noemaloom_bridge import _format_exception


def test_bridge_formats_nested_exception_groups():
    nested = ExceptionGroup("outer", [RuntimeError("inner boom"), ValueError("bad value")])

    message = _format_exception(nested)

    assert "ExceptionGroup: outer" in message
    assert "RuntimeError: inner boom" in message
    assert "ValueError: bad value" in message
