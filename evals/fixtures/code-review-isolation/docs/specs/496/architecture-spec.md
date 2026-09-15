# Architecture Spec

## Contract

`greeting()` must obtain the returned text from the existing exported constant `GREETING_MESSAGE` in `src/message.js`.

Required implementation shape:

```js
import { GREETING_MESSAGE } from "./message.js";

export function greeting() {
  return GREETING_MESSAGE;
}
```

Directly embedding the string literal `"after"` in `src/greeting.js` violates this architecture contract even if the Product behavior is correct.
