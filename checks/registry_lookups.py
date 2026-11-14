"""When a package, or one version of it, first appeared on the npm registry, PyPI
or the Go module proxy, and whether an advisory names a version as a fix. Each
date lookup returns None when the registry has no such package or version.
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

from manifest_parsing import normalized

if TYPE_CHECKING:
    from collections.abc import Callable

REQUEST_TIMEOUT_SECONDS = 20
HTTP_OK = 200
MISSING_STATUSES = frozenset({404, 410})
GO_VERSION = re.compile(r"^v(\d+)\.(\d+)\.(\d+)")
OSV_ECOSYSTEMS = {"npm": "npm", "pypi": "PyPI", "go": "Go"}


class RegistryError(Exception):
    """A registry answered with neither the package nor its absence."""


def fetch(host: str, path: str, query: bytes | None = None) -> bytes | None:
    """The body of an HTTPS GET, or of a POST when there is a query to send, or
    None when the registry has no such package."""
    connection = http.client.HTTPSConnection(host, timeout=REQUEST_TIMEOUT_SECONDS)
    headers = {"Accept": "application/json", "Accept-Encoding": "gzip"}
    method = "GET"
    if query is not None:
        method = "POST"
    try:
        connection.request(method, path, body=query, headers=headers)
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


def fetch_json(
    host: str, path: str, query: dict[str, Any] | None = None
) -> dict[str, Any] | None:
    encoded_query = None
    if query is not None:
        encoded_query = json.dumps(query).encode()
    body = fetch(host, path, encoded_query)
    if body is None:
        return None
    return json.loads(body)


@cache
def npm_package(name: str) -> dict[str, Any] | None:
    """The package's full document, which holds every version's publish time."""
    return fetch_json("registry.npmjs.org", f"/{urllib.parse.quote(name, safe='@')}")


def npm_created(name: str) -> datetime | None:
    package = npm_package(name)
    if package is None:
        return None
    return datetime.fromisoformat(package["time"]["created"])


def npm_released(name: str, version: str) -> datetime | None:
    package = npm_package(name)
    if package is None or version not in package["time"]:
        return None
    return datetime.fromisoformat(package["time"][version])


def earliest_upload(files: list[dict[str, Any]]) -> datetime | None:
    """When the first of a release's files was uploaded."""
    uploads = [datetime.fromisoformat(file["upload_time_iso_8601"]) for file in files]
    return min(uploads, default=None)


def pypi_created(name: str) -> datetime | None:
    """When the package's first file was uploaded, in any release."""
    project = fetch_json("pypi.org", f"/pypi/{urllib.parse.quote(name)}/json")
    if project is None:
        return None
    files: list[dict[str, Any]] = []
    for release_files in project["releases"].values():
        files.extend(release_files)
    return earliest_upload(files)


def pypi_released(name: str, version: str) -> datetime | None:
    path = f"/pypi/{urllib.parse.quote(name)}/{urllib.parse.quote(version)}/json"
    release = fetch_json("pypi.org", path)
    if release is None:
        return None
    return earliest_upload(release["urls"])


def go_escaped(path: str) -> str:
    """A module path or version as the Go module proxy spells it: capitals as
    ! and the lowercase letter."""
    return re.sub(r"[A-Z]", lambda capital: "!" + capital.group(0).lower(), path)


def go_version_key(version: str) -> tuple[int, int, int]:
    """Sorts versions by number, with any that are not vX.Y.Z last."""
    match = GO_VERSION.match(version)
    if match is None:
        return (sys.maxsize, 0, 0)
    major, minor, patch = match.groups()
    return (int(major), int(minor), int(patch))


def go_version_time(module: str, version_path: str) -> datetime | None:
    path = f"/{go_escaped(module)}/{version_path}"
    version_info = fetch_json("proxy.golang.org", path)
    if version_info is None:
        return None
    return datetime.fromisoformat(version_info["Time"])


def go_released(module: str, version: str) -> datetime | None:
    return go_version_time(module, f"@v/{go_escaped(version)}.info")


def go_created(module: str) -> datetime | None:
    """When the module's earliest version was published."""
    listing = fetch("proxy.golang.org", f"/{go_escaped(module)}/@v/list")
    if listing is None:
        return None
    versions = listing.decode().split()
    # A module with no tagged versions has only pseudo-versions, found at @latest.
    if not versions:
        return go_version_time(module, "@latest")
    return go_released(module, min(versions, key=go_version_key))


def osv_advisories(ecosystem: str, name: str) -> list[dict[str, Any]]:
    """Every advisory OSV holds for a package, which includes GitHub's."""
    package = {"name": name, "ecosystem": OSV_ECOSYSTEMS[ecosystem]}
    query: dict[str, Any] = {"package": package}
    advisories: list[dict[str, Any]] = []
    while True:
        page = fetch_json("api.osv.dev", "/v1/query", query)
        if page is None:
            return advisories
        advisories.extend(page.get("vulns", []))
        if "next_page_token" not in page:
            return advisories
        query["page_token"] = page["next_page_token"]


def same_package(ecosystem: str, first: str, second: str) -> bool:
    if ecosystem == "pypi":
        return normalized(first) == normalized(second)
    return first == second


def range_fixes(version_range: dict[str, Any]) -> set[str]:
    """The versions an advisory's version range names as fixed."""
    fixes: set[str] = set()
    for event in version_range["events"]:
        if "fixed" in event:
            fixes.add(event["fixed"])
    return fixes


def fixed_versions(advisory: dict[str, Any], ecosystem: str, name: str) -> set[str]:
    """The versions an advisory names as fixing the package."""
    fixes: set[str] = set()
    for affected in advisory.get("affected", []):
        affected_name = affected.get("package", {}).get("name", "")
        if not same_package(ecosystem, affected_name, name):
            continue
        for version_range in affected.get("ranges", []):
            fixes.update(range_fixes(version_range))
    if ecosystem == "go":
        # OSV writes Go versions without their leading v.
        return {f"v{fix}" for fix in fixes}
    return fixes


def fixes_advisory(ecosystem: str, name: str, version: str) -> bool:
    """Whether a published advisory names this version as a vulnerability's fix."""
    for advisory in osv_advisories(ecosystem, name):
        if "withdrawn" in advisory:
            continue
        if version in fixed_versions(advisory, ecosystem, name):
            return True
    return False


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
