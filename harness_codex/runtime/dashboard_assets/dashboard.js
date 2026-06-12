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
  technicalSelectedUc: null,
  dddSelectedStep: "entity_vo",
  rerunStageId: "",
  rerunResult: "",
  workflowRecovered: false,
  busy: false,
  busyLabel: "",
  error: "",
  grillPanelCollapsed: false,
  canvas: { scale: 1, x: 0, y: 0 },
  dddCanvas: { scale: 1, x: 0, y: 0 },
};

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

let mermaidLoadPromise = null;

function renderMermaidDiagrams(root = document) {
  const nodes = [...root.querySelectorAll(".mermaid:not([data-mermaid-rendered])")];
  if (!nodes.length) return;
  if (!mermaidLoadPromise) {
    mermaidLoadPromise = import("https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.esm.min.mjs")
      .then((module) => {
        module.default.initialize({ startOnLoad: false, securityLevel: "strict" });
        return module.default;
      });
  }
  mermaidLoadPromise
    .then((mermaid) => mermaid.run({ nodes }))
    .then(() => nodes.forEach((node) => { node.dataset.mermaidRendered = "true"; }))
    .catch(() => nodes.forEach((node) => { node.classList.add("mermaid-error"); }));
}

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
    const fence = lines[index].match(/^```([A-Za-z0-9_-]*)\s*$/);
    if (fence) {
      flushList();
      const language = fence[1].toLowerCase();
      const block = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        block.push(lines[index]);
        index += 1;
      }
      const code = escapeHtml(block.join("\n"));
      html.push(language === "mermaid"
        ? `<pre class="mermaid">${code}</pre>`
        : `<pre><code class="language-${escapeHtml(language)}">${code}</code></pre>`);
      continue;
    }
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
    .replace(/&lt;br\s*\/?&gt;/gi, "<br>")
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
  const tallColumns = ["evidence", "pseudocode", "calls", "baseline-evidence", "event-storming-evidence", "policy-evidence", "attributes-vos", "proposed-definition", "atomic-invariant", "owned-aggregates-entities"];
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
    app.technicalSelectedUc = null;
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
    if (app.stageTab === "technicalDecisions") renderEditor();
    bindGrillPanel();
    const requirementForm = document.querySelector("#grill-form");
    if (requirementForm) requirementForm.onsubmit = submitRequirementAnswer;
    const startLanguage = document.querySelector("#start-ubiquitous-language");
    if (startLanguage) startLanguage.onclick = startUbiquitousLanguageDefinition;
    const completeLanguage = document.querySelector("#complete-ubiquitous-language");
    if (completeLanguage) completeLanguage.onclick = completeUbiquitousLanguageDefinition;
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
    const workflowRerunForm = document.querySelector("#workflow-rerun-form");
    if (workflowRerunForm) workflowRerunForm.onsubmit = submitWorkflowStageRerun;
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
    document.querySelectorAll("[data-technical-uc]").forEach((node) => {
      node.onclick = () => selectTechnicalUseCase(node.dataset.technicalUc);
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
    requestAnimationFrame(drawDddVoLinks);
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
    : app.stageTab === "technicalDecisions"
    ? renderTechnicalDecisionsWorkspace()
    : app.stageTab === "eventStorming"
    ? renderEventStormingWorkspace()
    : app.stageTab === "useCases"
    ? renderUseCaseWorkspace()
    : app.stageTab === "ubiquitousLanguage"
    ? renderUbiquitousLanguageWorkspace()
    : renderRequirementsTab();
  return `<section class="workflow-page">
    <div class="workspace-heading"><div><p class="eyebrow">ChangeSet Workflow</p><h2>${escapeHtml(app.requirementsChangeSet)} ${escapeHtml(title)}</h2></div></div>
    ${tabs}
    ${app.error ? `<p class="error">${escapeHtml(app.error)}</p>` : ""}
    ${busy}
    ${body}
  </section>`;
}

function renderGrillPanel(title, body) {
  const collapsed = app.grillPanelCollapsed;
  return `<section class="panel grill-panel ${collapsed ? "collapsed" : ""}">
    <div class="grill-panel-header">
      <h3>${escapeHtml(title)}</h3>
      <button type="button" class="grill-panel-toggle" data-grill-panel-toggle aria-expanded="${collapsed ? "false" : "true"}">${collapsed ? "Expand" : "Collapse"}</button>
    </div>
    <div class="grill-panel-body" ${collapsed ? "hidden" : ""}>${body}</div>
  </section>`;
}

function bindGrillPanel() {
  const toggle = document.querySelector("[data-grill-panel-toggle]");
  if (!toggle) return;
  toggle.onclick = () => {
    app.grillPanelCollapsed = !app.grillPanelCollapsed;
    render();
  };
}

function renderStageTabs() {
  const requirementsDone = app.harvest?.requirements_gate_passed;
  const languageDone = app.harvest?.language_gate_passed;
  const useCasesDone = app.harvest?.use_cases_ready;
  const eventsDone = app.harvest?.event_storming?.complete;
  const dddDone = app.harvest?.ddd_architecture?.complete;
  const technicalAvailable = Boolean(technicalDecisionUseCases().length);
  return `<nav class="stage-tabs" aria-label="Workflow stages">
    <button class="stage-tab ${app.stageTab === "requirements" ? "selected" : ""}" data-stage-tab="requirements">
      <span class="progress-dot ${requirementsDone ? "complete" : "active"}"></span>Requirements
    </button>
    <button class="stage-tab ${app.stageTab === "ubiquitousLanguage" ? "selected" : ""}" data-stage-tab="ubiquitousLanguage" ${!requirementsDone ? "disabled" : ""}>
      <span class="progress-dot ${languageDone ? "complete" : requirementsDone ? "active" : ""}"></span>Ubiquitous Language
    </button>
    <button class="stage-tab ${app.stageTab === "useCases" ? "selected" : ""}" data-stage-tab="useCases" ${!languageDone ? "disabled" : ""}>
      <span class="progress-dot ${useCasesDone ? "complete" : languageDone ? "active" : ""}"></span>Use Cases
    </button>
    <button class="stage-tab ${app.stageTab === "eventStorming" ? "selected" : ""}" data-stage-tab="eventStorming" ${!useCasesDone ? "disabled" : ""}>
      <span class="progress-dot ${eventsDone ? "complete" : useCasesDone ? "active" : ""}"></span>Event Storming
    </button>
    <button class="stage-tab ${app.stageTab === "dddArchitecture" ? "selected" : ""}" data-stage-tab="dddArchitecture" ${!eventsDone ? "disabled" : ""}>
      <span class="progress-dot ${dddDone ? "complete" : eventsDone ? "active" : ""}"></span>DDD Architecture
    </button>
    <button class="stage-tab ${app.stageTab === "technicalDecisions" ? "selected" : ""}" data-stage-tab="technicalDecisions" ${!dddDone || !technicalAvailable ? "disabled" : ""}>
      <span class="progress-dot ${technicalAvailable ? "complete" : dddDone ? "active" : ""}"></span>Technical Decisions
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
  const questions = app.harvest?.current_questions?.length
    ? app.harvest.current_questions
    : app.harvest?.current_question ? [app.harvest.current_question] : [];
  const questionPanel = app.harvest?.requirements_gate_passed
    ? renderWorkflowRerunPanel(
        "requirements-definition",
        "Requirements Definition",
        "",
        `<button class="primary next-stage" id="start-ubiquitous-language" type="button" ${app.busy ? "disabled" : ""}>Continue to Ubiquitous Language</button>`,
      )
    : questions.length
      ? `<form id="grill-form" class="grill-form">
          <p class="small">Answer all ${questions.length} questions, then submit them together.</p>
          ${questions.map((question, index) => `<section class="grill-question">
            <p class="question"><span class="question-number">${index + 1}</span>${escapeHtml(question.question)}</p>
            ${question.recommended ? `<p class="recommended">Recommended answer: ${escapeHtml(question.recommended)}</p>` : ""}
            <label for="grill-answer-${index}">Your answer</label>
            <textarea id="grill-answer-${index}" data-grill-answer required></textarea>
          </section>`).join("")}
          <button class="primary" type="submit" ${app.busy ? "disabled" : ""}>${app.busy ? "Processing..." : "Submit all answers"}</button>
        </form>`
      : "<p>No current question.</p>";
  return `
    <section class="panel requirements-document"><h3>Requirements</h3><div id="editor"></div></section>
    ${renderGrillPanel(app.harvest?.requirements_gate_passed ? "Rerun Requirements" : "Grill-Me Questions", questionPanel)}
  `;
}

function renderUbiquitousLanguageWorkspace() {
  const document = app.harvest?.context_markdown
    ? `<div class="markdown-preview">${markdownPreview(app.harvest.context_markdown)}</div>`
    : '<p class="small">context.md unavailable.</p>';
  const action = app.harvest?.language_gate_passed
    ? renderWorkflowRerunPanel(
        "ubiquitous-language-definition",
        "Ubiquitous Language Definition",
        "",
        `<button class="primary next-stage" id="start-use-cases" type="button" ${app.busy ? "disabled" : ""}>Continue to Use Case Definition</button>`,
      )
    : `<p>Review canonical terms, naming rules, aliases, and forbidden terms before continuing.</p>
       <button class="primary next-stage" id="complete-ubiquitous-language" type="button" ${app.busy ? "disabled" : ""}>Confirm Ubiquitous Language</button>`;
  return `
    <section class="panel requirements-document"><h3>Ubiquitous Language</h3>${document}</section>
    ${renderGrillPanel(app.harvest?.language_gate_passed ? "Rerun Ubiquitous Language" : "Language Gate", action)}
  `;
}

function renderUseCaseWorkspace() {
  const question = app.harvest?.current_question;
  const questionPanel = app.harvest?.use_cases_ready
    ? renderWorkflowRerunPanel(
        "use-case-definition",
        "Use Case Definition",
        "",
        `<button class="primary next-stage" id="start-event-storming" type="button" ${app.busy ? "disabled" : ""}>Continue to Event Storming</button>`,
      )
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
    ${renderGrillPanel(app.harvest?.use_cases_ready ? "Rerun Use Case Definition" : "Use Case Questions", questionPanel)}
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
    interaction = renderWorkflowRerunPanel(
      "event-storming",
      `${currentId} Event Storming`,
      currentId,
      `<button class="primary next-stage" id="start-ddd-architecture" type="button" ${app.busy ? "disabled" : ""}>Continue to DDD Architecture</button>`,
    );
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
    ${renderGrillPanel(state.complete ? "Rerun Event Storming" : "Oracle Questions", interaction)}`;
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
    interaction = renderWorkflowRerunPanel(
      "ddd-architecture-definition",
      `${currentId} DDD Architecture`,
      currentId,
      technicalDecisionUseCases().length
        ? '<button class="primary next-stage" type="button" data-stage-tab="technicalDecisions">Open Technical Decisions</button>'
        : '<button class="primary next-stage" type="button" disabled>Technical Decisions document not available</button>',
    );
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
  return `<section class="panel"><h3>DDD Architecture Progress</h3><p class="small">Completed ${escapeHtml(state.completed_count || 0)} / ${escapeHtml(state.total_count || 0)} substeps</p>${restartAction}<div class="event-progress">${ucProgress}</div><nav class="ddd-steps">${stepTabs}</nav></section>
    <section class="panel"><h3>${escapeHtml(currentId || "DDD")} Design Document</h3><div id="ddd-document-editor"></div></section>
    <section class="panel ddd-live-preview"><h3>Design Visualization</h3><div id="ddd-live-board"></div></section>
    ${renderGrillPanel(state.complete ? "Rerun DDD Architecture" : "DDD Architect Questions", `${rerunControls}${interaction}`)}`;
}

function technicalDecisionUseCases() {
  const change = app.state.change_sets.find((item) => item.id === app.requirementsChangeSet);
  const documents = (change?.documents || [])
    .filter((document) => document.kind === "technical-decisions")
    .map((document) => ({
      id: document.id.split(":").at(-1),
      documentId: document.id,
      label: document.label,
    }));
  const byId = new Map(documents.map((item) => [item.id, item]));
  for (const ucId of app.harvest?.ddd_architecture?.uc_ids || []) {
    if (!byId.has(ucId)) {
      byId.set(ucId, {
        id: ucId,
        documentId: `technical-decisions:${app.requirementsChangeSet}:${ucId}`,
        label: `${ucId} Technical Decisions`,
      });
    }
  }
  return [...byId.values()];
}

function renderTechnicalDecisionsWorkspace() {
  const useCases = technicalDecisionUseCases();
  const currentId = app.technicalSelectedUc || useCases[0]?.id || "";
  const tabs = useCases.map((item) => `<button type="button" data-technical-uc="${escapeHtml(item.id)}" class="event-progress-item ${item.id === currentId ? "complete" : ""}">${escapeHtml(item.id)}</button>`).join("");
  const rerun = currentId
    ? renderWorkflowRerunPanel("technical-decisions", `${currentId} Technical Decisions`, currentId)
    : '<p class="small">No completed Technical Decisions document.</p>';
  return `<section class="panel"><h3>Technical Decisions</h3><div class="event-progress">${tabs}</div></section>
    <section class="panel requirements-document"><h3>${escapeHtml(currentId || "Technical Decisions")} Document</h3><div id="editor"></div></section>
    ${renderGrillPanel("Rerun Technical Decisions", rerun)}`;
}

function renderWorkflowRerunPanel(stageId, label, ucId = "", nextAction = "") {
  return `<form id="workflow-rerun-form" class="stage-rerun-form" data-stage-id="${escapeHtml(stageId)}" data-uc-id="${escapeHtml(ucId)}">
    <p class="completion">${escapeHtml(label)} complete.</p>
    <p class="small">Reruns this stage with <code>--force</code>, verifies output, and marks downstream design stale.</p>
    <label for="workflow-rerun-prompt">Correction prompt</label>
    <textarea id="workflow-rerun-prompt" placeholder="Describe corrections or additional decisions..." required ${app.busy ? "disabled" : ""}></textarea>
    <button class="primary" type="submit" ${app.busy ? "disabled" : ""}>${app.busy ? "Rerunning..." : "Rerun and verify"}</button>
    ${nextAction}
  </form>`;
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
  const answers = [...document.querySelectorAll("[data-grill-answer]")].map((input) => input.value.trim());
  if (!answers.length || answers.some((answer) => !answer)) return;
  app.busy = true;
  app.busyLabel = "Submitting answer";
  render();
  try {
    const response = await fetch("/api/change-sets/requirements/answer", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ change_set_id: app.requirementsChangeSet, answers }),
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
  if (tab === "ubiquitousLanguage" && !app.harvest?.requirements_gate_passed) return;
  if (tab === "useCases" && !app.harvest?.language_gate_passed) return;
  if (tab === "eventStorming" && !app.harvest?.use_cases_ready) return;
  if (tab === "dddArchitecture" && !app.harvest?.event_storming?.complete) return;
  if (tab === "technicalDecisions" && (!app.harvest?.ddd_architecture?.complete || !technicalDecisionUseCases().length)) return;
  app.stageTab = tab;
  if (tab === "requirements") {
    if (app.workflowRecovered) setRecoveredRequirementsDocument();
    else await openRequirementsDocument();
  }
  if (tab === "eventStorming") await openCurrentEventDocument();
  if (tab === "dddArchitecture") await openCurrentDddDocument();
  if (tab === "technicalDecisions") await openCurrentTechnicalDecisionsDocument();
  render();
}

async function startUbiquitousLanguageDefinition() {
  app.stageTab = "ubiquitousLanguage";
  await updateUbiquitousLanguage("/api/ubiquitous-language/start", "Opening Ubiquitous Language");
}

async function completeUbiquitousLanguageDefinition() {
  await updateUbiquitousLanguage("/api/ubiquitous-language/complete", "Confirming Ubiquitous Language");
}

async function updateUbiquitousLanguage(path, busyLabel) {
  app.busy = true;
  app.busyLabel = busyLabel;
  render();
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ change_set_id: app.requirementsChangeSet }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Unable to update ubiquitous language stage.");
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

async function submitWorkflowStageRerun(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const stageId = form.dataset.stageId || "";
  const ucId = form.dataset.ucId || "";
  const prompt = document.querySelector("#workflow-rerun-prompt")?.value.trim() || "";
  if (!prompt || !stageId) return;
  app.busy = true;
  app.busyLabel = `Rerunning ${stageId}`;
  app.error = "";
  render();
  try {
    const response = await fetch(`/api/dashboard/change-sets/${encodeURIComponent(app.requirementsChangeSet)}/rerun-stage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stage_id: stageId,
        uc_id: ucId,
        user_prompt: prompt,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Unable to rerun event storming.");
    app.harvest = result.harvest;
    app.state = result.dashboard;
    if (stageId === "event-storming") {
      app.eventSelectedUc = ucId;
      await openCurrentEventDocument();
    } else if (stageId === "ddd-architecture-definition") {
      app.dddSelectedUc = ucId;
      await openCurrentDddDocument();
    } else if (stageId === "technical-decisions") {
      app.technicalSelectedUc = ucId;
      await openCurrentTechnicalDecisionsDocument();
    } else if (stageId === "requirements-definition") {
      await openRequirementsDocument();
    } else {
      app.openDocument = null;
    }
  } catch (error) {
    app.error = error.message;
  } finally {
    app.busy = false;
    app.busyLabel = "";
    render();
  }
}

async function openCurrentTechnicalDecisionsDocument() {
  const useCases = technicalDecisionUseCases();
  const ucId = app.technicalSelectedUc || useCases[0]?.id;
  const document = useCases.find((item) => item.id === ucId);
  if (!document) {
    app.openDocument = null;
    return;
  }
  const response = await fetch(`/api/dashboard/documents/${encodeURIComponent(document.documentId)}`);
  if (response.ok) {
    app.technicalSelectedUc = ucId;
    app.openDocument = await response.json();
    app.editorMode = "preview";
  }
}

async function selectTechnicalUseCase(ucId) {
  app.technicalSelectedUc = ucId;
  await openCurrentTechnicalDecisionsDocument();
  render();
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
      ${change.lifecycle === "active" && ["verified", "stale"].includes(stage.status) && rerunnableDesignStage(stage.id)
        ? `<button type="button" class="stage-rerun-button" data-rerun-stage="${escapeHtml(stage.id)}">Rerun</button>`
        : ""}
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
    <section class="panel"><h3>Workflow Stages</h3><div class="timeline">${stages}</div>
      ${renderStageRerunForm(change)}
    </section>
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
  document.querySelectorAll("[data-rerun-stage]").forEach((node) => {
    node.onclick = () => {
      app.rerunStageId = node.dataset.rerunStage;
      app.rerunResult = "";
      app.error = "";
      render();
    };
  });
  const rerunForm = document.querySelector("#stage-rerun-form");
  if (rerunForm) rerunForm.onsubmit = (event) => submitStageRerun(event, change);
  const cancelRerun = document.querySelector("#cancel-stage-rerun");
  if (cancelRerun) cancelRerun.onclick = () => {
    app.rerunStageId = "";
    app.rerunResult = "";
    render();
  };
  if (app.openDocument && change.documents.some((item) => item.id === app.openDocument.id)) {
    renderEditor();
  }
  bindCanvas();
  bindDddCanvas();
  requestAnimationFrame(drawDddVoLinks);
}

function rerunnableDesignStage(stageId) {
  return [
    "requirements-definition",
    "ubiquitous-language-definition",
    "use-case-definition",
    "event-storming",
    "ddd-architecture-definition",
    "technical-decisions",
  ].includes(stageId);
}

function stageRequiresUseCase(stageId) {
  return [
    "event-storming",
    "ddd-architecture-definition",
    "technical-decisions",
  ].includes(stageId);
}

function renderStageRerunForm(change) {
  if (!app.rerunStageId) {
    return app.rerunResult ? `<p class="completion stage-rerun-result">${escapeHtml(app.rerunResult)}</p>` : "";
  }
  const stage = change.stages.find((item) => item.id === app.rerunStageId);
  if (!stage) return "";
  const requiresUc = stageRequiresUseCase(stage.id);
  const workItems = change.work_items.filter((item) => item.id.startsWith("UC-"));
  const ucField = requiresUc
    ? `<label for="stage-rerun-uc">Use case</label>
       <select id="stage-rerun-uc" required>
         <option value="">Select use case</option>
         ${workItems.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.id)}: ${escapeHtml(item.name)}</option>`).join("")}
       </select>`
    : "";
  return `<form id="stage-rerun-form" class="stage-rerun-form">
    <h4>Rerun ${escapeHtml(stage.procedure)}</h4>
    <p class="small">Stage agent runs again with <code>--force</code>, updates artifacts, then runs normal stage verification.</p>
    ${ucField}
    <label for="stage-rerun-prompt">Correction prompt</label>
    <textarea id="stage-rerun-prompt" placeholder="Describe corrections or additional decisions..." required ${app.busy ? "disabled" : ""}></textarea>
    <div class="stage-rerun-actions">
      <button class="primary" type="submit" ${app.busy ? "disabled" : ""}>${app.busy ? "Rerunning..." : "Rerun and verify"}</button>
      <button id="cancel-stage-rerun" type="button" ${app.busy ? "disabled" : ""}>Cancel</button>
    </div>
  </form>`;
}

async function submitStageRerun(event, change) {
  event.preventDefault();
  const prompt = document.querySelector("#stage-rerun-prompt")?.value.trim() || "";
  const ucId = document.querySelector("#stage-rerun-uc")?.value || "";
  if (!prompt) return;
  app.busy = true;
  app.error = "";
  render();
  try {
    const response = await fetch(`/api/dashboard/change-sets/${encodeURIComponent(change.id)}/rerun-stage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stage_id: app.rerunStageId,
        uc_id: ucId,
        user_prompt: prompt,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Unable to rerun design stage.");
    app.state = result.dashboard;
    app.rerunResult = result.output || "Stage rerun and verification completed.";
    app.rerunStageId = "";
  } catch (error) {
    app.error = error.message;
  } finally {
    app.busy = false;
    render();
  }
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
    ? "eventStorming" : result.harvest.active_stage === "useCases"
    ? "useCases" : result.harvest.active_stage === "ubiquitousLanguage"
    ? "ubiquitousLanguage" : "requirements";
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
  if (!editing) renderMermaidDiagrams(target);
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
  if (!editing) renderMermaidDiagrams(target);
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
  const normalized = rows.map((row) => {
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
  const voNames = new Set(normalized.filter((row) => dddModelKindLabel(row["Model Type"] || row.Kind || row.Type) === "vo").map((row) => dddModelName(row)).filter(Boolean));
  normalized.forEach((row) => dddInlineVoDefinitions(row["Attributes / VOs"]).forEach((definition) => voNames.add(definition.name)));
  return normalized.map((row) => {
    const modelName = dddModelName(row);
    const properties = dddModelProperties(row["Attributes / VOs"], modelName).map((property) => ({
      ...property,
      kind: voNames.has(property.type) && property.type !== modelName ? "vo" : "attribute",
    }));
    const references = dddModelKindLabel(row["Model Type"] || row.Kind || row.Type) === "vo"
      ? []
      : properties.filter((property) => property.kind === "vo");
    const referencedNames = new Set(references.map((property) => property.type));
    dddInlineVoDefinitions(row["Attributes / VOs"]).forEach((definition) => {
      if (definition.name !== modelName && !referencedNames.has(definition.name)) {
        references.push({ name: definition.name, type: definition.name, display: definition.name, kind: "vo" });
      }
    });
    return { ...row, Properties: properties, "VO References": references };
  });
}

function splitDddAttributeParts(attributes) {
  const text = stickyText(attributes || "").replace(/<br\s*\/?>/gi, "\n");
  const parts = [];
  let current = "";
  let braceDepth = 0;
  let parenDepth = 0;
  for (const char of text) {
    if (char === "{") braceDepth += 1;
    if (char === "}") braceDepth = Math.max(0, braceDepth - 1);
    if (char === "(") parenDepth += 1;
    if (char === ")") parenDepth = Math.max(0, parenDepth - 1);
    if ([",", ";", "\n"].includes(char) && braceDepth === 0 && parenDepth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function dddInlineVoDefinitions(attributes) {
  return splitDddAttributeParts(attributes).map((part) => {
    const match = part.match(/^([A-Z][A-Za-z0-9_]*)\s*\{([^}]*)\}/);
    return match ? { name: match[1], properties: dddModelProperties(match[2], match[1]) } : null;
  }).filter(Boolean);
}

function dddModelProperties(attributes, modelName = "") {
  const properties = [];
  splitDddAttributeParts(attributes).forEach((part) => {
    const inlineVo = part.match(/^([A-Z][A-Za-z0-9_]*)\s*\{([^}]*)\}/);
    if (inlineVo) {
      if (inlineVo[1] === modelName) properties.push(...dddModelProperties(inlineVo[2], modelName));
      return;
    }
    const nameFirst = part.match(/^([A-Za-z_][A-Za-z0-9_?]*)\s*:\s*([^()]+?)(?:\s*\(|$)/);
    if (nameFirst) {
      const typeName = cleanDddType(nameFirst[2]);
      if (typeName) properties.push({ name: nameFirst[1], type: typeName, display: `${typeName} ${nameFirst[1]}` });
      return;
    }
    const typeFirst = part.match(/^([A-Z][A-Za-z0-9_<>,\[\]?]*|[a-z][A-Za-z0-9_]*<[^>]+>)\s+([a-z][A-Za-z0-9_?]*)(?:\s*\(|$)/);
    if (typeFirst) {
      const typeName = cleanDddType(typeFirst[1]);
      if (typeName) properties.push({ name: typeFirst[2], type: typeName, display: `${typeName} ${typeFirst[2]}` });
    }
  });
  return properties;
}

function cleanDddType(value) {
  return stickyText(value || "").replace(/\s+/g, " ").trim().replace(/[:,;]+$/g, "");
}

function dddAttributeDisplayLines(attributes) {
  return dddModelProperties(attributes).map((property) => property.display).join("\n");
}

function dddModelName(row) {
  return stickyText(row.Entity || row.Model || "").trim();
}

function dddModelType(board, row) {
  return dddModelKindLabel(row["Model Type"] || row.Kind || row.Type || dddModelKindFromImpact(board, dddModelName(row)));
}

function dddIsValueObject(board, row) {
  return dddModelType(board, row) === "vo";
}

function dddSplitNames(text) {
  return stickyText(text)
    .replace(/<br\s*\/?>/gi, "\n")
    .split(/[,;\n]/g)
    .map((part) => part.trim().replace(/^`|`$/g, ""))
    .filter(Boolean);
}

function dddVoReferenceRows(row) {
  const references = Array.isArray(row?.["VO References"]) ? row["VO References"] : [];
  return references.map((ref) => ({
    name: ref.type || ref.name,
    property: ref.display || (ref.type && ref.name ? `${ref.type} ${ref.name}` : ref.name || ""),
    detail: ref.detail || "",
  })).filter((ref) => ref.name);
}

function dddPropertyDisplayLines(row, attributes = "") {
  const source = attributes || row?.["Attributes / VOs"] || row?.["Proposed Identity / State"] || (typeof row === "string" ? row : "");
  const properties = Array.isArray(row?.Properties) ? row.Properties : dddModelProperties(source);
  return properties.map((property) => property.display || (property.type && property.name ? `${property.type} ${property.name}` : property.name || property.type || "")).filter(Boolean).join("\n");
}

function dddLinkKey(...parts) {
  return parts.map((part) => stickyText(part).replace(/[^A-Za-z0-9_-]+/g, "-")).join("-");
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
    .join("\n");
}

function dddAggregateMembers(row, allNames) {
  const members = new Set(dddSplitNames(row.Members || row["Owned Aggregates / Entities"] || ""));
  if (!members.size) allNames.forEach((name) => members.add(name));
  return members;
}

function dddFlowTouchesMembers(row, members, aggregateName) {
  const haystack = stickyText([row.Calls, row.Description, row.Pseudocode, row["Application Service"], row.Signature].filter(Boolean).join(" "));
  const candidates = [aggregateName, ...members].filter(Boolean);
  return !candidates.length || candidates.some((name) => haystack.includes(name));
}

function renderDddPropertiesHtml(properties, linkKeys = new Map()) {
  const rows = Array.isArray(properties)
    ? properties.map((property) => ({
      display: property.display || (property.type && property.name ? `${property.type} ${property.name}` : property.name || property.type || ""),
      linkKey: linkKeys.get(property.display) || "",
    }))
    : stickyText(properties || "").split(/\n/g).filter(Boolean).map((display) => ({ display, linkKey: linkKeys.get(display) || "" }));
  return rows.map((row) => `<div class="ddd-property-line ${row.linkKey ? "ddd-property-vo-source" : ""}" ${row.linkKey ? `data-ddd-vo-source="${escapeHtml(row.linkKey)}"` : ""}>${richTextHtml(row.display)}</div>`).join("");
}

function renderDddModelCard(kind, name, properties, methods, root = false, options = {}) {
  const propertyHtml = renderDddPropertiesHtml(properties, options.propertyLinkKeys || new Map());
  return `<article class="ddd-model-card ddd-${kind}-card"><div class="ddd-model-header"><span>${kind === "vo" ? "vo" : "entity"}</span>${root ? `<span class="ddd-root-badge">root</span>` : ""}</div><div class="ddd-model-name">${richTextHtml(name)}</div><div class="ddd-model-section ddd-model-properties"><span class="ddd-model-section-tag">attributes</span><div class="ddd-model-section-content">${propertyHtml}</div></div><div class="ddd-model-section ddd-model-methods"><span class="ddd-model-section-tag">methods</span><div class="ddd-model-section-content">${richTextHtml(methods || "")}</div></div></article>`;
}

function renderDddVisualization(board, stepId) {
  if (!board) return '<p class="small">No completed DDD design substep.</p>';
  const stepOrder = ["entity_vo", "behaviors", "application_flow", "aggregates", "bounded_contexts"];
  const stepIndex = Math.max(0, stepOrder.indexOf(stepId || "entity_vo"));
  const completed = (step) => stepIndex >= stepOrder.indexOf(step);
  const modelRows = board.entity_vo || [];
  const allNames = modelRows.map(dddModelName).filter(Boolean);
  const entityRows = modelRows.filter((row) => !dddIsValueObject(board, row));
  const explicitVoRows = modelRows.filter((row) => dddIsValueObject(board, row));
  const aggregateRows = completed("aggregates") && (board.aggregates || []).length
    ? board.aggregates
    : [{ Aggregate: entityRows[0] ? `${dddModelName(entityRows[0])} Aggregate` : "Unconfirmed Aggregate", "Aggregate Root": entityRows[0] ? dddModelName(entityRows[0]) : "", Members: allNames.join(", ") }];
  const aggregatePanels = aggregateRows.map((aggregateRow) => {
    const rootName = stickyText(aggregateRow["Aggregate Root"] || "");
    const aggregateName = stickyText(aggregateRow.Aggregate || "");
    const displayAggregateName = aggregateName && aggregateName.toLowerCase() !== "aggregate"
      ? aggregateName
      : (rootName ? `${rootName} Aggregate` : "Unconfirmed Aggregate");
    const members = dddAggregateMembers(aggregateRow, allNames);
    const aggregateEntities = entityRows.filter((row) => members.has(dddModelName(row)) || !members.size);
    const voRowsByName = new Map(explicitVoRows.map((row) => [dddModelName(row), row]).filter(([name]) => name));
    const linkedVoRefsByEntity = new Map();
    const aggregateVoRefs = new Map();
    aggregateEntities.forEach((row) => {
      const entityName = dddModelName(row);
      const refs = [];
      dddVoReferenceRows(row).forEach((ref) => {
        if (ref.name === entityName) return;
        refs.push(ref);
        aggregateVoRefs.set(ref.name, ref);
      });
      linkedVoRefsByEntity.set(entityName, refs);
    });
    explicitVoRows.forEach((row) => {
      const name = dddModelName(row);
      if (members.has(name) || aggregateVoRefs.has(name)) {
        const attributes = row["Attributes / VOs"] || row["Proposed Identity / State"] || "";
        aggregateVoRefs.set(name, { name, property: "", detail: dddPropertyDisplayLines(row, attributes) });
      }
    });
    const linkedVoNames = new Set();
    const renderVoCard = (ref) => {
      const row = voRowsByName.get(ref.name);
      const attributes = row ? dddPropertyDisplayLines(row, row["Attributes / VOs"] || row["Proposed Identity / State"] || "") : "";
      return renderDddModelCard("vo", ref.name, attributes || ref.detail || ref.property, "", false);
    };
    const entityVoRows = aggregateEntities.map((row) => {
      const name = dddModelName(row);
      const methods = completed("behaviors") ? dddEntityMethodSignatures(board, name) : "";
      const refs = linkedVoRefsByEntity.get(name) || [];
      const propertyLinkKeys = new Map(refs.map((ref, index) => [ref.property, dddLinkKey(name, ref.name, index)]));
      const entityProperties = Array.isArray(row.Properties) ? row.Properties : dddModelProperties(row["Attributes / VOs"]);
      const entityCard = renderDddModelCard("entity", name, entityProperties, methods, name === rootName, { propertyLinkKeys });
      refs.forEach((ref) => linkedVoNames.add(ref.name));
      const linkedVoCards = refs.length
        ? `<div class="ddd-linked-vo-stack">${refs.map((ref, index) => `<div class="ddd-linked-vo" data-ddd-vo-target="${escapeHtml(dddLinkKey(name, ref.name, index))}">${renderVoCard(ref)}</div>`).join("")}</div>`
        : "";
      return `<div class="ddd-entity-vo-row">${entityCard}${linkedVoCards}</div>`;
    }).join("");
    const standaloneVoCards = [...aggregateVoRefs.values()]
      .filter((ref) => !linkedVoNames.has(ref.name))
      .map((ref) => renderVoCard(ref))
      .join("");
    const standaloneVoBoard = standaloneVoCards ? `<div class="ddd-standalone-vo-board">${standaloneVoCards}</div>` : "";
    const appServices = completed("application_flow") ? (board.application_flow || []).filter((row) => dddFlowTouchesMembers(row, members, displayAggregateName)).map((row) => {
      const description = dddFlowDescription(row);
      return `<article class="ddd-service-box ddd-app-service-box"><div class="ddd-service-type">application service</div><strong>${richTextHtml(dddMethodLabel(row.Signature || row["Application Service"]))}</strong>${description ? `<p>${richTextHtml(description)}</p>` : ""}</article>`;
    }).join("") : "";
    const services = appServices ? `<div class="ddd-aggregate-services ddd-app-service-list">${appServices}</div>` : "";
    return `<section class="ddd-aggregate-panel"><h5 class="ddd-aggregate-name">${richTextHtml(displayAggregateName)}</h5><div class="ddd-model-board">${entityVoRows}${standaloneVoBoard}</div>${services}</section>`;
  }).join("");
  const contexts = completed("bounded_contexts") && (board.bounded_contexts || []).length
    ? `<section class="ddd-context-panel"><h5 class="ddd-context-heading">Bounded Contexts</h5><div class="ddd-grid">${board.bounded_contexts.map((row) => `<article class="ddd-boundary context"><strong>${richTextHtml(row["Bounded Context"] || "")}</strong>${renderDddContextOwnedHtml(row["Owned Aggregates / Entities"] || "")}<span class="communication">${richTextHtml(row["Communication Type"] || "")}${row["Target BC"] ? ` -> ${richTextHtml(row["Target BC"])}` : ""}</span></article>`).join("")}</div></section>`
    : "";
  const evidence = [
    renderDddEvidence(board.entity_vo || [], "Evidence"),
    completed("behaviors") ? renderDddEvidence(board.behaviors || [], "Policy Evidence") : "",
    completed("application_flow") ? renderDddEvidence(board.application_flow || [], "Evidence") : "",
    completed("aggregates") ? renderDddEvidence(board.aggregates || [], "Evidence") : "",
    completed("bounded_contexts") ? renderDddEvidence(board.bounded_contexts || [], "Evidence") : "",
  ].join("");
  return `<div class="ddd-evolved-design">${aggregatePanels}${contexts}</div>${evidence}`;
}

function drawDddVoLinks() {
  document.querySelectorAll(".ddd-entity-vo-row").forEach((row) => {
    row.querySelector(".ddd-vo-link-layer")?.remove();
    const targets = [...row.querySelectorAll("[data-ddd-vo-target]")];
    if (!targets.length) return;
    const rowRect = row.getBoundingClientRect();
    const entityCard = row.querySelector(".ddd-entity-card");
    if (!entityCard) return;
    const entityRect = entityCard.getBoundingClientRect();
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("ddd-vo-link-layer");
    const svgWidth = row.scrollWidth;
    const svgHeight = Math.max(row.scrollHeight, rowRect.height);
    svg.setAttribute("width", `${svgWidth}`);
    svg.setAttribute("height", `${svgHeight}`);
    svg.setAttribute("viewBox", `0 0 ${svgWidth} ${svgHeight}`);
    const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
    const marker = document.createElementNS("http://www.w3.org/2000/svg", "marker");
    marker.setAttribute("id", "ddd-vo-arrow-head");
    marker.setAttribute("markerWidth", "8");
    marker.setAttribute("markerHeight", "8");
    marker.setAttribute("refX", "7");
    marker.setAttribute("refY", "4");
    marker.setAttribute("orient", "auto");
    const markerPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
    markerPath.setAttribute("d", "M 0 0 L 8 4 L 0 8 z");
    markerPath.setAttribute("fill", "#7f9bb7");
    marker.appendChild(markerPath);
    defs.appendChild(marker);
    svg.appendChild(defs);
    targets.forEach((target, index) => {
      const targetCard = target?.querySelector(".ddd-model-card");
      if (!targetCard) return;
      const targetRect = targetCard.getBoundingClientRect();
      const startX = entityRect.left + entityRect.width * 0.5 - rowRect.left;
      const boxClearance = 8;
      const startY = entityRect.top - rowRect.top - boxClearance;
      const endX = targetRect.left + targetRect.width * 0.5 - rowRect.left;
      const endY = targetRect.top - rowRect.top - boxClearance;
      const routeY = Math.max(12, Math.min(startY, endY) - 42 - index * 12);
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", `M ${startX} ${startY} L ${startX} ${routeY} L ${endX} ${routeY} L ${endX} ${endY}`);
      path.setAttribute("class", "ddd-vo-link-path");
      path.setAttribute("marker-end", "url(#ddd-vo-arrow-head)");
      svg.appendChild(path);
    });
    row.prepend(svg);
  });
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

function renderDddContextOwnedHtml(value) {
  const items = dddSplitNames(value);
  if (!items.length) return "";
  return `<div class="ddd-context-owned">${items.map((item) => `<div class="ddd-context-owned-item">${richTextHtml(item)}</div>`).join("")}</div>`;
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
  if (!editing) renderMermaidDiagrams(target);
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
    if (event.target.closest(".sticky, .ddd-boundary, .ddd-service, .ddd-model-card, .ddd-service-box")) return;
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
  requestAnimationFrame(drawDddVoLinks);
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
