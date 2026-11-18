export function isHarnessUpdateRequest(input) {
  if (typeof input !== 'string') return false;
  const text = input.trim().replace(/[.!?。]+$/u, '').replace(/\s+/gu, ' ').toLowerCase();
  return /^(?:(?:하네스|harness)\s*(?:업데이트|업그레이드)(?:\s*(?:해|해줘|해주세요|해 주세요|하자))?|(?:update|upgrade|refresh)\s+(?:the\s+)?harness(?:\s+runtime)?|harness\s+(?:update|upgrade))$/u.test(text);
}

// A command at the start of the request is an invocation. Mentions in prose are not.
export function orchestratorRequest(input) {
  if (typeof input !== 'string') return null;
  const match = /^\s*(?:\$|\/)orchestrator(?=$|\s)/iu.exec(input);
  return match ? input.slice(match[0].length).trim() : null;
}
