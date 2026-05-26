const app = {
  state: { change_sets: [] },
  selectedChangeSet: null,
  openDocument: null,
  editorMode: "preview",
  view: "dashboard",
  harvest: null,
  requirementsChangeSet: null,
  stageTab: "requirements",
  workflowRecovered: false,
  busy: false,
  busyLabel: "",
  error: "",
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
  const head = headers.map((cell) => `<th>${renderInline(cell)}</th>`).join("");
  const body = rows.map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`).join("");
  return `<div class="markdown-table"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
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
    const requirementForm = document.querySelector("#grill-form");
    if (requirementForm) requirementForm.onsubmit = submitRequirementAnswer;
    const useCaseForm = document.querySelector("#use-case-form");
    if (useCaseForm) useCaseForm.onsubmit = submitUseCaseAnswer;
    const startUseCases = document.querySelector("#start-use-cases");
    if (startUseCases) startUseCases.onclick = startUseCaseDefinition;
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
  const body = app.stageTab === "useCases" ? renderUseCaseWorkspace() : renderRequirementsTab();
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
  return `<nav class="stage-tabs" aria-label="Workflow stages">
    <button class="stage-tab ${app.stageTab === "requirements" ? "selected" : ""}" data-stage-tab="requirements">
      <span class="progress-dot ${requirementsDone ? "complete" : "active"}"></span>Requirements
    </button>
    <button class="stage-tab ${app.stageTab === "useCases" ? "selected" : ""}" data-stage-tab="useCases" ${!requirementsDone ? "disabled" : ""}>
      <span class="progress-dot ${useCasesDone ? "complete" : requirementsDone ? "active" : ""}"></span>Use Cases
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
       <button class="primary next-stage" type="button" disabled title="Event Storming UI is next implementation slice.">Continue to Event Storming (next slice)</button>`
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
  app.stageTab = tab;
  if (tab === "requirements") {
    if (app.workflowRecovered) setRecoveredRequirementsDocument();
    else await openRequirementsDocument();
  }
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

function renderDetail(change) {
  const stages = change.stages.map((stage) => `
    <div class="stage ${stage.status}">
      <strong>${escapeHtml(stage.procedure)}</strong>
      <span class="pill ${stage.status}">${escapeHtml(stage.status)}</span>
      <div class="small">${escapeHtml(stage.verified_at)}</div>
    </div>`).join("");
  const workItems = change.work_items.map((item) => `
    <div class="panel">
      <h3>${escapeHtml(item.id)}: ${escapeHtml(item.name)}</h3>
      ${item.artifacts.map((artifact) => `<span class="artifact">${escapeHtml(artifact.path)}</span>`).join("")}
      ${renderBoard(item.event_storming)}
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
        ${escapeHtml(note.text)}
      </article>`).join("")}</div>`).join("")}`;
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
  app.stageTab = result.harvest.active_stage === "useCases" ? "useCases" : "requirements";
  app.workflowRecovered = true;
  app.view = "requirements";
  setRecoveredRequirementsDocument();
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
  if (app.view === "dashboard") loadDashboard().catch(() => {});
}, 5000);
