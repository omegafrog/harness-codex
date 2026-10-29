# Public Skill Routing cases

이 fixture는 [what-the-jev Skill Routing 실험 데이터](https://keta1930.github.io/what-the-jev/experiments/skill-routing/)에서 8개 사례의 요청, 후보 skill 설명, gold label을 가져왔습니다. 원본 데이터는 [고정 commit](https://github.com/keta1930/what-the-jev/tree/eec463d5b2722d73386738a5e3a69d391a6b3af1/experiments/skill-routing)에 있으며 MIT License입니다. 원본 sample ID, 후보 설명, label, 요청 문구는 samples.json에 보존했습니다.

이 평가는 공개 데이터에서 가져온 8개 사례에 대한 Harness 라우팅 평가이며, 원 보고서의 점수를 Codex 결과로 해석하지 않습니다. 원본 label은 atomic skill ID 목록이므로 후보 bundle 이름은 component ID로 풀어 출력하도록 적용했습니다. 각 case의 `expected_json`은 결과 JSON을 gold label과 결정적으로 대조하며, quality grader 점수는 별도로 유지합니다.
