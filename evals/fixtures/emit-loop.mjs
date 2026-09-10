for (let index = 0; index < 30; index += 1) {
  console.log(JSON.stringify({ kind: "message", actor: "codex", payload: { text: "loop" } }));
}
