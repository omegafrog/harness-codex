# Default code-review rules

이 파일은 저장소에 더 구체적인 문서화 규칙이 없을 때 Standards 판단의 기본 기준이다.

## Principles

1. 동작의 정확성을 자동화된 테스트로 증명한다.
2. 코드는 구현 방법보다 작성자의 의도를 드러내야 한다.
3. 지식과 로직의 중복을 제거한다.
4. 현재 요구사항을 만족하는 가장 단순한 구조를 선택한다.
5. 예상되는 미래 요구만을 위한 기능이나 추상화를 추가하지 않는다.
6. 설계는 작은 동작 보존 리팩터링을 통해 지속적으로 개선한다.
7. 개인의 코드 스타일보다 팀 전체의 이해 가능성을 우선한다.

## Code smell baseline

- Mysterious Name
- Duplicated Code
- Long Method
- Large Class
- Feature Envy
- Data Clumps
- Shotgun Surgery
- Divergent Change
- Speculative Generality
- Message Chains
- Middle Man
- Refused Bequest

## Use

- 저장소에 더 구체적인 규칙이 있으면 그게 우선이다.
- 없으면 이 파일의 principles와 smell baseline을 따른다.
- 냄새는 hard violation이 아니라 판단 보조선이다.
