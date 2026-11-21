# 공신력 있는 출처

기술 결정의 판정은 아래 등급 순서로 근거를 찾는다. 등급은 Source 스키마의 `tier`와 같다. 각 판정은 `knowledge/claims`에 저장한 Claim을 인용하며, Claim에는 원문 구절(`locator.excerpt`), 절·위치, 판(revision)·버전, 확인일을 남긴다. 아래 문서 번호와 URL은 예시이며 수집할 때 실제 판을 확인해 기록한다.

## 1. `formal_standards` — 표준 문서

의도, 필수 동작, 보안 요구의 1차 근거다. 절 번호까지 인용한다(예: RFC 6749 §10.4).

- IETF RFC (rfc-editor.org, datatracker.ietf.org): 인증·토큰(OAuth 2.0 RFC 6749, Bearer RFC 6750, JWT RFC 7519, PKCE RFC 7636, JWT BCP RFC 8725, OAuth 2.0 Security BCP RFC 9700, JWT Access Token RFC 9068, Revocation RFC 7009), HTTP(RFC 9110, Caching RFC 9111), Cookies RFC 6265, TLS 1.3 RFC 8446, Problem Details RFC 9457, Argon2 RFC 9106
- W3C: WebAuthn, Content Security Policy
- WHATWG: HTML, Fetch, URL Living Standard
- NIST: SP 800-63B(인증·비밀번호), SP 800-53, FIPS 140-3
- ISO/IEC·Ecma: ISO/IEC 9075(SQL), ECMA-262, ISO/IEC 27001

## 2. `industry_framework` — 업계 공인 기준

- OWASP: ASVS, Cheat Sheet Series(Password Storage, Session Management, Authentication), Top 10
- CIS Benchmarks: OS·DB·컨테이너 보안 설정
- OpenSSF, SLSA: 공급망·의존성 보안
- 클라우드 벤더 Well-Architected Framework: 해당 클라우드를 쓸 때만

## 3. `primary_technical` — 제품의 1차 공식 자료

제품의 기능·한계·지원 여부를 판정한다. 항상 버전을 고정한다.

- 공식 문서: 예) redis.io/docs, postgresql.org/docs/<버전>, docs.spring.io, docs.djangoproject.com, nodejs.org/docs
- 라이선스 원문과 공인 목록: 저장소 LICENSE, OSI 승인 목록(opensource.org/licenses), SPDX License List. 라이선스가 바뀐 제품은 판정 시점의 판을 인용한다.
- 릴리스 노트·지원 종료 일정: 제품 공식 changelog와 release/versioning policy
- 보안 권고: NVD/CVE(nvd.nist.gov), GitHub Security Advisories, 제품 공식 security 페이지

## 4. `established_expert` — 검증된 전문가 자료

설계 원칙과 트레이드오프 해석을 뒷받침한다: 동료 심사 논문(ACM, IEEE, USENIX, VLDB), 저자가 확인된 전문 서적, 표준 저자·제품 개발자의 기술 해설.

## 5. `empirical` — 실측과 외부 측정

성능·일관성·장애 동작의 근거다. 버전·하드웨어·부하 조건을 함께 기록한다: 프로젝트 자체 측정(`evidence` 절차), Jepsen 분석(jepsen.io), 공개 벤치마크(조건이 다르면 직접 비교하지 않는다).

## 6. `community` — 보조 자료

Stack Overflow, 개인 블로그, 포럼. 1~5등급 출처를 찾는 단서로만 쓰고 단독 근거로 인용하지 않는다. 검증 도구는 community 출처만으로 내린 판정을 거부한다.

## 판정별 우선 출처

| 판정 | 우선 출처 |
|---|---|
| 의도·필수 동작·보안 요구 | 1 → 2 |
| 제품 기능·한계·지원 여부 | 3 (버전 고정) |
| 라이선스·오픈소스 여부 | 3의 라이선스 원문 + OSI/SPDX |
| 성능·일관성 | 5 (조건 기록) → 3 |
| 설계 트레이드오프 해석 | 4 → 2 |

같은 기관의 문서 여러 개는 `independent_authority_id`로 묶어 독립 근거 하나로 센다.
