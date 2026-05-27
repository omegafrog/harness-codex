const app = {
  state: { change_sets: [] },
  selectedChangeSet: null,
  openDocument: null,
  editorMode: "preview",
  view: "dashboard",
  harvest: null,
  requirementsChangeSet: null,
  stageTab: "requirements",
  eventSelectedUc: null,
  dddSelectedUc: null,
  dddSelectedStep: "entity_vo",
  workflowRecovered: false,
  busy: false,
  busyLabel: "",
  error: "",
  canvas: { scale: 1, x: 0, y: 0 },
  dddCanvas: { scale: 1, x: 0, y: 0 },
};

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

function markdownPreview(content) {
  const lines = String(content ?? "").split(/\r?\n/);
  const html = [];
  let listType = "";
  let listItems = [];
  const flushList = () => {
    if (!listType) return;
    html.push(`<${listType}>${listItems.map((item) => `<li>${renderInline(item)}</li>`).join("")}</${listType}>`);
    listType = "";
    listItems = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const heading = renderHeading(lines[index]);
    if (heading) {
      flushList();
      html.push(heading);
      continue;
    }
    const headers = splitTableRow(lines[index]);
    if (headers && isTableDivider(lines[index + 1], headers.length)) {
      flushList();
      const rows = [];
      index += 2;
      while (index < lines.length) {
        const cells = splitTableRow(lines[index]);
        if (!cells || cells.length !== headers.length) break;
        rows.push(cells);
        index += 1;
      }
      index -= 1;
      html.push(renderTable(headers, rows));
      continue;
    }
    const unordered = lines[index].match(/^\s*[-*]\s+(.+)$/);
    const ordered = lines[index].match(/^\s*\d+\.\s+(.+)$/);
    const nextListType = unordered ? "ul" : ordered ? "ol" : "";
    if (nextListType) {
      if (listType && listType !== nextListType) flushList();
      listType = nextListType;
      listItems.push((unordered || ordered)[1]);
      continue;
    }
    flushList();
    html.push(renderInline(lines[index]));
  }
  flushList();
  return html.join("\n");
}

function renderInline(text) {
  const codeSpans = [];
  const escaped = escapeHtml(text).replace(/`([^`]+)`/g, (_match, code) => {
    codeSpans.push(`<code>${code}</code>`);
    return `\u0000CODE${codeSpans.length - 1}\u0000`;
  });
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\u0000CODE(\d+)\u0000/g, (_match, index) => codeSpans[Number(index)]);
}

function renderHeading(line) {
  const heading = line.match(/^(#{1,3}) (.+)$/);
  if (!heading) return "";
  const level = Number(heading[1].length) + 1;
  return `<h${level}>${renderInline(heading[2])}</h${level}>`;
}

function splitTableRow(line) {
  if (typeof line !== "string" || !line.includes("|")) return null;
  let value = line.trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|") && !value.endsWith("\\|")) value = value.slice(0, -1);
  const cells = [];
  let cell = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\\" && value[index + 1] === "|") {
      cell += "|";
      index += 1;
    } else if (character === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  return cells.length > 1 ? cells : null;
}

function isTableDivider(line, columnCount) {
  const cells = splitTableRow(line);
  return cells?.length === columnCount
    && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function renderTable(headers, rows) {
  const head = headers.map((cell) => `<th class="${tableColumnClass(cell)}">${renderInline(cell)}</th>`).join("");
  const body = rows.map((row) => `<tr>${row.map((cell, index) => {
    const columnClass = tableColumnClass(headers[index] || "");
    return `<td class="${columnClass}"><div class="markdown-table-cell">${renderInline(cell)}</div></td>`;
  }).join("")}</tr>`).join("");
  return `<div class="markdown-table"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function tableColumnClass(header) {
  const normalized = stickyText(header).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const tallColumns = ["evidence", "pseudocode", "calls", "baseline-evidence", "event-storming-evidence", "policy-evidence", "attributes-vos", "proposed-definition", "atomic-invariant"];
  return tallColumns.includes(normalized) ? `column-${normalized} column-long` : `column-${normalized || "value"}`;
}

async function loadDashboard() {
  const response = await fetch("/api/dashboard");
  app.state = await response.json();
  if (!app.selectedChangeSet && app.state.change_sets.length) {
    app.selectedChangeSet = app.state.change_sets[0].id;
  }
  render();
  document.querySelector("#refresh-status").textContent = `Refreshed ${new Date().toLocaleTimeString()}`;
}

function render() {
  const changes = app.state.change_sets;
  const selected = changes.find((item) => item.id === app.selectedChangeSet) || changes[0];
  document.querySelector(".layout").classList.toggle("workflow-layout", app.view !== "dashboard");
  document.querySelector("#change-sets").innerHTML = changes.map((item) => `
    <button class="change-button ${selected?.id === item.id ? "selected" : ""}" data-change="${escapeHtml(item.id)}">
      <span class="pill ${item.lifecycle}">${escapeHtml(item.lifecycle)}</span>
      <strong>${escapeHtml(item.id)}</strong><br>
      <span class="small">${escapeHtml(item.title)}</span>
    </button>`).join("");
  document.querySelectorAll("[data-change]").forEach((node) => node.onclick = () => {
    app.selectedChangeSet = node.dataset.change;
    app.openDocument = null;
    app.error = "";
    app.eventSelectedUc = null;
    app.dddSelectedUc = null;
    app.canvas = { scale: 1, x: 0, y: 0 };
    app.dddCanvas = { scale: 1, x: 0, y: 0 };
    app.view = "dashboard";
    render();
  });
  const detail = document.querySelector("#detail");
  if (app.view === "new") {
    detail.innerHTML = renderNewChangeSet();
    document.querySelector("#initial-prompt-form").onsubmit = submitInitialPrompt;
    return;
  }
  if (app.view === "requirements") {
    detail.innerHTML = renderRequirementsWorkspace();
    if (app.stageTab === "requirements") renderEditor();
    if (app.stageTab === "eventStorming") renderEventDocumentEditor();
    if (app.stageTab === "dddArchitecture") renderDddDocumentEditor();
    const requirementForm = document.querySelector("#grill-form");
    if (requirementForm) requirementForm.onsubmit = submitRequirementAnswer;
    const useCaseForm = document.querySelector("#use-case-form");
    if (useCaseForm) useCaseForm.onsubmit = submitUseCaseAnswer;
    const startUseCases = document.querySelector("#start-use-cases");
    if (startUseCases) startUseCases.onclick = startUseCaseDefinition;
    const startEventStorming = document.querySelector("#start-event-storming");
    if (startEventStorming) startEventStorming.onclick = startEventStormingDefinition;
    const advanceEventStorming = document.querySelector("#advance-event-storming");
    if (advanceEventStorming) advanceEventStorming.onclick = continueEventStormingDefinition;
    const eventForm = document.querySelector("#event-storming-form");
    if (eventForm) eventForm.onsubmit = submitEventStormingAnswer;
    const startDdd = document.querySelector("#start-ddd-architecture");
    if (startDdd) startDdd.onclick = startDddArchitecture;
    const restartDdd = document.querySelector("#restart-ddd-architecture");
    if (restartDdd) restartDdd.onclick = restartDddArchitecture;
    const advanceDdd = document.querySelector("#advance-ddd-architecture");
    if (advanceDdd) advanceDdd.onclick = continueDddArchitecture;
    const dddForm = document.querySelector("#ddd-architecture-form");
    if (dddForm) dddForm.onsubmit = submitDddArchitectureAnswer;
    document.querySelectorAll("[data-event-uc]").forEach((node) => {
      node.onclick = () => selectEventUseCase(node.dataset.eventUc);
    });
    document.querySelectorAll("[data-ddd-uc]").forEach((node) => {
      node.onclick = () => selectDddUseCase(node.dataset.dddUc);
    });
    document.querySelectorAll("[data-ddd-step]").forEach((node) => {
      node.onclick = () => { app.dddSelectedStep = node.dataset.dddStep; render(); };
    });
    document.querySelectorAll("[data-ddd-rerun-step]").forEach((node) => {
      node.onclick = () => rerunDddArchitectureStep(node.dataset.dddRerunStep);
    });
    document.querySelectorAll("[data-stage-tab]").forEach((node) => {
      node.onclick = () => selectStageTab(node.dataset.stageTab);
    });
    return;
  }
  detail.innerHTML = selected ? renderDetail(selected) : "<p>No ChangeSets found.</p>";
  bindDetail(selected);
}

function renderNewChangeSet() {
  return `<section class="workflow-page">
    <p class="eyebrow">New ChangeSet</p>
    <h2>Requirements Definition</h2>
    <p class="lead">Describe initial product change. Runtime starts requirements clarification only.</p>
    <form id="initial-prompt-form" class="panel prompt-form">
      <label for="initial-prompt">Initial prompt</label>
      <textarea id="initial-prompt" placeholder="Describe one product or feature idea..." required></textarea>
      ${app.error ? `<p class="error">${escapeHtml(app.error)}</p>` : ""}
      ${app.busy ? renderBusyState() : ""}
      <button class="primary" type="submit" ${app.busy ? "disabled" : ""}>${app.busy ? "Starting..." : "Start requirements definition"}</button>
    </form>
  </section>`;
}

async function submitInitialPrompt(event) {
  event.preventDefault();
  const prompt = document.querySelector("#initial-prompt").value.trim();
  const button = event.target.querySelector("button");
  if (!prompt) return;
  button.disabled = true;
  button.textContent = "Starting...";
  app.busy = true;
  app.busyLabel = "Starting Requirements Definition";
  app.error = "";
  render();
  try {
    const response = await fetch("/api/change-sets/requirements/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Unable to start requirements definition.");
    app.requirementsChangeSet = result.change_set_id;
    app.selectedChangeSet = result.change_set_id;
    app.harvest = result.harvest;
    app.workflowRecovered = false;
    app.view = "requirements";
    app.stageTab = "requirements";
    await loadDashboard();
    await openRequirementsDocument();
    app.busy = false;
    app.busyLabel = "";
    render();
  } catch (error) {
    app.busy = false;
    app.busyLabel = "";
    app.error = error.message;
    render();
  }
}

function renderRequirementsWorkspace() {
  const selected = app.state.change_sets.find((item) => item.id === app.requirementsChangeSet);
  const title = selected?.title || "";
  const busy = app.busy ? renderBusyState() : "";
  const tabs = renderStageTabs();
  const body = app.stageTab === "dddArchitecture"
    ? renderDddArchitectureWorkspace()
    : app.stageTab === "eventStorming"
    ? renderEventStormingWorkspace()
    : app.stageTab === "useCases" ? renderUseCaseWorkspace() : renderRequirementsTab();
  return `<section class="workflow-page">
    <div class="workspace-heading"><div><p class="eyebrow">ChangeSet Workflow</p><h2>${escapeHtml(app.requirementsChangeSet)} ${escapeHtml(title)}</h2></div></div>
    ${tabs}
    ${app.error ? `<p class="error">${escapeHtml(app.error)}</p>` : ""}
    ${busy}
    ${body}
  </section>`;
}

function renderStageTabs() {
  const requirementsDone = app.harvest?.requirements_gate_passed;
  const useCasesDone = app.harvest?.use_cases_ready;
  const eventsDone = app.harvest?.event_storming?.complete;
  const dddDone = app.harvest?.ddd_architecture?.complete;
  return `<nav class="stage-tabs" aria-label="Workflow stages">
    <button class="stage-tab ${app.stageTab === "requirements" ? "selected" : ""}" data-stage-tab="requirements">
      <span class="progress-dot ${requirementsDone ? "complete" : "active"}"></span>Requirements
    </button>
    <button class="stage-tab ${app.stageTab === "useCases" ? "selected" : ""}" data-stage-tab="useCases" ${!requirementsDone ? "disabled" : ""}>
      <span class="progress-dot ${useCasesDone ? "complete" : requirementsDone ? "active" : ""}"></span>Use Cases
    </button>
    <button class="stage-tab ${app.stageTab === "eventStorming" ? "selected" : ""}" data-stage-tab="eventStorming" ${!useCasesDone ? "disabled" : ""}>
      <span class="progress-dot ${eventsDone ? "complete" : useCasesDone ? "active" : ""}"></span>Event Storming
    </button>
    <button class="stage-tab ${app.stageTab === "dddArchitecture" ? "selected" : ""}" data-stage-tab="dddArchitecture" ${!eventsDone ? "disabled" : ""}>
      <span class="progress-dot ${dddDone ? "complete" : eventsDone ? "active" : ""}"></span>DDD Architecture
    </button>
  </nav>`;
}

function renderBusyState() {
  return `<div class="runtime-progress" role="status">
    <span class="spinner" aria-hidden="true"></span>
    <div><strong>${escapeHtml(app.busyLabel)}</strong><p>Runtime is processing. Keep this page open.</p></div>
  </div>`;
}

function renderRequirementsTab() {
  const question = app.harvest?.current_question;
  const questionPanel = app.harvest?.requirements_gate_passed
    ? `<p class="completion">Requirements clarification complete.</p>
       <button class="primary next-stage" id="start-use-cases" type="button" ${app.busy ? "disabled" : ""}>Continue to Use Case Definition</button>`
    : question
      ? `<form id="grill-form" class="grill-form">
          <p class="question">${escapeHtml(question.question)}</p>
          ${question.recommended ? `<p class="recommended">Recommended answer: ${escapeHtml(question.recommended)}</p>` : ""}
          <label for="grill-answer">Your answer</label>
          <textarea id="grill-answer" required></textarea>
          <button class="primary" type="submit" ${app.busy ? "disabled" : ""}>${app.busy ? "Processing..." : "Submit answer"}</button>
        </form>`
      : "<p>No current question.</p>";
  return `
    <section class="panel requirements-document"><h3>Requirements</h3><div id="editor"></div></section>
    <section class="panel grill-panel"><h3>Grill-Me Questions</h3>${questionPanel}</section>
  `;
}

function renderUseCaseWorkspace() {
  const question = app.harvest?.current_question;
  const questionPanel = app.harvest?.use_cases_ready
    ? `<p class="completion">Use case definition complete.</p>
       <button class="primary next-stage" id="start-event-storming" type="button" ${app.busy ? "disabled" : ""}>Continue to Event Storming</button>`
    : question
      ? `<form id="use-case-form" class="grill-form">
          <p class="question">${escapeHtml(question.question)}</p>
          ${question.recommended ? `<p class="recommended">Recommended answer: ${escapeHtml(question.recommended)}</p>` : ""}
          <label for="use-case-answer">Your answer</label>
          <textarea id="use-case-answer" required></textarea>
          <button class="primary" type="submit" ${app.busy ? "disabled" : ""}>${app.busy ? "Processing..." : "Submit answer"}</button>
        </form>`
      : `<p>Start use case definition to receive next runtime question.</p>
         <button class="primary next-stage" id="start-use-cases" type="button" ${app.busy ? "disabled" : ""}>${app.error ? "Retry Use Case Definition" : "Start Use Case Definition"}</button>`;
  const document = app.harvest?.use_cases_markdown
    ? `<div class="markdown-preview">${markdownPreview(app.harvest.use_cases_markdown)}</div>`
    : '<p class="small">Generated use-case document appears here when runtime completes.</p>';
  return `
    <section class="panel requirements-document"><h3>Use Case Document</h3>${document}</section>
    <section class="panel grill-panel"><h3>Use Case Questions</h3>${questionPanel}</section>
  `;
}

function renderEventStormingWorkspace() {
  const state = app.harvest?.event_storming || { items: {}, uc_ids: [], status: "not_started" };
  const currentId = app.eventSelectedUc || state.current_uc || state.uc_ids.find((id) => state.items[id]?.status === "complete");
  const item = currentId ? state.items[currentId] : null;
  const statusItems = state.uc_ids.map((id) => `<button type="button" data-event-uc="${escapeHtml(id)}" class="event-progress-item ${escapeHtml(state.items[id]?.status || "pending")}">${escapeHtml(id)}: ${escapeHtml(state.items[id]?.status || "pending")}</button>`).join("");
  const progress = state.uc_ids.length
    ? `<p class="small">Completed ${escapeHtml(state.completed_count || 0)} / ${escapeHtml(state.total_count || state.uc_ids.length)}</p><div class="event-progress">${statusItems}</div>`
    : '<p class="small">Start Event Storming to process generated use cases.</p>';
  let interaction = "";
  if (item?.status === "needs_input" && item.current_question) {
    interaction = `<form id="event-storming-form" class="grill-form">
      <p class="question">${escapeHtml(item.current_question.question)}</p>
      ${item.current_question.recommended ? `<p class="recommended">Recommended answer: ${escapeHtml(item.current_question.recommended)}</p>` : ""}
      <label for="event-storming-answer">Your answer</label>
      <textarea id="event-storming-answer" required></textarea>
      <button class="primary" type="submit" ${app.busy ? "disabled" : ""}>Submit answer</button>
    </form>`;
  } else if (state.complete) {
    interaction = `<p class="completion">Event storming complete.</p>
      <button class="primary next-stage" id="start-ddd-architecture" type="button" ${app.busy ? "disabled" : ""}>Continue to DDD Architecture</button>`;
  } else if (state.status === "error") {
    interaction = `<p class="error">${escapeHtml(item?.error || app.harvest?.runtime_error || "Event storming failed.")}</p>
      <button class="primary next-stage" id="start-event-storming" type="button">Retry Event Storming</button>`;
  } else if (state.status === "not_started") {
    interaction = `<button class="primary next-stage" id="start-event-storming" type="button">Start Event Storming</button>`;
  } else {
    interaction = `<p class="small">Ready to process the next use case.</p>
      <button class="primary next-stage" id="advance-event-storming" type="button" ${app.busy ? "disabled" : ""}>Continue Event Storming</button>`;
  }
  return `
    <section class="panel event-progress-panel"><h3>Event Storming Progress</h3>${progress}</section>
    <section class="panel event-document"><h3>${escapeHtml(currentId || "Event Storming")} Document</h3><div id="event-document-editor"></div></section>
    <section class="panel event-live-preview"><h3>Sticky Notes Preview</h3><div id="event-live-board"></div></section>
    <section class="panel grill-panel"><h3>Oracle Questions</h3>${interaction}</section>`;
}

function renderDddArchitectureWorkspace() {
  const state = app.harvest?.ddd_architecture || { items: {}, uc_ids: [], status: "not_started", step_order: [] };
  const currentId = app.dddSelectedUc || state.current_uc || state.uc_ids.find((id) => state.items[id]?.status === "complete");
  const item = currentId ? state.items[currentId] : null;
  const steps = state.step_order || [];
  const ucProgress = state.uc_ids.map((id) => `<button type="button" data-ddd-uc="${escapeHtml(id)}" class="event-progress-item ${escapeHtml(state.items[id]?.status || "pending")}">${escapeHtml(id)}: ${escapeHtml(state.items[id]?.status || "pending")}</button>`).join("");
  const stepTabs = steps.map((step) => {
    const status = item?.steps?.[step.id]?.status || "pending";
    const unlocked = status === "complete" || step.id === state.current_step || step.id === app.dddSelectedStep;
    return `<button type="button" data-ddd-step="${escapeHtml(step.id)}" class="ddd-step ${escapeHtml(status)} ${app.dddSelectedStep === step.id ? "selected" : ""}" ${!unlocked ? "disabled" : ""}>${escapeHtml(step.label)}</button>`;
  }).join("");
  const rerunControls = currentId && steps.length
    ? `<div class="ddd-rerun-controls">
        <label for="ddd-rerun-prompt">Additional rerun prompt</label>
        <textarea id="ddd-rerun-prompt" placeholder="Add correction or emphasis for the selected rerun..." ${app.busy ? "disabled" : ""}></textarea>
        <div class="ddd-rerun-buttons">${steps.map((step) => {
          const status = item?.steps?.[step.id]?.status || "pending";
          const enabled = status !== "pending" && !app.busy;
          return `<button type="button" class="secondary" data-ddd-rerun-step="${escapeHtml(step.id)}" ${enabled ? "" : "disabled"}>Rerun ${escapeHtml(step.label)}</button>`;
        }).join("")}</div>
      </div>`
    : "";
  let interaction = "";
  const currentStep = item?.steps?.[state.current_step];
  if (currentStep?.status === "needs_input" && currentStep.current_question) {
    interaction = `<form id="ddd-architecture-form" class="grill-form">
      <p class="question">${escapeHtml(currentStep.current_question.question)}</p>
      ${currentStep.current_question.recommended ? `<p class="recommended">Recommended answer: ${escapeHtml(currentStep.current_question.recommended)}</p>` : ""}
      <label for="ddd-architecture-answer">Your answer</label>
      <textarea id="ddd-architecture-answer" required></textarea>
      <button class="primary" type="submit" ${app.busy ? "disabled" : ""}>Submit answer</button>
    </form>`;
  } else if (state.complete) {
    interaction = '<p class="completion">DDD architecture complete.</p><button class="primary next-stage" type="button" disabled>Continue to Technical Decisions (next slice)</button>';
  } else if (state.status === "not_started") {
    interaction = `<button class="primary next-stage" id="start-ddd-architecture" type="button" ${app.busy ? "disabled" : ""}>Start DDD Architecture</button>`;
  } else if (state.status === "error") {
    interaction = `<p class="error">${escapeHtml(currentStep?.error || app.harvest?.runtime_error || "DDD architecture failed.")}</p><button class="primary next-stage" id="advance-ddd-architecture" type="button">Retry DDD Substep</button>`;
  } else {
    interaction = `<p class="small">Review completed visualization, then continue explicitly.</p><button class="primary next-stage" id="advance-ddd-architecture" type="button" ${app.busy ? "disabled" : ""}>Continue DDD Architecture</button>`;
  }
  const restartAction = state.status === "not_started"
    ? ""
    : `<button class="secondary" id="restart-ddd-architecture" type="button" ${app.busy ? "disabled" : ""}>Restart DDD Architecture</button>`;
  return `<section class="panel"><h3>DDD Architecture Progress</h3><p class="small">Completed ${escapeHtml(state.completed_count || 0)} / ${escapeHtml(state.total_count || 0)} substeps</p>${restartAction}<div class="event-progress">${ucProgress}</div><nav class="ddd-steps">${stepTabs}</nav>${rerunControls}</section>
    <section class="panel"><h3>${escapeHtml(currentId || "DDD")} Design Document</h3><div id="ddd-document-editor"></div></section>
    <section class="panel ddd-live-preview"><h3>Design Visualization</h3><div id="ddd-live-board"></div></section>
    <section class="panel grill-panel"><h3>DDD Architect Questions</h3>${interaction}</section>`;
}

async function openRequirementsDocument() {
  const id = `requirements:${app.requirementsChangeSet}`;
  const response = await fetch(`/api/dashboard/documents/${encodeURIComponent(id)}`);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Requirements document unavailable.");
  app.openDocument = result;
  app.editorMode = "preview";
}

async function submitRequirementAnswer(event) {
  event.preventDefault();
  const answer = document.querySelector("#grill-answer").value.trim();
  if (!answer) return;
  app.busy = true;
  app.busyLabel = "Submitting answer";
  render();
  try {
    const response = await fetch("/api/change-sets/requirements/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ change_set_id: app.requirementsChangeSet, answer }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Unable to submit answer.");
    app.harvest = result.harvest;
    app.workflowRecovered = false;
    await openRequirementsDocument();
    app.busy = false;
    app.busyLabel = "";
    render();
  } catch (error) {
    app.busy = false;
    app.busyLabel = "";
    app.error = error.message;
    render();
  }
}

async function selectStageTab(tab) {
  if (tab === "useCases" && !app.harvest?.requirements_gate_passed) return;
  if (tab === "eventStorming" && !app.harvest?.use_cases_ready) return;
  if (tab === "dddArchitecture" && !app.harvest?.event_storming?.complete) return;
  app.stageTab = tab;
  if (tab === "requirements") {
    if (app.workflowRecovered) setRecoveredRequirementsDocument();
    else await openRequirementsDocument();
  }
  if (tab === "eventStorming") await openCurrentEventDocument();
  if (tab === "dddArchitecture") await openCurrentDddDocument();
  render();
}

async function startUseCaseDefinition() {
  app.stageTab = "useCases";
  app.busy = true;
  app.busyLabel = "Starting Use Case Definition";
  render();
  try {
    const response = await fetch("/api/use-cases/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ change_set_id: app.requirementsChangeSet, idea: app.harvest?.initial_prompt || "" }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Unable to start use case definition.");
    app.harvest = result.harvest;
    app.workflowRecovered = false;
    app.busy = false;
    app.busyLabel = "";
    render();
  } catch (error) {
    app.busy = false;
    app.busyLabel = "";
    app.error = error.message;
    render();
  }
}

async function submitUseCaseAnswer(event) {
  event.preventDefault();
  const answer = document.querySelector("#use-case-answer").value.trim();
  if (!answer) return;
  app.busy = true;
  app.busyLabel = "Submitting use case answer";
  render();
  try {
    const response = await fetch("/api/use-cases/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ change_set_id: app.requirementsChangeSet, answer, idea: app.harvest?.initial_prompt || "" }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Unable to submit use case answer.");
    app.harvest = result.harvest;
    app.workflowRecovered = false;
    app.busy = false;
    app.busyLabel = "";
    render();
  } catch (error) {
    app.busy = false;
    app.busyLabel = "";
    app.error = error.message;
    render();
  }
}

async function startEventStormingDefinition() {
  app.stageTab = "eventStorming";
  app.eventSelectedUc = null;
  await runEventStormingTurn("/api/event-storming/start", "Starting Event Storming");
}

async function continueEventStormingDefinition() {
  await runEventStormingTurn("/api/event-storming/advance", "Processing next use case");
}

async function submitEventStormingAnswer(event) {
  event.preventDefault();
  const answer = document.querySelector("#event-storming-answer").value.trim();
  if (!answer) return;
  await runEventStormingTurn("/api/event-storming/answer", "Submitting event-storming answer", {
    uc_id: app.harvest.event_storming.current_uc,
    answer,
  });
}

async function runEventStormingTurn(endpoint, label, extra = {}) {
  app.busy = true;
  app.busyLabel = label;
  app.error = "";
  render();
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ change_set_id: app.requirementsChangeSet, ...extra }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Unable to run event storming.");
    app.harvest = result.harvest;
    if (app.harvest.event_storming?.current_uc) {
      app.eventSelectedUc = app.harvest.event_storming.current_uc;
    }
    await openCurrentEventDocument();
    await loadDashboard();
    render();
    const state = app.harvest.event_storming;
    if (!state.complete && state.status === "running") {
      await runEventStormingTurn("/api/event-storming/advance", "Processing next use case");
      return;
    }
  } catch (error) {
    app.error = error.message;
  }
  app.busy = false;
  app.busyLabel = "";
  render();
}

async function openCurrentEventDocument() {
  const state = app.harvest?.event_storming;
  const ucId = app.eventSelectedUc || state?.current_uc || state?.uc_ids?.find((id) => state.items[id]?.status === "complete");
  if (!ucId || state.items[ucId]?.status !== "complete") {
    app.openDocument = null;
    return;
  }
  const id = `event-storming:${app.requirementsChangeSet}:${ucId}`;
  const response = await fetch(`/api/dashboard/documents/${encodeURIComponent(id)}`);
  if (response.ok) {
    app.openDocument = await response.json();
    app.editorMode = "preview";
  }
}

async function selectEventUseCase(ucId) {
  app.eventSelectedUc = ucId;
  await openCurrentEventDocument();
  render();
}

async function startDddArchitecture() {
  app.stageTab = "dddArchitecture";
  app.dddSelectedUc = null;
  app.dddSelectedStep = "entity_vo";
  await runDddTurn("/api/ddd-architecture/start", "Starting DDD Architecture");
}

async function restartDddArchitecture() {
  if (!window.confirm("Restart DDD Architecture for this ChangeSet? Existing scoped DDD design output will be replaced.")) return;
  app.stageTab = "dddArchitecture";
  app.dddSelectedUc = null;
  app.dddSelectedStep = "entity_vo";
  app.openDocument = null;
  await runDddTurn("/api/ddd-architecture/restart", "Restarting DDD Architecture");
}

async function continueDddArchitecture() {
  await runDddTurn("/api/ddd-architecture/advance", "Processing DDD substep");
}

async function rerunDddArchitectureStep(stepId) {
  const prompt = document.querySelector("#ddd-rerun-prompt")?.value.trim() || "";
  const ucId = app.dddSelectedUc || app.harvest?.ddd_architecture?.current_uc;
  if (!ucId) {
    app.error = "Select a DDD use case before rerunning a substep.";
    render();
    return;
  }
  if (!prompt) {
    app.error = "Additional rerun prompt is required.";
    render();
    return;
  }
  app.dddSelectedStep = stepId;
  await runDddTurn("/api/ddd-architecture/rerun-step", `Rerunning ${stepId}`, {
    uc_id: ucId,
    step_id: stepId,
    user_prompt: prompt,
  });
}

async function submitDddArchitectureAnswer(event) {
  event.preventDefault();
  const answer = document.querySelector("#ddd-architecture-answer").value.trim();
  if (!answer) return;
  await runDddTurn("/api/ddd-architecture/answer", "Submitting DDD answer", {
    uc_id: app.harvest.ddd_architecture.current_uc,
    step_id: app.harvest.ddd_architecture.current_step,
    answer,
  });
}

async function runDddTurn(endpoint, label, extra = {}) {
  app.busy = true;
  app.busyLabel = label;
  app.error = "";
  render();
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ change_set_id: app.requirementsChangeSet, ...extra }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Unable to run DDD architecture.");
    app.harvest = result.harvest;
    const state = app.harvest.ddd_architecture;
    if (state.current_uc) app.dddSelectedUc = state.current_uc;
    if (state.current_step) app.dddSelectedStep = state.current_step;
    await openCurrentDddDocument();
    await loadDashboard();
  } catch (error) {
    app.error = error.message;
  }
  app.busy = false;
  app.busyLabel = "";
  render();
}

async function openCurrentDddDocument() {
  const state = app.harvest?.ddd_architecture;
  const ucId = app.dddSelectedUc || state?.current_uc || state?.uc_ids?.find((id) => state.items[id]?.status === "complete");
  const item = state?.items?.[ucId];
  if (!ucId || !Object.values(item?.steps || {}).some((step) => step.status === "complete")) {
    app.openDocument = null;
    return;
  }
  const id = `ddd-design:${app.requirementsChangeSet}:${ucId}`;
  const response = await fetch(`/api/dashboard/documents/${encodeURIComponent(id)}`);
  if (response.ok) {
    app.openDocument = await response.json();
    app.editorMode = "preview";
  }
}

async function selectDddUseCase(ucId) {
  app.dddSelectedUc = ucId;
  await openCurrentDddDocument();
  render();
}

function renderDetail(change) {
  const stages = change.stages.map((stage) => `
    <div class="stage ${stage.status}">
      <strong>${escapeHtml(stage.procedure)}</strong>
      <span class="pill ${stage.status}">${escapeHtml(stage.status)}</span>
      <div class="small">${escapeHtml(stage.verified_at)}</div>
    </div>`).join("");
  const hasAggregateBoard = Boolean(change.event_storming_board?.slices?.length);
  const workItems = change.work_items.map((item) => `
    <div class="panel">
      <h3>${escapeHtml(item.id)}: ${escapeHtml(item.name)}</h3>
      ${item.artifacts.map((artifact) => `<span class="artifact">${escapeHtml(artifact.path)}</span>`).join("")}
      ${hasAggregateBoard ? "" : renderBoard(item.event_storming)}
    </div>`).join("");
  const documents = change.documents.map((document) => `
    <button data-document="${escapeHtml(document.id)}">${escapeHtml(document.label)}</button>`).join("");
  const runs = change.run_history.map((run) => `<li>${escapeHtml(run.run_id)}: ${escapeHtml(run.status)}</li>`).join("");
  return `
    ${app.error ? `<p class="error">${escapeHtml(app.error)}</p>` : ""}
    <div class="change-heading">
      <div><span class="pill ${change.lifecycle}">${escapeHtml(change.lifecycle)}</span>
      <h2>${escapeHtml(change.id)} ${escapeHtml(change.title)}</h2></div>
      ${change.lifecycle === "active" ? '<button class="danger" data-delete-change-set>Delete active ChangeSet</button>' : ""}
    </div>
    <p>${escapeHtml(change.intent)}</p>
    ${change.lifecycle === "active" ? `<div class="stage-tabs dashboard-tabs">
      <button data-resume-workflow class="stage-tab"><span class="progress-dot"></span>Resume Workflow</button>
    </div>` : ""}
    <section class="panel"><h3>Workflow Stages</h3><div class="timeline">${stages}</div></section>
    ${documents ? `<section class="panel"><h3>Documents</h3><div class="doc-actions">${documents}</div><div id="editor"></div></section>` : ""}
    ${renderCanvasBoard(change.event_storming_board)}
    ${renderDddCanvasBoard(change.ddd_architecture_board)}
    ${workItems}
    <details class="panel"><summary>Runtime history</summary><ul>${runs || "<li>No recorded runs.</li>"}</ul></details>`;
}

function renderBoard(board) {
  if (!board || !board.flows.length) return "";
  return `<h3>Event Storming Board</h3>${board.flows.map((flow) => `
    <h4>${escapeHtml(flow.name)}</h4>
    <div class="flow-lane">${flow.notes.map((note) => `
      <article class="sticky ${escapeHtml(note.type)}">
        <div class="sticky-type">${escapeHtml(note.type.replace("_", " "))}</div>
        ${richTextHtml(note.text)}
      </article>`).join("")}</div>`).join("")}`;
}

function renderCanvasBoard(board) {
  if (!board?.slices?.length) return "";
  const contents = board.slices.map((slice) => `
    <section class="canvas-slice"><h4>${escapeHtml(slice.uc_id)}</h4>
      ${slice.flows.map((flow) => `<div class="canvas-lane"><strong>${escapeHtml(flow.name)}</strong>
        <div class="flow-lane">${flow.notes.map(renderSticky).join("")}</div></div>`).join("")}
      ${slice.supporting_notes?.length ? `<div class="flow-lane supporting">${slice.supporting_notes.map(renderSticky).join("")}</div>` : ""}
    </section>`).join("");
  return `<section class="panel event-canvas-panel"><div class="canvas-header"><h3>Event Storming Canvas</h3>
    <div><span id="canvas-zoom-label">100%</span><button id="canvas-reset" type="button">Reset view</button></div></div>
    <p class="small">Drag canvas to pan. Scroll over canvas to zoom.</p>
    <div id="event-canvas" class="event-canvas"><div id="event-canvas-content" class="event-canvas-content">${contents}</div></div></section>`;
}

function renderSticky(note) {
  return `<article class="sticky ${escapeHtml(note.type)}">
    <div class="sticky-type">${escapeHtml(note.type.replace("_", " "))}</div>${richTextHtml(note.text)}
  </article>`;
}

function renderDddCanvasBoard(board) {
  if (!board?.slices?.length) return "";
  const contents = board.slices.map((slice) => {
    const completedSteps = slice.completed_steps || [];
    const latestStep = completedSteps[completedSteps.length - 1] || "entity_vo";
    return `<section class="canvas-slice ddd-slice"><h4>${escapeHtml(slice.uc_id)}</h4>${renderDddVisualization(slice, latestStep)}</section>`;
  }).join("");
  return `<section class="panel"><div class="canvas-header"><h3>DDD Architecture Canvas</h3><div><span id="ddd-canvas-zoom-label">100%</span><button id="ddd-canvas-reset" type="button">Reset view</button></div></div>
    <p class="small">Design evolves as scoped substeps complete. Drag canvas to pan. Scroll to zoom.</p>
    <div id="ddd-canvas" class="event-canvas ddd-canvas"><div id="ddd-canvas-content" class="event-canvas-content">${contents}</div></div></section>`;
}

function stickyText(text) {
  return String(text || "").replace(/`([^`]*)`/g, "$1");
}

function richTextHtml(text) {
  return escapeHtml(stickyText(text)).replace(/&lt;br\s*\/?&gt;/gi, "<br>");
}

function bindDetail(change) {
  document.querySelectorAll("[data-document]").forEach((node) => node.onclick = () => openDocument(node.dataset.document));
  const deleteButton = document.querySelector("[data-delete-change-set]");
  if (deleteButton) deleteButton.onclick = () => deleteActiveChangeSet(change);
  const resumeWorkflow = document.querySelector("[data-resume-workflow]");
  if (resumeWorkflow) resumeWorkflow.onclick = () => loadWorkflowResults(change.id);
  if (app.openDocument && change.documents.some((item) => item.id === app.openDocument.id)) {
    renderEditor();
  }
  bindCanvas();
  bindDddCanvas();
}

async function loadWorkflowResults(changeSetId) {
  const response = await fetch(`/api/dashboard/change-sets/${encodeURIComponent(changeSetId)}/resume`);
  const result = await response.json();
  if (!response.ok) {
    app.error = result.error || "Unable to resume workflow.";
    render();
    return;
  }
  app.requirementsChangeSet = changeSetId;
  app.harvest = result.harvest;
  app.stageTab = result.harvest.active_stage === "dddArchitecture"
    ? "dddArchitecture" : result.harvest.active_stage === "eventStorming"
    ? "eventStorming" : result.harvest.active_stage === "useCases" ? "useCases" : "requirements";
  app.workflowRecovered = true;
  app.view = "requirements";
  if (app.stageTab === "dddArchitecture") {
    app.dddSelectedUc = result.harvest.ddd_architecture?.current_uc;
    app.dddSelectedStep = result.harvest.ddd_architecture?.current_step || "entity_vo";
    await openCurrentDddDocument();
  } else if (app.stageTab === "eventStorming") {
    app.eventSelectedUc = result.harvest.event_storming?.current_uc;
    await openCurrentEventDocument();
  } else {
    setRecoveredRequirementsDocument();
  }
  app.error = "";
  render();
}

function setRecoveredRequirementsDocument() {
  app.openDocument = {
    id: `requirements:${app.requirementsChangeSet}`,
    label: "Requirements",
    content: app.harvest?.requirements_markdown || "",
    editable: false,
  };
  app.editorMode = "preview";
}

async function deleteActiveChangeSet(change) {
  if (!window.confirm(`Delete active ChangeSet ${change.id}? Generated documents are preserved.`)) return;
  const response = await fetch(`/api/dashboard/change-sets/${encodeURIComponent(change.id)}`, { method: "DELETE" });
  const result = await response.json();
  if (!response.ok) {
    document.querySelector("#detail").insertAdjacentHTML("afterbegin", `<p class="error">${escapeHtml(result.error)}</p>`);
    return;
  }
  app.selectedChangeSet = null;
  app.openDocument = null;
  await loadDashboard();
}

async function openDocument(id) {
  const response = await fetch(`/api/dashboard/documents/${encodeURIComponent(id)}`);
  app.openDocument = await response.json();
  app.editorMode = "preview";
  renderEditor();
}

function renderEditor(message = "") {
  const target = document.querySelector("#editor");
  if (!target || !app.openDocument) return;
  const editable = app.openDocument.editable !== false;
  const editing = editable && app.editorMode === "edit";
  target.innerHTML = `
    <div class="doc-actions">
      <button id="preview-mode">Preview</button>
      ${editable ? '<button id="edit-mode">Edit</button>' : ""}
      ${editing ? '<button class="primary" id="save-doc">Save</button>' : ""}
    </div>
    ${message ? `<p class="error">${escapeHtml(message)}</p>` : ""}
    ${editing
      ? `<textarea id="doc-content">${escapeHtml(app.openDocument.content)}</textarea>`
      : `<div class="markdown-preview">${markdownPreview(app.openDocument.content)}</div>`}`;
  document.querySelector("#preview-mode").onclick = () => { app.editorMode = "preview"; renderEditor(); };
  if (editable) document.querySelector("#edit-mode").onclick = () => { app.editorMode = "edit"; renderEditor(); };
  if (editing) document.querySelector("#save-doc").onclick = saveDocument;
}

function isEditingDashboardDocument() {
  return app.view === "dashboard" && app.openDocument?.editable !== false && app.editorMode === "edit";
}

function parseEventStormingMarkdown(content) {
  const lines = String(content || "").split(/\r?\n/);
  const flows = [];
  const supportingNotes = [];
  const domainElements = [];
  const systems = new Set();
  const externalSystems = new Set();
  let active = null;
  let inDomainElements = false;
  let inExternalSystems = false;
  lines.forEach((line) => {
    if (line.startsWith("## 5.")) inDomainElements = true;
    else if (inDomainElements && line.startsWith("## ")) inDomainElements = false;
    if (line.startsWith("## 6.")) inExternalSystems = true;
    else if (inExternalSystems && line.startsWith("## ")) inExternalSystems = false;
    const header = line.match(/^### \[Flow: ([^\]]+)\]/);
    if (header) {
      const kind = eventFlowKind(header[1]);
      const ordinal = flows.filter((flow) => flow.kind === kind).length + 1;
      active = {
        name: kind === "main" ? "Main Flow" : `Exception Flow ${ordinal}`,
        source_name: header[1],
        kind,
        notes: [],
      };
      flows.push(active);
      return;
    }
    const match = line.trim().replace(/^→\s*/, "").match(/^([🟦🟧🟪⬛🟩])\s*(.+)$/u);
    if (active && match) {
      const types = { "🟦": "command", "🟧": "event", "🟪": "policy", "⬛": "system", "🟩": "external_system" };
      active.notes.push({ type: types[match[1]], text: stickyText(match[2]) });
    }
    const cells = splitTableRow(line);
    if (inDomainElements && cells?.length >= 5 && ["🟦", "🟧", "🟪"].includes(cells[0])) {
      const types = { "🟦": "command", "🟧": "event", "🟪": "policy" };
      domainElements.push({ type: types[cells[0]], text: stickyText(cells[1]), trigger: stickyText(cells[2]), result: stickyText(cells[3]) });
      if (cells[4] && cells[4] !== "없음") systems.add(stickyText(cells[4]));
    }
    if (inExternalSystems && cells?.length >= 2 && !["시스템", "---", "없음", ""].includes(cells[0]) && !/^-+$/.test(cells[0])) {
      externalSystems.add(stickyText(cells[0]));
    }
  });
  applyDomainElementLabels(flows, domainElements);
  systems.forEach((text) => supportingNotes.push({ type: "system", text }));
  externalSystems.forEach((text) => supportingNotes.push({ type: "external_system", text }));
  return { flows, supporting_notes: supportingNotes };
}

function eventFlowKind(name) {
  const normalized = String(name || "").toLowerCase();
  if (["main", "basic", "normal", "happy", "success", "primary", "default"].some((marker) => normalized.includes(marker))) {
    return "main";
  }
  if (["기본", "정상", "성공", "주요", "표준"].some((marker) => String(name || "").includes(marker))) {
    return "main";
  }
  return "exception";
}

function applyDomainElementLabels(flows, domainElements) {
  flows.forEach((flow) => {
    const original = flow.notes.map((note) => ({ ...note }));
    flow.notes.forEach((note, index) => {
      const previous = original[index - 1]?.text || "";
      const following = original[index + 1]?.text || "";
      const candidates = domainElements.filter((element) => element.type === note.type);
      const best = candidates.reduce((selected, element) => (
        domainElementScore(element, original[index].text, previous, following) >
        domainElementScore(selected, original[index].text, previous, following) ? element : selected
      ), null);
      if (domainElementScore(best, original[index].text, previous, following) > 0) note.text = best.text;
    });
  });
}

function domainElementScore(element, text, previous, following) {
  if (!element) return 0;
  return (element.text === text ? 4 : 0) +
    (previous && element.trigger === previous ? 2 : 0) +
    (following && element.result === following ? 2 : 0);
}

function renderEventDocumentEditor(message = "") {
  const target = document.querySelector("#event-document-editor");
  const preview = document.querySelector("#event-live-board");
  if (!target) return;
  if (!app.openDocument?.id?.startsWith("event-storming:")) {
    target.innerHTML = '<p class="small">Generated event-storming Markdown appears after a use case completes.</p>';
    if (preview) preview.innerHTML = '<p class="small">Sticky notes appear from generated Markdown.</p>';
    return;
  }
  const editing = app.editorMode === "edit";
  target.innerHTML = `<div class="doc-actions"><button id="event-preview-mode">Preview</button>
    <button id="event-edit-mode">Edit</button>${editing ? '<button class="primary" id="event-save-doc">Save</button>' : ""}</div>
    ${message ? `<p class="error">${escapeHtml(message)}</p>` : ""}
    ${editing ? `<textarea id="event-doc-content">${escapeHtml(app.openDocument.content)}</textarea>`
      : `<div class="markdown-preview">${markdownPreview(app.openDocument.content)}</div>`}`;
  const updatePreview = (content) => {
    if (preview) {
      const board = parseEventStormingMarkdown(content);
      const support = board.supporting_notes?.length ? `<div class="flow-lane supporting">${board.supporting_notes.map(renderSticky).join("")}</div>` : "";
      preview.innerHTML = (renderBoard(board) + support) || '<p class="small">No parseable flow notes.</p>';
    }
  };
  updatePreview(app.openDocument.content);
  document.querySelector("#event-preview-mode").onclick = () => { app.editorMode = "preview"; renderEventDocumentEditor(); };
  document.querySelector("#event-edit-mode").onclick = () => { app.editorMode = "edit"; renderEventDocumentEditor(); };
  if (editing) {
    document.querySelector("#event-doc-content").oninput = (event) => updatePreview(event.target.value);
    document.querySelector("#event-save-doc").onclick = async () => {
      const content = document.querySelector("#event-doc-content").value;
      const response = await fetch(`/api/dashboard/documents/${encodeURIComponent(app.openDocument.id)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content, revision: app.openDocument.revision }),
      });
      const result = await response.json();
      if (!response.ok) {
        renderEventDocumentEditor(result.error);
        return;
      }
      app.openDocument = result;
      app.editorMode = "preview";
      await loadDashboard();
      renderEventDocumentEditor();
    };
  }
}

function parseDddMarkdown(content) {
  const impact = dddRows(content, "## Impact Assessment");
  return {
    impact,
    entity_vo: normalizeDddEntityVoRows(dddRows(content, "## Entity / Value Objects"), impact),
    behaviors: dddRows(content, "## Behaviors"),
    application_flow: dddRows(content, "## Application Flow"),
    aggregates: dddRows(content, "## Aggregates"),
    bounded_contexts: dddRows(content, "## Bounded Contexts"),
  };
}

function dddRows(content, heading) {
  const lines = String(content || "").split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return [];
  const section = lines.slice(start + 1);
  const end = section.findIndex((line) => line.startsWith("## "));
  const body = end < 0 ? section : section.slice(0, end);
  const tableIndex = body.findIndex((line, index) => splitTableRow(line) && isTableDivider(body[index + 1], splitTableRow(line).length));
  if (tableIndex < 0) return [];
  const headers = splitTableRow(body[tableIndex]).map(stickyText);
  const rows = [];
  for (const line of body.slice(tableIndex + 2)) {
    const cells = splitTableRow(line);
    if (!cells || cells.length !== headers.length) break;
    if (!cells.some((cell) => stickyText(cell).trim())) continue;
    rows.push(Object.fromEntries(headers.map((header, index) => [header, stickyText(cells[index])])));
  }
  return rows;
}

function dddModelKindLabel(kind) {
  const normalized = String(kind || "").toLowerCase();
  if (normalized.includes("value object") || normalized === "vo") return "vo";
  if (normalized.includes("entity")) return "entity";
  return "";
}

function dddModelKindFromImpact(board, entity) {
  const target = stickyText(entity || "");
  if (!target) return "";
  const impact = (board?.impact || []).find((row) => stickyText(row.Element || row.Model || "") === target);
  return impact?.["Element Type"] || impact?.Kind || impact?.Type || "";
}

function normalizeDddEntityVoRows(rows, impactRows = []) {
  const impactKinds = new Map(impactRows.map((row) => [stickyText(row.Element || row.Model || ""), row["Element Type"] || row.Kind || row.Type || ""]).filter(([model, kind]) => model && kind));
  return rows.map((row) => {
    if ("Entity" in row && "Attributes / VOs" in row) {
      return { ...row, "Model Type": row["Model Type"] || impactKinds.get(stickyText(row.Entity || "")) || "" };
    }
    const model = row.Model || "";
    if (!model) return row;
    return {
      Entity: model,
      "Attributes / VOs": row["Core attributes"] || row["Proposed Identity / State"] || "",
      "Model Type": row.Kind || row.Type || impactKinds.get(stickyText(model)) || "",
      Status: row.Classification || row.Kind || "",
      "Previous Definition": "",
      "Proposed Definition": row["Proposed Identity / State"] || row["Core attributes"] || "",
      Evidence: row.Evidence || row["Why new"] || "",
    };
  }).filter((row) => row.Entity || row["Attributes / VOs"] || row.Status);
}

function dddAttributeNames(attributes) {
  return String(attributes || "")
    .split(/`,\s*`|,\s*`|`,\s*/g)
    .map((part) => stickyText(part).replace(/^`|`$/g, "").trim())
    .map((part) => {
      const match = part.match(/^([A-Za-z_][\w?]*)\s*:/);
      if (match) return match[1];
      const valueObjectMatch = part.match(/^([A-Z][\w]*)\s*\{/);
      if (valueObjectMatch) return valueObjectMatch[1];
      return part.split(/\s+/)[0] || "";
    })
    .filter(Boolean)
    .join(", ");
}

function dddEntityMethodSignatures(board, entity) {
  const target = stickyText(entity || "");
  if (!target) return "";
  return (board.behaviors || [])
    .filter((row) => {
      const placement = String(row.Placement || "").toLowerCase();
      return !placement.includes("domain service") && stickyText(row["Owner / Service"] || "") === target;
    })
    .map((row) => dddMethodLabel(row.Signature))
    .filter(Boolean)
    .join(", ");
}

function renderDddVisualization(board, stepId) {
  if (!board) return '<p class="small">No completed DDD design substep.</p>';
  const stepOrder = ["entity_vo", "behaviors", "application_flow", "aggregates", "bounded_contexts"];
  const stepIndex = Math.max(0, stepOrder.indexOf(stepId || "entity_vo"));
  const completed = (step) => stepIndex >= stepOrder.indexOf(step);
  const entityTargets = (board.entity_vo || []).map((row) => row.Entity).filter(Boolean).join(", ");
  const entities = `<div class="ddd-grid ddd-entity-layer">${(board.entity_vo || []).map((row) => {
    const modelType = dddModelKindLabel(row["Model Type"] || dddModelKindFromImpact(board, row.Entity));
    const methods = completed("behaviors") ? dddEntityMethodSignatures(board, row.Entity) : "";
    return `<article class="sticky ddd-entity"><div class="sticky-type">${escapeHtml(modelType || "entity")}</div><strong>${richTextHtml(row.Entity || "")}</strong><p>${richTextHtml(dddAttributeNames(row["Attributes / VOs"]))}</p>${methods ? `<p class="ddd-method">${richTextHtml(methods)}</p>` : ""}</article>`;
  }).join("")}</div>`;
  const behaviors = completed("behaviors") ? `<div class="ddd-relations">${(board.behaviors || []).filter((row) => {
    return String(row.Placement || "").toLowerCase().includes("domain service");
  }).map((row) => {
    const service = String(row.Placement || "").toLowerCase().includes("domain service");
    return `<div class="ddd-link-row"><article class="sticky ddd-behavior ${service ? "ddd-domain-service" : ""}"><div class="sticky-type">domain service</div><strong>${richTextHtml(row["Owner / Service"] || "")}</strong><p class="ddd-method">${richTextHtml(dddMethodLabel(row.Signature))}</p></article><span class="ddd-connector">calls -></span><span class="ddd-link-target">${richTextHtml(row.Participants || entityTargets || "Entity")}</span></div>`;
  }).join("")}</div>` : "";
  const flow = completed("application_flow") ? `<div class="ddd-flow">${(board.application_flow || []).map((row) => {
    const description = dddFlowDescription(row);
    return `<article class="ddd-service"><div class="sticky-type">application service</div><p><strong>${richTextHtml(dddMethodLabel(row.Signature || row["Application Service"]))}</strong>${description ? ` ${richTextHtml(description)}` : ""}</p></article>`;
  }).join("")}</div>` : "";
  const aggregates = completed("aggregates") ? `<div class="ddd-grid">${(board.aggregates || []).map((row) => `<div class="ddd-aggregate-card"><strong class="ddd-aggregate-name">${richTextHtml(row.Aggregate || "")}</strong><article class="ddd-boundary aggregate"><span class="root">Root: ${richTextHtml(row["Aggregate Root"] || "")}</span><p>${richTextHtml(row.Members || "")}</p><p>${richTextHtml(row["Atomic Invariant"] || "")}</p></article></div>`).join("")}</div>` : "";
  const contexts = completed("bounded_contexts") ? `<div class="ddd-grid">${(board.bounded_contexts || []).map((row) => `<article class="ddd-boundary context"><strong>${richTextHtml(row["Bounded Context"] || "")}</strong><p>${richTextHtml(row["Owned Aggregates / Entities"] || "")}</p><span class="communication">${richTextHtml(row["Communication Type"] || "")}${row["Target BC"] ? ` -> ${richTextHtml(row["Target BC"])}` : ""}</span></article>`).join("")}</div>` : "";
  const evidence = [
    renderDddEvidence(board.entity_vo || [], "Evidence"),
    completed("behaviors") ? renderDddEvidence(board.behaviors || [], "Policy Evidence") : "",
    completed("application_flow") ? renderDddEvidence(board.application_flow || [], "Evidence") : "",
    completed("aggregates") ? renderDddEvidence(board.aggregates || [], "Evidence") : "",
    completed("bounded_contexts") ? renderDddEvidence(board.bounded_contexts || [], "Evidence") : "",
  ].join("");
  return `<div class="ddd-evolved-design">${flow}${behaviors}${entities}${aggregates}${contexts}</div>${evidence}`;
}

function dddMethodLabel(signature) {
  const name = stickyText(signature).split("(", 1)[0].trim();
  return name ? `${name}()` : "method";
}

function dddFlowDescription(row) {
  const text = stickyText(row.Description || row.Pseudocode || row.Evidence || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/([A-Za-z_][\w.]*)\s*\([^)]*\)/g, "$1()")
    .replace(/\s*->\s*/g, ". ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.;,\s]+$/, "");
  return text ? `${text}.` : "";
}

function renderDddEvidence(rows, key) {
  if (!rows.length) return "";
  return `<div class="ddd-evidence">${rows.map((row) => `<p><strong>${richTextHtml(row.Entity || row["Owner / Service"] || row.Aggregate || row["Bounded Context"] || row["Application Service"] || "")}</strong>: ${richTextHtml(row[key] || "")}</p>`).join("")}</div>`;
}

function renderDddDocumentEditor(message = "") {
  const target = document.querySelector("#ddd-document-editor");
  const preview = document.querySelector("#ddd-live-board");
  if (!target) return;
  if (!app.openDocument?.id?.startsWith("ddd-design:")) {
    target.innerHTML = '<p class="small">A DDD design document appears after the first completed substep.</p>';
    if (preview) preview.innerHTML = '<p class="small">Complete Entity / Value Objects to visualize design.</p>';
    return;
  }
  const editing = app.editorMode === "edit";
  target.innerHTML = `<div class="doc-actions"><button id="ddd-preview-mode">Preview</button><button id="ddd-edit-mode">Edit</button>${editing ? '<button class="primary" id="ddd-save-doc">Save</button>' : ""}</div>
    ${message ? `<p class="error">${escapeHtml(message)}</p>` : ""}
    ${editing ? `<textarea id="ddd-doc-content">${escapeHtml(app.openDocument.content)}</textarea>` : `<div class="markdown-preview">${markdownPreview(app.openDocument.content)}</div>`}`;
  const update = (content) => {
    if (preview) preview.innerHTML = renderDddVisualization(parseDddMarkdown(content), app.dddSelectedStep);
  };
  update(app.openDocument.content);
  document.querySelector("#ddd-preview-mode").onclick = () => { app.editorMode = "preview"; renderDddDocumentEditor(); };
  document.querySelector("#ddd-edit-mode").onclick = () => { app.editorMode = "edit"; renderDddDocumentEditor(); };
  if (editing) {
    document.querySelector("#ddd-doc-content").oninput = (event) => update(event.target.value);
    document.querySelector("#ddd-save-doc").onclick = async () => {
      const content = document.querySelector("#ddd-doc-content").value;
      const response = await fetch(`/api/dashboard/documents/${encodeURIComponent(app.openDocument.id)}`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ content, revision: app.openDocument.revision }),
      });
      const result = await response.json();
      if (!response.ok) { renderDddDocumentEditor(result.error); return; }
      app.openDocument = result;
      app.editorMode = "preview";
      await loadDashboard();
      renderDddDocumentEditor();
    };
  }
}

function bindCanvas() {
  const canvas = document.querySelector("#event-canvas");
  const content = document.querySelector("#event-canvas-content");
  if (!canvas || !content) return;
  const apply = () => {
    content.style.transform = `translate(${app.canvas.x}px, ${app.canvas.y}px) scale(${app.canvas.scale})`;
    document.querySelector("#canvas-zoom-label").textContent = `${Math.round(app.canvas.scale * 100)}%`;
  };
  let dragging = false;
  let previous = null;
  canvas.onpointerdown = (event) => {
    if (event.target.closest(".sticky")) return;
    event.preventDefault();
    dragging = true;
    previous = { x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
  };
  canvas.onpointermove = (event) => {
    if (!dragging) return;
    app.canvas.x += event.clientX - previous.x;
    app.canvas.y += event.clientY - previous.y;
    previous = { x: event.clientX, y: event.clientY };
    apply();
  };
  canvas.onpointerup = () => { dragging = false; };
  canvas.onwheel = (event) => {
    event.preventDefault();
    app.canvas.scale = Math.max(0.4, Math.min(2.5, app.canvas.scale + (event.deltaY < 0 ? 0.1 : -0.1)));
    apply();
  };
  document.querySelector("#canvas-reset").onclick = () => {
    app.canvas = { scale: 1, x: 0, y: 0 };
    apply();
  };
  apply();
}

function bindDddCanvas() {
  const canvas = document.querySelector("#ddd-canvas");
  const content = document.querySelector("#ddd-canvas-content");
  if (!canvas || !content) return;
  const apply = () => {
    content.style.transform = `translate(${app.dddCanvas.x}px, ${app.dddCanvas.y}px) scale(${app.dddCanvas.scale})`;
    document.querySelector("#ddd-canvas-zoom-label").textContent = `${Math.round(app.dddCanvas.scale * 100)}%`;
  };
  let dragging = false;
  let previous = null;
  canvas.onpointerdown = (event) => {
    if (event.target.closest(".sticky, .ddd-boundary, .ddd-service")) return;
    event.preventDefault();
    dragging = true;
    previous = { x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(event.pointerId);
  };
  canvas.onpointermove = (event) => {
    if (!dragging) return;
    app.dddCanvas.x += event.clientX - previous.x;
    app.dddCanvas.y += event.clientY - previous.y;
    previous = { x: event.clientX, y: event.clientY };
    apply();
  };
  canvas.onpointerup = () => { dragging = false; };
  canvas.onwheel = (event) => {
    event.preventDefault();
    app.dddCanvas.scale = Math.max(0.4, Math.min(2.5, app.dddCanvas.scale + (event.deltaY < 0 ? 0.1 : -0.1)));
    apply();
  };
  document.querySelector("#ddd-canvas-reset").onclick = () => {
    app.dddCanvas = { scale: 1, x: 0, y: 0 };
    apply();
  };
  apply();
}

async function saveDocument() {
  const content = document.querySelector("#doc-content").value;
  const response = await fetch(`/api/dashboard/documents/${encodeURIComponent(app.openDocument.id)}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content, revision: app.openDocument.revision }),
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 409) await openDocument(app.openDocument.id);
    renderEditor(result.error);
    return;
  }
  app.openDocument = result;
  app.editorMode = "preview";
  await loadDashboard();
  renderEditor();
}

loadDashboard().catch((error) => {
  document.querySelector("#refresh-status").textContent = error.message;
});
document.querySelector("#new-change-set").onclick = () => {
  app.view = "new";
  app.openDocument = null;
  app.error = "";
  render();
};
document.querySelector("#dashboard-home").onclick = () => {
  app.view = "dashboard";
  app.openDocument = null;
  render();
};
setInterval(() => {
  if (app.view === "dashboard" && !isEditingDashboardDocument()) loadDashboard().catch(() => {});
}, 5000);
