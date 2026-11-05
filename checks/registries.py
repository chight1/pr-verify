"""When a package, or one version of it, first appeared on the npm registry, PyPI
or the Go module proxy. Each lookup returns None when the registry has no such
package or version.
"""

from __future__ import annotations

import gzip
import http.client
import json
import re
import sys
import urllib.parse
from datetime import datetime
from functools import cache
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Callable

REQUEST_TIMEOUT_SECONDS = 20
HTTP_OK = 200
MISSING_STATUSES = frozenset({404, 410})
GO_VERSION = re.compile(r"^v(\d+)\.(\d+)\.(\d+)")


class RegistryError(Exception):
    """A registry answered with neither the package nor its absence."""


def normalized(name: str) -> str:
    """A Python package name as PyPI compares it."""
    return re.sub(r"[-_.]+", "-", name).lower()


def fetch(host: str, path: str) -> bytes | None:
    """The body of an HTTPS GET, or None when the registry has no such package."""
    connection = http.client.HTTPSConnection(host, timeout=REQUEST_TIMEOUT_SECONDS)
    headers = {"Accept": "application/json", "Accept-Encoding": "gzip"}
    try:
        connection.request("GET", path, headers=headers)
        response = connection.getresponse()
        body = response.read()
    finally:
        connection.close()
    if response.status in MISSING_STATUSES:
        return None
    if response.status != HTTP_OK:
        message = f"https://{host}{path} answered {response.status}"
        raise RegistryError(message)
    if response.getheader("Content-Encoding") == "gzip":
        return gzip.decompress(body)
    return body


def fetch_json(host: str, path: str) -> dict[str, Any] | None:
    body = fetch(host, path)
    return json.loads(body) if body is not None else None


@cache
def npm_package(name: str) -> dict[str, Any] | None:
    """The package's full document, which holds every version's publish time."""
    return fetch_json("registry.npmjs.org", f"/{urllib.parse.quote(name, safe='@')}")


def npm_created(name: str) -> datetime | None:
    package = npm_package(name)
    return datetime.fromisoformat(package["time"]["created"]) if package else None


def npm_released(name: str, version: str) -> datetime | None:
    package = npm_package(name)
    if package is None or version not in package["time"]:
        return None
    return datetime.fromisoformat(package["time"][version])


def earliest_upload(files: list[dict[str, Any]]) -> datetime | None:
    uploads = [datetime.fromisoformat(file["upload_time_iso_8601"]) for file in files]
    return min(uploads, default=None)


def pypi_created(name: str) -> datetime | None:
    project = fetch_json("pypi.org", f"/pypi/{urllib.parse.quote(name)}/json")
    if not project:
        return None
    files = [file for release in project["releases"].values() for file in release]
    return earliest_upload(files)


def pypi_released(name: str, version: str) -> datetime | None:
    path = f"/pypi/{urllib.parse.quote(name)}/{urllib.parse.quote(version)}/json"
    release = fetch_json("pypi.org", path)
    return earliest_upload(release["urls"]) if release else None


def go_escaped(path: str) -> str:
    """A module path or version as the Go module proxy spells it, with each
    capital letter as ! and its lowercase."""
    return re.sub(r"[A-Z]", lambda capital: "!" + capital.group(0).lower(), path)


def go_version_key(version: str) -> tuple[int, int, int]:
    match = GO_VERSION.match(version)
    if not match:
        return (sys.maxsize, 0, 0)
    major, minor, patch = match.groups()
    return (int(major), int(minor), int(patch))


def go_released(module: str, version: str) -> datetime | None:
    path = f"/{go_escaped(module)}/@v/{go_escaped(version)}.info"
    version_info = fetch_json("proxy.golang.org", path)
    return datetime.fromisoformat(version_info["Time"]) if version_info else None


def go_created(module: str) -> datetime | None:
    listing = fetch("proxy.golang.org", f"/{go_escaped(module)}/@v/list")
    if listing is None:
        return None
    versions = listing.decode().split()
    if not versions:
        latest = fetch_json("proxy.golang.org", f"/{go_escaped(module)}/@latest")
        return datetime.fromisoformat(latest["Time"]) if latest else None
    return go_released(module, min(versions, key=go_version_key))


CREATED: dict[str, Callable[[str], datetime | None]] = {
    "npm": npm_created,
    "pypi": pypi_created,
    "go": go_created,
}
RELEASED: dict[str, Callable[[str, str], datetime | None]] = {
    "npm": npm_released,
    "pypi": pypi_released,
    "go": go_released,
}
