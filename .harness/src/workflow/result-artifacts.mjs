import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

// A model-typed path to a file the stage does not own (earlier evidence, a log) can be mistyped. Only artifacts that the
// stage input declares as outputs must exist; any other artifact whose file is missing is dropped and the loss is noted.
export function dropMissingUndeclaredArtifacts({ result, outputs = [], baseDirectory }) {
  if (!Array.isArray(result.artifacts)) return [];
  const declared = new Set(outputs.map((output) => output.id));
  const dropped = [];
  result.artifacts = result.artifacts.filter((artifact) => {
    if (declared.has(artifact?.kind) || typeof artifact?.path !== 'string' || isAbsolute(artifact.path)) return true;
    const base = baseDirectory(artifact.base);
    if (!base || existsSync(join(base, artifact.path))) return true;
    dropped.push(`${artifact.kind}:${artifact.path}`);
    return false;
  });
  if (dropped.length) result.summary = `${result.summary} [Harness dropped ${dropped.length} undeclared artifact(s) whose file does not exist: ${dropped.join(', ')}]`;
  return dropped;
}
