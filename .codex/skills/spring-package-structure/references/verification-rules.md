## Verification Rules To Suggest

Suggest these rules after structure generation:

- `..presentation..` must not depend on `..infrastructure..`.
- `..domain..` must not depend on `..application..`, `..presentation..`, or `..infrastructure..`.
- `..application..` must not depend on `..infrastructure..`.
- `..infrastructure..` may depend on `..domain..` and `..application.port.out..`.
- `{moduleA}` may depend on `{moduleB}.api`.
- `{moduleA}` must not depend on `{moduleB}.domain`, `{moduleB}.infrastructure`, or `{moduleB}.presentation`.

