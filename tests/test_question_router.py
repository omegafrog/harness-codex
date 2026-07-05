from harness_codex.runtime.question_router import _classify_intent


def test_explicit_implementation_request_routes_to_implementation() -> None:
    query = "이 기능은 구현 요청이야. 다음 단계로 어떻게 진행해야 해?"

    assert _classify_intent(query) == "implementation"


def test_plain_question_stays_question() -> None:
    assert _classify_intent("UC-001 구현은 어디에 있어?") == "question"


def test_direct_change_command_routes_to_implementation() -> None:
    assert _classify_intent("헬스 체크 응답에 version 필드를 추가해") == "implementation"
