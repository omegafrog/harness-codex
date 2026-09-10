# Architecture Spec

# 1. Design Scope

## 1.1 Target

| 항목 | 대상 |
|---|---|
| Product Spec | `docs/specs/496/product-spec.md` |
| Use Cases | UC-001, UC-002, UC-003 |
| Domain | 기술 harness capability; business domain 해당 없음 |
| Bounded Contexts | 기존 harness/control-plane context |
| Existing Services | `package.json`, `bin/harness-install.mjs` |
| External Dependencies | 실제 Codex, 통제된 `GitHub`/`MCP` adapters |
| Affected Data | `docs/plans/.runtime/{plan-id}/`, `.codex/evals/.runtime/{run-id}/` |

## 1.2 Product Spec Mapping

| Product Spec 항목 | Architecture 요소 |
|---|---|
| case execution | `runner.mjs` lifecycle, workspace, Codex adapter |
| suite evaluation | `report.mjs`, P0 thresholds, EfficiencyCollector |
| evidence diagnosis | trajectory/events/recording JSONL, `journal.mjs` |
| gates/outcome/quality | three grader modules |
| case state | execution result + cleanup finalization |

# 2. Domain Flow

## 2.1 Event Storming Flow

해당 없음 — business domain이 아니라 실행 관찰·분류 capability이다.

## 2.2 Commands

해당 없음 — business command를 도입하지 않는다.

## 2.3 Domain Events

해당 없음 — eval observation event만 JSONL로 기록한다.

## 2.4 Policies

해당 없음 — business policy가 아니라 hooks/gates이다.

## 2.5 Read Models

해당 없음 — `checkpoint.md`는 valid replay의 resume projection이다.

## 2.6 External Interactions

| External System | Trigger | Input | Output | Failure |
|---|---|---|---|---|
| `GitHub`/`MCP` | case action | normalized request | normalized response | missing/mismatch/schema mismatch → inconclusive; mutation default deny; live mutation은 dedicated `integration_resource` 범위에서만 허용 |

## 2.7 Hotspots

| Hotspot | Options | Decision |
|---|---|---|
| boundary | service/context/module/capability | 기존 context 내부 capability + thin Node package |
| recording | live/replay/stub | replay/stub 기본, explicit integration만 live |
| retry | runner/suite | runner 자동 retry 없음; 새 `run_id` |

# 3. DDD Architecture

## 3.1 Bounded Contexts

| Bounded Context | Responsibility | Ubiquitous Language | Owned Model | Owned Data |
|---|---|---|---|---|
| harness/control-plane | workflow invariants, evidence, gates, classification | Behavioral Eval, Hard Gate, Required Outcome, Trajectory, Recording | eval capability | runtime artifacts |

## 3.1.1 Boundary Decisions

| Capability | Owner Context | Candidate Boundary | Chosen Boundary | Why Not Weaker? | Why Not Stronger? |
|---|---|---|---|---|---|
| behavioral eval | harness/control-plane | capability/context/service | internal capability + thin package | 기존 context가 ownership과 consistency를 제공 | 독립 언어·state lifecycle·deployment 필요 없음 |

## 3.2 Context Map

해당 없음 — 새 bounded context와 business relationship을 만들지 않는다.

| Upstream | Downstream | Relationship | Contract | Translation |
|---|---|---|---|---|
| 해당 없음 | 해당 없음 | 해당 없음 | 해당 없음 | 해당 없음 |

## 3.3 Aggregates

해당 없음 — aggregate/entity/repository를 신설하지 않는다.

## 3.4 Entities

해당 없음 — business identity가 없다.

## 3.4.1 Class Diagram

모듈 및 port 책임을 표현한다. [eval.class.svg](diagrams/architecture/eval.class.svg)

## 3.5 Value Objects

해당 없음 — manifest/envelope는 DTO와 계약 자료이다.

## 3.6 Domain Services

해당 없음 — runner와 grader는 application/technical component이다.

## 3.7 Business Rule Ownership

해당 없음 — workflow invariants는 hooks와 deterministic gates가 소유한다.

## 3.8 Aggregate State Transitions

해당 없음 — case state는 aggregate state가 아니다.

## 3.8.1 State Diagram

execution_result와 cleanup을 분리한 eval 설계 상태이다. [eval-case.state.svg](diagrams/architecture/eval-case.state.svg)

## 3.9 Repository Boundaries

해당 없음 — 파일 artifact이며 repository abstraction이 없다.

# 4. Program Design

## 4.1 Program Structure

```text
bin/harness-eval.mjs -> src/eval/runner.mjs
runner -> case-loader, workspace, codex-adapter, recording, journal, graders, report
runner -> ExternalSystemPort <- GitHubStub/RecordingAdapter, MCPStub/RecordingAdapter, ExplicitIntegrationAdapter
```

## 4.2 Major Components and Responsibilities

| Component | Responsibility | Input | Output | Dependencies | Must Not Do |
|---|---|---|---|---|---|
| `runner.mjs` | provision→launch→observe→enforce→collect→grade→cleanup | case/suite | result/report | eval modules | orchestration/scheduler/agent loop |
| `case-loader.mjs` | manifest preflight | YAML | validated case | filesystem | invalid run |
| `case-workspace.mjs` | disposable case workspace lifecycle | case workspace | isolation evidence | filesystem/git | workflow orchestration |
| `plan-workspace.mjs` | plan resource scheduling and worktree lifecycle | resource graph | isolation evidence | git | commit/branch/merge |
| `codex-adapter.mjs` | process lifecycle | environment profile | trajectory | native process | workflow routing |
| `recording.mjs` | normalized external I/O | request/response | recording | port | live fallback |
| `journal.mjs` | append/replay/recovery | events | projection | filesystem | reverse history |
| `graders/*.mjs` | hard/outcome/quality grading | artifact bundle | grades | rubric/policy | direct provider calls |
| `report.mjs` | derived report | results | report | filesystem | source mutation |

## 4.3 Application Flow

```text
preflight -> provision -> launch -> observe -> hooks/gates -> collect -> grade -> execution result -> cleanup -> final state
```

## 4.4 Component Call Contracts

| Order | Caller | Callee | Operation | Input | Output | Failure |
|---:|---|---|---|---|---|---|
| 1 | runner | case-loader | `loadCase` | manifest | validated case | invalid_case_manifest |
| 2 | runner | workspace | `provision/cleanup` | graph/workspace | evidence | leak/cleanup failure |
| 3 | runner | CodexProcessAdapter | `launch/observe` | options | trajectory | timeout/crash |
| 4 | runner | ExternalSystemPort | `execute/record/replay` | normalized request | response | deny/mismatch |
| 5 | runner | graders | `grade` | artifact bundle | grade | inconclusive |

## 4.5 Major Types

| Type | Kind | Responsibility | State | Dependencies |
|---|---|---|---|---|
| ExternalSystemPort | Port | external boundary | execute/record/replay | adapters |
| CodexProcessAdapter | Adapter | process lifecycle | running/exit | native process |
| EventJournal | Application Service | JSONL replay | seq/recovery | filesystem |
| HookResult | DTO | hook result | pass/fail/blocked | rule/evidence |
| EvalResult | DTO | result | case state | grades/evidence |

## 4.6 Type Design

### EventJournal

| 항목 | 정의 |
|---|---|
| Kind | Application Service |
| Responsibility | append/replay, quarantine, checkpoint rebuild |
| Dependencies | filesystem |
| Must Not Depend On | workflow, GitHub, MCP |

#### State

| Field | Type | Meaning | Constraint |
|---|---|---|---|
| `stream_id` | string | stream identity | constant |
| `seq` | number | sequence | contiguous monotonic |

#### Behavior

| Method | Input | Output | Responsibility | State Change |
|---|---|---|---|---|
| `append(event)` | event | void | append, critical flush/fsync | append-only |
| `replay()` | path | valid prefix/recovery | validate JSON/schema/seq | atomic checkpoint |

#### Invariants

| Invariant | Enforcement Point |
|---|---|
| malformed final line quarantine; gap/duplicate corruption | replay |
| checkpoint never reconstructs history | projection writer |

## 4.7 Interfaces and Function Signatures

### ExternalSystemPort

```javascript
interface ExternalSystemPort {
  execute(request): Promise<NormalizedResponse>;
  record(request, response): Promise<void>;
  replay(request): Promise<NormalizedResponse>;
}
```

| 항목 | 정의 |
|---|---|
| Responsibility | normalized request/response와 side-effect 경계 |
| Caller | runner |
| Implementer | GitHubStub/RecordingAdapter, MCPStub/RecordingAdapter, ExplicitIntegrationAdapter |
| Preconditions | schema-valid manifest, recording mode |
| Errors | missing/mismatch/schema mismatch inconclusive; denied mutation failed |
| Side Effects | default none; dedicated test resource only |
| Idempotency | normalized request와 replay key 일치 |

## 4.8 Error Propagation

```text
failure -> classified event -> execution result -> independent cleanup -> final state
```

| Failure Point | Source Error | Converted Error | Handler | Result |
|---|---|---|---|---|
| Codex | timeout | agent_execution_timeout | adapter/runner | failed |
| runner/infra | crash/timeout | harness_runner_crash/infrastructure_timeout | runner | inconclusive |
| recording | missing/mismatch | missing_external_recording | port | inconclusive |
| workspace | dirty/failure | worktree_leak/workspace_cleanup_failure | workspace | inconclusive |

## 4.9 State Transition Implementation

| State Transition | Domain Owner | Method | Persistence Point | Published Event |
|---|---|---|---|---|
| planned → running | runner | `startCase()` | result/events | case_started |
| running → final | runner | `finalizeCase()` | result/report | case_finalized |

## 4.10 Dependency Rules

### Allowed Dependencies

| Source | Target | Contract |
|---|---|---|
| runner | eval modules/graders | explicit functions |
| runner | ExternalSystemPort | port only |
| adapters | external systems | adapter |

### Forbidden Dependencies

| Source | Forbidden Target |
|---|---|
| runner/graders | direct GitHub/MCP |
| eval package | spec-me orchestration, scheduler, reviewer spawning, agent loop |
| harness | global Codex config mutation, permission engine |

# 5. Technical Architecture

## 5.1 Boundary Mapping

| Bounded Context | Internal Capability | Code Boundary | Deployment Unit | Boundary Rationale |
|---|---|---|---|---|
| harness/control-plane | behavioral eval | `src/eval` + `bin/harness-eval.mjs` | existing Node process | 내부 seam이 요구 격리를 충족 |

## 5.2 Boundary Promotion Decisions

| Candidate | Owner Context | Chosen Boundary | Why Not Weaker? | Why Not Stronger? | Introduced Cost |
|---|---|---|---|---|---|
| eval runner | harness/control-plane | Package/Module | 책임별 import seam 필요 | 독립 배포/scale/failure lifecycle 없음 | module contract 관리 |

## 5.3 System Interaction Flow

```text
CLI -> runner -> CodexProcessAdapter -> real Codex/harness
runner -> ExternalSystemPort -> stub/recording
runner -> journal/artifacts -> graders -> report
```

## 5.4 Synchronous Communication

해당 없음 — Node internal calls이며 HTTP/gRPC를 추가하지 않는다.

## 5.5 API Contracts

해당 없음 — public API가 아니며 CLI/JS contracts만 있다.

## 5.6 Asynchronous Communication

해당 없음 — broker를 도입하지 않는다. JSONL은 evidence stream이다.

## 5.7 Message Contracts

해당 없음 — domain message가 아니다. envelope: `schema_version`, `stream_id`, `seq`, `timestamp`, `type`, `payload`.

## 5.8 Data Ownership

| Data | Owner | Storage | Key / Schema | Readers | Writers |
|---|---|---|---|---|---|
| plan runtime | workflow | `docs/plans/.runtime/{plan-id}/` | checkpoint.md/events.jsonl | resume | single writer |
| eval runtime | runner | `.codex/evals/.runtime/{run-id}/` | result/report/case artifacts | graders/reviewer | runner/journal |

Plan artifacts are `checkpoint.md`(resume projection)와 `events.jsonl`(append-only history)이고, eval artifacts는 `result.json`, `report.json`, case별 `trajectory.jsonl`, `events.jsonl`, `recording.jsonl`이다. 모두 runtime gitignored이며 GitHub tracker가 canonical status이다. Trajectory envelope은 `schema_version`, `stream_id`, `seq`, `timestamp`, `actor`(`codex`|`harness`|`external`), `kind`(`message`|`tool_call`|`tool_result`|`process_event`), optional `correlation_id`/`action`/`target`/`status`(`success`|`error`|`denied`|`cancelled`), normalized payload, `source`(`structured_event`|`stdout_fallback`)이다. Structured events가 우선이며 raw workspace/provider payload는 저장하지 않고 secret/credential을 redact한다.

Manifest는 `evals/cases/{case-id}.yaml`와 `evals/suites/{suite-id}.yaml`이며 `schema_version`, registry ID 기반 `required_outcome`/`hard_gates`, 각 Required Outcome의 `outcome_evidence`, `recording.mode`(`replay`|`none`|`live`)를 요구한다. `outcome_evidence`는 성공한 normalized `tool_result` action과 선택적인 repository-relative artifact 존재를 선언하며 final text self-report는 인정하지 않는다. Preflight에서 schema, references, fixtures, environment를 검증하고 실패하면 실행하지 않고 `phase: preflight`의 `inconclusive`로 기록한다.

## 5.9 Schema Changes

| Target | Action | Schema Change | Migration | Compatibility |
|---|---|---|---|---|
| event/trajectory/recording | Add | versioned required fields | preflight validation | mismatch inconclusive |

## 5.10 Consistency Model

| Operation | Consistency | Source of Truth | Synchronization | Recovery |
|---|---|---|---|---|
| event replay | strong contiguous | append-only JSONL | single writer/fsync | valid prefix |
| checkpoint | projection | replay | atomic replace | rebuild only |
| result | derived | execution+cleanup | finalizer | missing evidence inconclusive |

## 5.11 Infrastructure Dependencies

| Dependency | Responsibility | Accessed By | Isolation Boundary |
|---|---|---|---|
| filesystem/git | workspace/artifacts | workspace/journal | isolated worktree |
| Codex process | evaluation | adapter | native permission profile |

## 5.12 External Dependency Isolation

| External Dependency | Port | Adapter | Internal Model | Conversion Point |
|---|---|---|---|---|
| GitHub | ExternalSystemPort | GitHubStub/RecordingAdapter | normalized I/O | recording.mjs |
| MCP | ExternalSystemPort | MCPStub/RecordingAdapter | normalized I/O | recording.mjs |

## 5.13 File and Module Structure

### Existing Structure

```text
package.json
bin/harness-install.mjs
.codex/agents/*.toml
.codex/harness.yaml (tracker settings only)
```

### Target Structure

```text
bin/harness-eval.mjs
src/eval/{runner,case-loader,case-workspace,plan-workspace,codex-adapter,recording,journal,plan-journal,report}.mjs
src/eval/graders/{hard-gates,outcome,quality}.mjs
evals/cases/{case-id}.yaml
evals/suites/{suite-id}.yaml
```

### File Change Map

| Path | Action | Type / Component | Responsibility |
|---|---|---|---|
| `bin/harness-eval.mjs` | Add | entry | CLI |
| `src/eval/*.mjs` | Add | modules | thin eval capability |
| `evals/cases/{case-id}.yaml` | Add | manifest | case contract |
| `evals/suites/{suite-id}.yaml` | Add | manifest | suite contract |
| `.codex/harness.yaml` | Modify | config | eval defaults/policy |

# 6. Runtime Design

## 6.1 Runtime Flow

preflight → provision → launch/observe → hooks/gates → collect/grade → execution result → cleanup → final state.

## 6.2 Concurrent Access

| Shared Resource | Concurrent Actors | Conflict |
|---|---|---|
| write resources | runnable plans | shared write conflict |
| event stream | runner | duplicate writer/sequence gap |

## 6.3 Concurrency Control

| Target | Control Unit | Strategy | Owner | Timeout |
|---|---|---|---|---|
| plan execution | resource graph | only non-conflicting runnable plans parallel | scheduler | configured |
| event stream | stream | single writer | journal | bounded |

Scheduler가 dependency/resource graph를 계산한다. 두 개 이상의 runnable plan이 dependency를 만족하고 shared write resource가 없을 때만 병렬 실행한다. 각 parallel plan은 동일 fixed base에서 `git worktree add --detach isolated-path fixed_group_base`로 만든다. sequential dependency chain은 shared execution line/current workspace를 사용한다. Split plan은 Smart Zone 단위이지 병렬성 자체가 아니다. WorktreeManager는 base SHA/final HEAD SHA/dirty state를 보고하지만 commit/branch/merge하지 않는다. Journal은 worktree 밖에 둔다. evidence를 cleanup 전에 저장하고 implicit `--force`를 사용하지 않는다. leak/cleanup failure는 affected pool dispatch를 막지만 unrelated case는 중단하지 않는다.

## 6.4 Ordering

| Operation | Ordering Scope | Ordering Key | Enforcement |
|---|---|---|---|
| event append | stream | seq | contiguous validation |
| dependency chain | execution line | fixed base | shared workspace |

## 6.5 Transaction Boundaries

| Transaction | Owner | Operations | Commit Condition | Rollback Condition |
|---|---|---|---|---|
| execution | runner | result/evidence | persisted | classify |
| cleanup | workspace | reset/remove | clean verified | leak evidence |

## 6.6 Idempotency

| Operation | Idempotency Key | Detection Point | Duplicate Result |
|---|---|---|---|
| replay | stream_id:seq | journal | corruption |
| attempt | run_id | artifact path | new attempt only |

## 6.7 Partial Failure

| Failure Situation | Persisted State | External State | Recovery |
|---|---|---|---|
| Codex timeout | trajectory/result | no live fallback | failed |
| cleanup failure | both records | dirty workspace | inconclusive; pool block |
| malformed line | valid prefix/quarantine | unchanged | replay prefix |

# 7. Error Handling and Recovery

## 7.1 Failure and Recovery Flow

failure → classify → preserve evidence → cleanup → final state. Runner automatic retry는 false이며 suite/CI가 새 `run_id`로 explicit retry한다.

## 7.2 Error Classification

| Error | Category | Retryable | Handler | Caller Result |
|---|---|---|---|---|
| hard_gate_violation | policy | No | runner | failed |
| required_outcome_failure/quality_below_threshold | evaluation | No default | grader | failed |
| agent_execution_timeout | execution | No default | adapter | failed |
| harness_runner_crash/infrastructure_timeout | infrastructure | suite/CI | runner | inconclusive |
| invalid_case_manifest/corrupted_fixture | validation | after repair | preflight | inconclusive |

## 7.3 Retry Policy

| Operation | Retry Condition | Max Attempts | Backoff | Exhausted Result |
|---|---|---:|---|---|
| case | explicit inconclusive only | 1 default | suite/CI | all attempts preserved |

Case state는 `planned -> running -> passed|failed|inconclusive`이다. Failed reason은 `hard_gate_violation`, `required_outcome_failure`, `quality_below_threshold`, `case_hard_cap_exceeded`, `agent_execution_timeout`, `agent_execution_failure`; inconclusive reason은 `codex_process_crash_unattributable_to_case`, `harness_runner_crash`, `environment_provisioning_failure`, `infrastructure_timeout`, `missing_external_recording`, `corrupted_fixture`, `invalid_case_manifest`, `hook_execution_error`, `worktree_leak`, `workspace_cleanup_failure`이다.

## 7.4 Compensation

해당 없음 — 기본 live mutation이 없어 compensation transaction을 만들지 않는다.

## 7.5 Recovery

| Failure | Recovery Point | Recovery Input | Recovery Action |
|---|---|---|---|
| event corruption | last valid event | journal/evidence | checkpoint rebuild |
| worktree leak | cleanup boundary | worktree evidence | affected pool block |

## 7.6 Rollback

| Target | Rollback Strategy | Data Handling | Compatibility |
|---|---|---|---|
| workspace | cleanup/reset; implicit `--force` 금지 | evidence 보존 | cleanup 별도 기록 |
| artifacts | append/quarantine | 삭제 금지 | valid prefix replay |

# 8. Security

## 8.1 Authentication and Authorization

| Entry Point | Authentication | Authorization | Failure |
|---|---|---|---|
| CLI | native environment | native permission + harness policy | fail-closed |

## 8.2 Input Validation

| Input | Validation | Sanitization | Size Limit |
|---|---|---|---|
| YAML | schema_version, registry IDs, references, fixtures | normalized paths | configured |
| external response | schema/record match | normalized payload | configured |

## 8.3 Sensitive Data

| Data | Storage Protection | Transport Protection | Log Policy |
|---|---|---|---|
| trajectory/provider payload | gitignore, redaction | native sandbox/network restriction | secrets/credentials redacted |

## 8.4 Secrets

| Secret | Storage | Consumer | Rotation |
|---|---|---|---|
| credentials | native environment/secret store | explicit integration adapter | external policy |

Codex native permission은 executable action boundary, `ExternalSystemPort`는 external side-effect boundary, deterministic hooks/gates는 workflow invariant boundary이다. Harness는 permission engine이나 workspace trust model을 만들지 않으며 native permission denial과 workflow policy violation을 별도 event로 기록한다.

# 9. Observability

## 9.1 Logs

| Component | Event | Level | Context |
|---|---|---|---|
| journal | append/recovery/quarantine | INFO/WARN | stream_id, seq, run_id |
| runner | phase/state/failure | INFO/ERROR | run_id, case_id, reason |

## 9.2 Metrics

| Metric | Type | Labels | Trigger Point |
|---|---|---|---|
| case_duration | Histogram | suite/case/state | finalize |
| tokens/tool_calls/turns/handoffs | Histogram | case/model | collect |
| inconclusive_rate | Gauge | suite | report |

## 9.3 Tracing

| Span | Parent | Attributes | Error Condition |
|---|---|---|---|
| case run | suite run | run_id, case_id, phase | classified failure |
| external operation | case run | adapter, correlation_id | denied/mismatch |

## 9.4 Alerts

| Alert | Condition | Severity | Action |
|---|---|---|---|
| suite health failure | P0 threshold/critical inconclusive | Critical | CI/report failure |
| artifact corruption | gap/duplicate/quarantine | Warning | inspect |

# 10. Change Boundaries

## 10.1 Allowed Changes

| Target | Allowed Change |
|---|---|
| `src/eval`, `bin/harness-eval.mjs` | approved runner/adapters/journal/graders |
| `evals/cases`, `evals/suites` | schema-valid manifests/fixtures |
| `.codex/harness.yaml` | eval defaults/policy only |

## 10.2 Forbidden Changes

| Target | Forbidden Change |
|---|---|
| eval package | orchestration, scheduler, reviewer spawning, agent loop |
| adapters | default live mutation, production resources |
| Codex config | global mutation, permission engine/trust model |

## 10.3 Conditional Changes

| Target | Condition | Required Decision |
|---|---|---|
| ExplicitIntegrationAdapter | integration true | dedicated test resource |
| parallel worktree | ≥2 runnable, no shared write | scheduler graph permits |

# 11. Verification Requirements

## 11.1 Domain Verification

해당 없음 — business domain이 없으므로 contract/program test로 검증한다.

## 11.2 Program Verification

| Target | Verification |
|---|---|
| runner lifecycle | integration tests |
| ExternalSystemPort | adapter contract/direct-call denial |
| EventJournal | replay/fsync/quarantine |
| dependency rules | static/contract tests |

## 11.3 Technical Contract Verification

| Contract | Test Level | Verification |
|---|---|---|
| manifest schema/IDs | Contract | invalid case does not run |
| event/trajectory/recording | Contract | schema, seq, redaction, correlation |
| P0 thresholds | Integration | all thresholds and health gates |

P0 suite threshold는 `hard_gate_failures: 0`, `critical_case_pass_rate: 1.0`, `critical_inconclusive: 0`, `pass_rate: 0.95`, `mean_quality: 0.80`, `p10_quality: 0.65`, `overall_quality: 0.75`, `inconclusive_rate <= 0.05`, `minimum_conclusive_cases >= 0.95`, token regression `<= +20%`, latency regression `<= +25%`이다. `quality = 0.65 * task_quality + 0.35 * trajectory_quality`; QualityGrader는 fixed evaluator model/versioned rubric/artifact bundle만 사용하고 오류는 inconclusive이다. Efficiency는 baseline regression과 hard cap에만 사용한다.

## 11.4 Runtime Verification

| Condition | Execution Model | Expected Result |
|---|---|---|
| parallel eligibility | fixed group base, isolated worktrees | eligible plans only |
| sequential chain | shared workspace | continuity |
| stale agent reuse | repeated cases | no reuse |

## 11.5 Recovery Verification

| Failure | Injection Method | Expected Recovery |
|---|---|---|
| malformed line | invalid JSON final line | quarantine |
| gap/duplicate | event fixture mutation | corruption evidence |
| cleanup leak | dirty worktree/failing cleanup | inconclusive + pool block |
| hook crash/malformed output | test hook | hook_execution_error, fail-closed |

검증 범위에는 fail-fast/continue, direct external mutation denial, fixed group base, sequential chain continuity, hooks, manifest IDs, grader input restriction과 실제 Codex/실제 harness의 `spec-me`, `implement-wrapper`, `code-review` behavioral scenarios가 포함된다. UI~entity E2E는 현재 환경에서 unavailable이다.

## 11.6 Agent Verifier Criteria

### Domain

* [ ] capability와 Bounded Context 구분
* [ ] 새 context/aggregate/entity/repository 없음의 근거

### Program Design

* [ ] module 책임·signature·dependency 준수
* [ ] runner lifecycle 준수

### Technical Architecture

* [ ] ExternalSystemPort 경계 준수
* [ ] manifest/artifact/worktree contract 준수

### Runtime

* [ ] ordering·idempotency·cleanup 분리
* [ ] retry가 suite/CI 소유

### Scope

* [ ] 승인된 변경만 수행
* [ ] 불필요한 service/API/DB 없음

### Evidence

* 실행 명령: `node bin/harness-eval.mjs ...`
* 테스트 결과: policy/contract/unit/integration/behavioral eval
* 변경 파일: file change map
* Architecture 위반: rule_id/evidence path
* Contract 위반: schema/sequence/manifest mismatch
* 미검증 항목: UI~entity E2E — 현재 환경 제한
* Human Review 항목: fixed evaluator model/rubric/threshold

# 12. Alternatives and Trade-offs

| Decision | Option | Advantages | Disadvantages | Result |
|---|---|---|---|---|
| boundary | service | independent deployment | lifecycle/운영 비용 | Reject |
| boundary | internal capability/package | 최소 격리·일관성 | internal contract 관리 | Adopt |
| external I/O | live default | realism | side effects/non-determinism | Reject |
| external I/O | replay/stub | safety/reproducibility | recording 유지비 | Adopt |
| retry | runner automatic | convenience | cause masking | Reject |

# 13. Risks and Open Questions

## 13.1 Risks

| Risk | Impact | Probability | Mitigation |
|---|---|---|---|
| real Codex 변동성 | High | Medium | model/config/environment snapshot |
| recording drift | High | Medium | schema validation/no live fallback |
| worktree leak | High | Low | cleanup evidence/pool block |
| evaluator drift | Medium | Medium | fixed model/versioned rubric |

## 13.2 Open Questions

| Question | Blocking | Resolution |
|---|---|---|
| 없음 | No | 승인된 Product Spec, ADR-001~ADR-010 및 결정으로 확정. UI~entity E2E는 환경 제한으로 기록. |
