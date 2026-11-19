from changed_lines import DiffError, changed_code, new_side_path


def test_a_base_git_cannot_compare_with_is_an_error_not_no_changes() -> None:
    failed = False
    try:
        changed_code("0" * 40)
    except DiffError:
        failed = True
    assert failed


def test_new_side_paths_read_as_git_writes_them() -> None:
    assert new_side_path("+++ b/src/app.py") == "src/app.py"
    assert new_side_path("+++ b/my file.py\t") == "my file.py"
    assert new_side_path('+++ "b/say \\"hi\\".py"') == 'say "hi".py'
    assert new_side_path("+++ /dev/null") is None
