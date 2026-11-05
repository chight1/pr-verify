from datetime import UTC, datetime, timedelta

from new_dependencies import MINIMUM_VERSION_AGE, LockedVersion, age_problem

NOW = datetime(2026, 11, 5, tzinfo=UTC)
LABEL = str(LockedVersion("npm", "left-pad", "1.3.0"))


def test_a_version_the_registry_lacks_fails() -> None:
    problem = age_problem(LABEL, None, NOW, MINIMUM_VERSION_AGE)
    assert problem == "left-pad@1.3.0 (npm) is not on its registry. Check the name."


def test_a_version_under_the_minimum_age_fails() -> None:
    published = NOW - timedelta(days=3)
    problem = age_problem(LABEL, published, NOW, MINIMUM_VERSION_AGE)
    assert problem == "left-pad@1.3.0 (npm) is 3 days old, under the 7-day minimum."


def test_a_version_at_the_minimum_age_passes() -> None:
    published = NOW - MINIMUM_VERSION_AGE
    assert age_problem(LABEL, published, NOW, MINIMUM_VERSION_AGE) is None
