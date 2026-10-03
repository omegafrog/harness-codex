# 시스템 목표

구조화된 목표 artifact는 [system-targets.yaml](./system-targets.yaml)이다. Engineering Decision Layer는 필요할 때 실행하는 로컬 workflow capability로 기술했다. 이 저장소는 production MAU, RPS, latency, availability, data volume 또는 job volume 목표를 정하지 않았으므로 관련 없는 서비스 지표를 숫자 목표로 추가하지 않았다.

관련 요구사항이나 측정된 workload가 생기면 해당 목표만 `initial`, `expected_growth` 또는 `architecture_boundary`에 추가한다. 값이 확정된 숫자 목표에는 단위, provenance, confidence, rationale을 기록한다. 관련 목표를 아직 모르면 정당한 추정 또는 조사 결과가 생길 때까지 명시적으로 미확정 상태로 둔다.
