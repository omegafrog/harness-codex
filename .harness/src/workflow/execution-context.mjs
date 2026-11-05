import { createHash } from 'node:crypto';

export function instructionVersion(content) {
  return createHash('sha256').update(content).digest('hex');
}

export function isCompactionEvent(event) {
  return /compaction|compacted|context.*reset|history.*truncat/i.test([event?.type, event?.item_type, event?.subtype].filter(Boolean).join(' '));
}

export function isCancellationOutcome({ requested, signal, code }) {
  return Boolean(requested && (['SIGTERM', 'SIGINT'].includes(signal) || [130, 143].includes(code)));
}

export function buildStagePrompt({ guide, guideContent, guideVersion, profile = null, profileContent = null, profileVersion = null, instructionVersions = [], instructionContents = [], resumeSession, previousDelivery, answersPath, feedbackPath, sandbox, root, inputPath, executionDirectory = null, artifactDirectories = null, workflowPhase = null }) {
  const sameGuide = previousDelivery?.guide === guide && previousDelivery?.guide_version === guideVersion;
  const sameProfile = !profile || previousDelivery?.profile === profile && previousDelivery?.profile_version === profileVersion;
  const compacted = Boolean(resumeSession && previousDelivery?.compaction_observed);
  const rereadGuide = !resumeSession || !sameGuide || compacted;
  const rereadProfile = Boolean(profile && (!resumeSession || !sameProfile || compacted));
  const previousVersions = new Map(previousDelivery?.instruction_versions || []);
  const changedInstructions = resumeSession ? instructionVersions.filter(([path, version]) => previousVersions.get(path) !== version).map(([path]) => path) : [];
  const instructionBodies = instructionContents.filter(({ path }) => !resumeSession || compacted || changedInstructions.includes(path));
  const phase = workflowPhase ? ` Current workflow phase: ${workflowPhase}.` : '';
  const entry = `${rereadGuide ? `\n\nCurrent stage guide (${guide}):\n${guideContent}` : ''}${rereadProfile ? `\n\nCurrent agent profile (${profile}):\n${profileContent}` : ''}${instructionBodies.map(({ path, content }) => `\n\nCurrent phase instructions (${path}):\n${content}`).join('')}`;
  const recovery = compacted ? ' The provider recorded a context compaction boundary; reload the current stage guide and restore any essential rules from its authoritative references.' : resumeSession && (!sameGuide || !sameProfile) && previousDelivery ? ' Stage instructions changed since the prior delivery; reload the changed instructions before continuing.' : '';
  const changed = changedInstructions.length ? ` Related instructions changed since the prior execution: ${changedInstructions.join(', ')}. Reload changed guidance that applies to the current phase.` : '';
  const continuation = resumeSession ? ' Continue the assigned stage in this same native conversation from its current phase; preserve prior decisions and user constraints.' : '';
  const prompt = `The execution workspace is ${root}. Read the execution input at ${inputPath}.${executionDirectory ? ` The runner resolved this execution's runtime directory as ${executionDirectory}; the runner owns the result and return files.` : ''}${artifactDirectories ? ` The runner resolved the plan set's Spec directory as ${artifactDirectories.specs} and plan directory as ${artifactDirectories.plans}.` : ''}${entry}${answersPath ? ` Read the user's answers from ${answersPath}.` : ''}${feedbackPath ? ` Read execution feedback from ${feedbackPath} and correct the previous request.` : ''}${phase}${recovery}${changed}${continuation}${sandbox === 'read-only' ? ' This execution cannot write files. Return any newly produced report as result.artifact_contents with a filename, kind and full text; the caller will save it in the session. Include existing artifacts only as references.' : ''} Perform the assigned skill and return its result in the required schema. The caller validates the return and records execution state. Follow the user's stopping conditions in the input.`;
  return { prompt, delivery: { guide, guide_version: guideVersion, profile, profile_version: profileVersion, phase: workflowPhase || 'entry', instruction_versions: instructionVersions, injected_instruction_versions: instructionBodies.map(({ path, version }) => [path, version]), resumed: Boolean(resumeSession), reread: rereadGuide || rereadProfile || instructionBodies.length > 0, compaction_observed: false } };
}
