## Output Format

Always output in this order:

1. 적용 기준
2. 전체 모듈 구조
3. 모듈별 패키지 구조
4. 패키지별 책임
5. 의존성 방향
6. 생성할 초기 파일 목록
7. ARCHITECTURE.md 내용
8. 금지 규칙
9. 검증 규칙 예시
10. 최종 복사용 구조

When files are created or patched, add a short implementation summary before the final structure:

- Created/changed files.
- Whether `ARCHITECTURE.md` was created or updated.
- Assumptions.
- Commands run.
- Verification result if any.

## File Creation Rules

When creating structure:

- Use `.gitkeep` to preserve empty directories.
- Create Gradle module directories only for modules requested by the user.
- Create package directories under `src/main/java/{rootPackagePath}/{modulePackage}`.
- Create test directories only when `includeTestStructure` is true.
- Create or update root `ARCHITECTURE.md`.
- Do not create domain classes.
- Do not create sample controllers, services, repositories, entities, DTOs, or use cases unless the user explicitly asks for starter code.
- If starter code is requested, keep it contract-only and avoid domain-specific names not supplied by the user.
