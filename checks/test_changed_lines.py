from changed_lines import DiffError, changed_code


def test_a_base_git_cannot_compare_with_is_an_error_not_no_changes() -> None:
    failed = False
    try:
        changed_code("0" * 40)
    except DiffError:
        failed = True
    assert failed
