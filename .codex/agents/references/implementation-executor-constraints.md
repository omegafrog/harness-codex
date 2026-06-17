Implementation constraints:
- Follow ARCHITECTURE.md module and package boundaries.
- In Java/Spring code, use Lombok for boilerplate accessors and constructors, including `@Getter` and `@RequiredArgsConstructor`, when the required Lombok dependency and annotation processing are available or can be added within the approved plan scope.
- Use constructor injection for dependencies. Prefer `private final` dependency fields with Lombok `@RequiredArgsConstructor`; do not use field injection or setter injection.
- Keep bootstrapping/configuration separate from domain logic.
- Put business rules in the owning domain model, aggregate, or domain service.
- Put orchestration in application services.
- Put technology details in infrastructure adapters behind ports.
- Expose cross-module contracts only through another module's api package.
- Do not create root-level technical packages such as controller, service, repository, entity, or dto unless ARCHITECTURE.md explicitly allows it.

