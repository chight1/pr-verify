"""When a package, or one version of it, first appeared on the npm registry, PyPI,
the Go module proxy, vcpkg's curated registry or ConanCenter, and whether an
advisory names a version as a fix. Each date lookup returns None when the
registry has no such package or version.
"""

from __future__ import annotations

import gzip
import http.client
import json
import os
import re
import sys
import urllib.parse
from dataclasses import dataclass
from datetime import datetime
from functools import cache
from typing import TYPE_CHECKING, Any

from requirement import normalized

if TYPE_CHECKING:
    from collections.abc import Callable

REQUEST_TIMEOUT_SECONDS = 20
HTTP_OK = 200
MISSING_STATUSES = frozenset({404, 410})
GO_VERSION = re.compile(r"^v(\d+)\.(\d+)\.(\d+)")
OSV_ECOSYSTEMS = {"npm": "npm", "pypi": "PyPI", "go": "Go", "conan": "ConanCenter"}
CONAN_CENTER = "center2.conan.io"
# The page GitHub's Link header names as a paged listing's last.
LAST_PAGE = re.compile(r'[?&]page=(\d+)>; rel="last"')


class RegistryError(Exception):
    """A registry answered with neither the package nor its absence."""


@dataclass(frozen=True)
class Response:
    # None when the registry has no such package.
    body: bytes | None
    # GitHub's Link header, which names the other pages of a paged listing.
    link: str


def request(
    host: str,
    path: str,
    query: bytes | None = None,
    extra_headers: dict[str, str] | None = None,
) -> Response:
    """An HTTPS GET, or a POST when there is a query to send."""
    connection = http.client.HTTPSConnection(host, timeout=REQUEST_TIMEOUT_SECONDS)
    headers = {"Accept": "application/json", "Accept-Encoding": "gzip"}
    headers.update(extra_headers or {})
    method = "GET"
    if query is not None:
        method = "POST"
    try:
        connection.request(method, path, body=query, headers=headers)
        response = connection.getresponse()
        body = response.read()
    finally:
        connection.close()
    link = response.getheader("Link", "")
    if response.status in MISSING_STATUSES:
        return Response(None, link)
    if response.status != HTTP_OK:
        message = f"https://{host}{path} answered {response.status}"
        raise RegistryError(message)
    if response.getheader("Content-Encoding") == "gzip":
        body = gzip.decompress(body)
    return Response(body, link)


def fetch(host: str, path: str, query: bytes | None = None) -> bytes | None:
    """The body of a request, or None when the registry has no such package."""
    return request(host, path, query).body


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


def github_headers() -> dict[str, str]:
    """GitHub's API refuses a request without a User-Agent, and the workflow's
    token raises its rate limit."""
    headers = {"User-Agent": "pr-verify"}
    token = os.environ.get("GH_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def vcpkg_created(port: str) -> datetime | None:
    """When the port was added to vcpkg's curated registry: the date of the
    oldest commit that touched its folder, the last page of a listing one
    commit to a page. A port the registry has since removed has no folder."""
    folder = f"ports/{urllib.parse.quote(port)}"
    if (
        fetch(
            "raw.githubusercontent.com", f"/microsoft/vcpkg/master/{folder}/vcpkg.json"
        )
        is None
    ):
        return None
    commits_path = f"/repos/microsoft/vcpkg/commits?path={folder}&per_page=1"
    first_page = request("api.github.com", commits_path, extra_headers=github_headers())
    last_page = LAST_PAGE.search(first_page.link)
    oldest_page = first_page
    if last_page is not None:
        oldest_path = f"{commits_path}&page={last_page.group(1)}"
        oldest_page = request(
            "api.github.com", oldest_path, extra_headers=github_headers()
        )
    commits: list[dict[str, Any]] = json.loads(oldest_page.body or b"[]")
    if not commits:
        return None
    return datetime.fromisoformat(commits[0]["commit"]["committer"]["date"])


def conan_revision_times(name: str, version: str) -> dict[str, datetime] | None:
    """When ConanCenter published each recipe revision of a version."""
    reference = f"{urllib.parse.quote(name)}/{urllib.parse.quote(version)}"
    listing = fetch_json(CONAN_CENTER, f"/v2/conans/{reference}/_/_/revisions")
    if listing is None:
        return None
    # Times such as 2025-12-09T12:51:39.337+0000.
    return {
        revision["revision"]: datetime.strptime(
            revision["time"], "%Y-%m-%dT%H:%M:%S.%f%z"
        )
        for revision in listing["revisions"]
    }


def conan_released(name: str, version: str) -> datetime | None:
    """When ConanCenter published a version, given as version#revision when a
    lockfile names the revision, which is then the time that counts."""
    plain_version, _, revision = version.partition("#")
    times = conan_revision_times(name, plain_version)
    if times is None:
        return None
    if revision:
        return times.get(revision)
    return min(times.values(), default=None)


def conan_created(name: str) -> datetime | None:
    """When ConanCenter published the package's earliest version it still has."""
    search = fetch_json(
        CONAN_CENTER, f"/v2/conans/search?q={urllib.parse.quote(name)}/*"
    )
    published: list[datetime] = []
    # Each result is a reference such as zlib/1.3.1@_/_.
    for reference in (search or {}).get("results", []):
        found_name, _, rest = str(reference).partition("/")
        if found_name != name:
            continue
        released = conan_released(name, rest.split("@", 1)[0])
        if released is not None:
            published.append(released)
    return min(published, default=None)


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
    """Whether a published advisory names this version as a vulnerability's fix.
    Advisories name a Conan version without its recipe revision."""
    plain_version = version.partition("#")[0]
    for advisory in osv_advisories(ecosystem, name):
        if "withdrawn" in advisory:
            continue
        if plain_version in fixed_versions(advisory, ecosystem, name):
            return True
    return False


CREATED: dict[str, Callable[[str], datetime | None]] = {
    "npm": npm_created,
    "pypi": pypi_created,
    "go": go_created,
    "vcpkg": vcpkg_created,
    "conan": conan_created,
}
# vcpkg has no lockfile: its versions come from the registry commit vcpkg.json
# names as its baseline.
RELEASED: dict[str, Callable[[str, str], datetime | None]] = {
    "npm": npm_released,
    "pypi": pypi_released,
    "go": go_released,
    "conan": conan_released,
}
