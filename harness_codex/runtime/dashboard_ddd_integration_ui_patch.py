"""Expose the ChangeSet-level DDD integration gate in the browser dashboard."""

from __future__ import annotations

from http import HTTPStatus
from pathlib import Path


_DDD_INTEGRATION_STAGE_ID = "ddd-design-integration"
_PATCHED_ATTR = "_harness_ddd_integration_ui_patch_applied"


def apply_dashboard_ddd_integration_ui_patch() -> None:
    """Add the integration stage to the dashboard without duplicating its asset."""

    from harness_codex.runtime import ui_server

    ui_server._RERUNNABLE_DESIGN_STAGE_IDS.add(_DDD_INTEGRATION_STAGE_ID)

    handler = ui_server.HarvestUiRequestHandler
    if getattr(handler, _PATCHED_ATTR, False):
        return

    original_write_asset = handler._write_asset

    def write_asset_with_ddd_integration(self, filename: str, content_type: str) -> None:
        if filename != "dashboard.js":
            original_write_asset(self, filename, content_type)
            return

        path = Path(ui_server.__file__).with_name("dashboard_assets") / filename
        if not path.exists():
            self._write_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return

        data = _patch_dashboard_script(path.read_text(encoding="utf-8")).encode("utf-8")
        self.send_response(HTTPStatus.OK.value)
        self.send_header("content-type", content_type)
        self.send_header("cache-control", "no-store")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    handler._write_asset = write_asset_with_ddd_integration
    setattr(handler, _PATCHED_ATTR, True)


def _patch_dashboard_script(script: str) -> str:
    """Inject one canonical workflow tab and its ChangeSet-level run surface."""

    if "function renderDddIntegrationWorkspace()" in script:
        return script

    patched = script
    patched = _replace_once(
        patched,
        '''    : app.stageTab === "dddArchitecture"
    ? renderDddArchitectureWorkspace()
    : app.stageTab === "implementation"''',
        '''    : app.stageTab === "dddArchitecture"
    ? renderDddArchitectureWorkspace()
    : app.stageTab === "dddIntegration"
    ? renderDddIntegrationWorkspace()
    : app.stageTab === "implementation"''',
        "workspace routing",
    )
    patched = _replace_once(
        patched,
        '''    const nextAction = technicalDecisionUseCases().length
      ? '<button class="primary next-stage" type="button" data-stage-tab="technicalDecisions">Open Technical Decisions</button>'
      : '<button class="primary next-stage" type="button" disabled>Technical Decisions document not available</button>';''',
        '''    const nextAction = '<button class="primary next-stage" type="button" data-stage-tab="dddIntegration">Open DDD Design Integration</button>';''',
        "DDD architecture next action",
    )
    patched = _replace_once(
        patched,
        "function technicalDecisionUseCases() {",
        '''function dddIntegrationStage() {
  const change = app.state.change_sets.find((item) => item.id === app.requirementsChangeSet);
  return change?.stages?.find((stage) => stage.id === "ddd-design-integration");
}

function renderDddIntegrationWorkspace() {
  const stage = dddIntegrationStage();
  const status = stage?.status || "pending";
  const verified = status === "verified";
  const nextAction = verified
    ? '<button class="primary next-stage" type="button" data-stage-tab="technicalDecisions">Open Technical Decisions</button>'
    : '<p class="small">Reconcile completed candidate DDD designs into the ChangeSet-level canonical contract before technical decisions.</p>';
  const rerun = renderWorkflowRerunPanel(
    "ddd-design-integration",
    "DDD Design Integration",
    "",
    nextAction,
    verified,
  );
  return `<section class="panel"><h3>DDD Design Integration</h3>
      <p><span class="pill ${escapeHtml(status)}">${escapeHtml(status)}</span></p>
      <p class="small">Runs <code>harness ddd-design-integration ${escapeHtml(app.requirementsChangeSet)} --apply</code>.</p>
      <p class="small">Produces the ChangeSet-level canonical integration contract consumed by Technical Decisions.</p>
    </section>
    ${renderGrillPanel("DDD Design Integration", rerun)}`;
}

function technicalDecisionUseCases() {''',
        "DDD integration workspace",
    )
    patched = _replace_once(
        patched,
        '''function renderWorkflowRerunPanel(stageId, label, ucId = "", nextAction = "") {''',
        '''function renderWorkflowRerunPanel(stageId, label, ucId = "", nextAction = "", complete = true) {''',
        "rerun panel completion input",
    )
    patched = _replace_once(
        patched,
        '''  const buttonLabel = question ? "Submit answer and rerun" : "Rerun and verify";''',
        '''  const buttonLabel = question ? "Submit answer and rerun" : complete ? "Rerun and verify" : "Run and verify";''',
        "rerun panel action label",
    )
    patched = _replace_once(
        patched,
        '''    <p class="completion">${escapeHtml(label)} complete.</p>
    <p class="small">Reruns this stage with <code>--force</code>, verifies output, and marks downstream design stale.</p>''',
        '''    ${complete ? `<p class="completion">${escapeHtml(label)} complete.</p>` : '<p class="small">This stage is not verified yet.</p>'}
    <p class="small">${complete ? "Reruns" : "Runs"} this stage with <code>--force</code>, verifies output, and marks downstream design stale.</p>''',
        "rerun panel completion summary",
    )
    patched = _replace_once(
        patched,
        '''  const dddDone = app.harvest?.ddd_architecture?.complete;
  const technicalAvailable = Boolean(technicalDecisionUseCases().length);
  const planningAvailable = technicalAvailable;
  const planItems = planningUseCases();
  const implementationAvailable = Boolean(planItems.length) && planItems.every((item) => item.plan?.path);
  const selected = app.state.change_sets.find((item) => item.id === app.requirementsChangeSet);
  const deliveryStage = selected?.stages?.find((stage) => stage.id === "change-set-pr");''',
        '''  const dddDone = app.harvest?.ddd_architecture?.complete;
  const selected = app.state.change_sets.find((item) => item.id === app.requirementsChangeSet);
  const integrationStage = selected?.stages?.find((stage) => stage.id === "ddd-design-integration");
  const dddIntegrationDone = integrationStage?.status === "verified";
  const technicalAvailable = Boolean(technicalDecisionUseCases().length);
  const planningAvailable = technicalAvailable;
  const planItems = planningUseCases();
  const implementationAvailable = Boolean(planItems.length) && planItems.every((item) => item.plan?.path);
  const deliveryStage = selected?.stages?.find((stage) => stage.id === "change-set-pr");''',
        "stage availability state",
    )
    patched = _replace_once(
        patched,
        '''    <button class="stage-tab ${app.stageTab === "dddArchitecture" ? "selected" : ""}" data-stage-tab="dddArchitecture" ${!eventsDone ? "disabled" : ""}>
      <span class="progress-dot ${dddDone ? "complete" : eventsDone ? "active" : ""}"></span>DDD Architecture
    </button>
    <button class="stage-tab ${app.stageTab === "technicalDecisions" ? "selected" : ""}" data-stage-tab="technicalDecisions" ${!dddDone || !technicalAvailable ? "disabled" : ""}>
      <span class="progress-dot ${technicalAvailable ? "complete" : dddDone ? "active" : ""}"></span>Technical Decisions''',
        '''    <button class="stage-tab ${app.stageTab === "dddArchitecture" ? "selected" : ""}" data-stage-tab="dddArchitecture" ${!eventsDone ? "disabled" : ""}>
      <span class="progress-dot ${dddDone ? "complete" : eventsDone ? "active" : ""}"></span>DDD Architecture
    </button>
    <button class="stage-tab ${app.stageTab === "dddIntegration" ? "selected" : ""}" data-stage-tab="dddIntegration" ${!dddDone ? "disabled" : ""}>
      <span class="progress-dot ${dddIntegrationDone ? "complete" : dddDone ? "active" : ""}"></span>DDD Design Integration
    </button>
    <button class="stage-tab ${app.stageTab === "technicalDecisions" ? "selected" : ""}" data-stage-tab="technicalDecisions" ${!dddIntegrationDone || !technicalAvailable ? "disabled" : ""}>
      <span class="progress-dot ${technicalAvailable ? "complete" : dddIntegrationDone ? "active" : ""}"></span>Technical Decisions''',
        "stage tabs",
    )
    patched = _replace_once(
        patched,
        '''    "ddd-architecture-definition",
    "technical-decisions",''',
        '''    "ddd-architecture-definition",
    "ddd-design-integration",
    "technical-decisions",''',
        "legacy rerun stage list",
    )
    patched = _replace_once(
        patched,
        '''  if (job.stage_id === "ddd-architecture-definition") return "dddArchitecture";
  if (job.stage_id === "technical-decisions") return "technicalDecisions";''',
        '''  if (job.stage_id === "ddd-architecture-definition") return "dddArchitecture";
  if (job.stage_id === "ddd-design-integration") return "dddIntegration";
  if (job.stage_id === "technical-decisions") return "technicalDecisions";''',
        "rerun recovery tab",
    )
    patched = _replace_once(
        patched,
        '''    } else if (["failed", "blocked"].includes(result.job?.status)) {
      app.error = result.job.error || "Stage rerun failed.";
      clearBusy();''',
        '''    } else if (["failed", "blocked"].includes(result.job?.status)) {
      if (result.job.dashboard) app.state = result.job.dashboard;
      app.error = result.job.error || "Stage rerun failed.";
      clearBusy();''',
        "rerun failure state refresh",
    )
    return patched


def _replace_once(script: str, source: str, target: str, label: str) -> str:
    if source not in script:
        raise RuntimeError(f"dashboard.js compatibility patch could not find {label}")
    return script.replace(source, target, 1)
