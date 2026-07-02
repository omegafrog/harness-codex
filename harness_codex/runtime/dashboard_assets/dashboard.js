const app = {
  state: { change_sets: [], project_documents: { lanes: [], document_count: 0 } },
  selectedChangeSet: null,
  openDocument: null,
  projectSelectedLane: null,
  editorMode: "preview",
  view: "dashboard",
  harvest: null,
  requirementsChangeSet: null,
  stageTab: "requirements",
  eventSelectedUc: null,
  dddSelectedUc: null,
  dddPollTimer: null,
  technicalSelectedUc: null,
  planningSelectedUc: null,
  planning: null,
  planningPollTimer: null,
  implementation: null,
  implementationSelectedUc: "",
  implementationSelectedDiffPath: "",
  implementationSelectedTask: null,
  implementationDiffSearch: "",
  implementationOpenDiffDirs: {},
  implementationDiffViewMode: "diff",
  planChecklistCollapsed: false,
  implementationJobCollapsed: false,
  implementationPollTimer: null,
  delivery: null,
  deliveryPollTimer: null,
  appRuntime: null,
  appRuntimeBusy: "",
  dddSelectedStep: "entity_vo",
  rerunStageId: "",
  rerunResult: "",
  rerunJob: null,
  rerunPollTimer: null,
  workflowRecovered: false,
  busy: false,
  busyLabel: "",
  workflowActivity: null,
  workflowActivityPollTimer: null,
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

async function loadDashboard({ preserveScroll = false } = {}) {
  const response = await fetch("/api/dashboard");
  app.state = await response.json();
  if (!app.selectedChangeSet && app.state.change_sets.length) {
    app.selectedChangeSet = app.state.change_sets[0].id;
  }
  if (preserveScroll) renderPreservingScroll();
  else render();
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
    if (app.dddPollTimer) clearTimeout(app.dddPollTimer);
    app.dddPollTimer = null;
    app.technicalSelectedUc = null;
    app.planningSelectedUc = null;
    app.planning = null;
    if (app.planningPollTimer) clearTimeout(app.planningPollTimer);
    app.planningPollTimer = null;
    app.implementation = null;
    app.implementationSelectedDiffPath = "";
    if (app.implementationPollTimer) clearTimeout(app.implementationPollTimer);
    app.implementationPollTimer = null;
    app.delivery = null;
    if (app.deliveryPollTimer) clearTimeout(app.deliveryPollTimer);
    app.deliveryPollTimer = null;
    app.canvas = { scale: 1, x: 0, y: 0 };
    app.dddCanvas = { scale: 1, x: 0, y: 0 };
    app.view = "dashboard";
    render();
  });
  const detail = document.querySelector("#detail");
  if (app.view === "project") {
    detail.innerHTML = renderProjectDocuments();
    bindProjectDocuments();
    return;
  }
  if (app.view === "appRuntime") {
    detail.innerHTML = renderAppRuntime();
    bindAppRuntime();
    return;
  }
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
    const restartTechnicalDecisions = document.querySelector("#restart-technical-decisions");
    if (restartTechnicalDecisions) restartTechnicalDecisions.onclick = restartTechnicalDecisionsFromScratch;
    const runAllTechnicalDecisions = document.querySelector("#run-all-technical-decisions");
    if (runAllTechnicalDecisions) runAllTechnicalDecisions.onclick = runAllTechnicalDecisionsStage;
    const startDdd = document.querySelector("#start-ddd-architecture");
    if (startDdd) startDdd.onclick = startDddArchitecture;
    const restartDdd = document.querySelector("#restart-ddd-architecture");
    if (restartDdd) restartDdd.onclick = restartDddArchitecture;
    const advanceDdd = document.querySelector("#advance-ddd-architecture");
    if (advanceDdd) advanceDdd.onclick = continueDddArchitecture;
    const runAllDdd = document.querySelector("#run-all-ddd-architecture");
    if (runAllDdd) runAllDdd.onclick = runAllDddArchitecture;
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
    document.querySelectorAll("[data-planning-uc]").forEach((node) => {
      node.onclick = () => selectPlanningUseCase(node.dataset.planningUc);
    });
    const startPlanWriting = document.querySelector("#start-plan-writing");
    if (startPlanWriting) startPlanWriting.onclick = () => startPlanWritingRun();
    const resetPlanWriting = document.querySelector("#reset-plan-writing");
    if (resetPlanWriting) resetPlanWriting.onclick = () => startPlanWritingRun({ resetPlan: true });
    const refreshPlanning = document.querySelector("#refresh-planning");
    if (refreshPlanning) refreshPlanning.onclick = () => loadPlanningState({ renderAfter: true });
    const startImplementation = document.querySelector("#start-implementation");
    if (startImplementation) startImplementation.onclick = startImplementationRun;
    const implementationUc = document.querySelector("#implementation-uc");
    if (implementationUc) implementationUc.onchange = (event) => {
      selectImplementationWorkItem(event.target.value);
    };
    const refreshImplementation = document.querySelector("#refresh-implementation");
    if (refreshImplementation) refreshImplementation.onclick = () => loadImplementationState({ renderAfter: true });
    document.querySelectorAll("[data-plan-checklist]").forEach((node) => {
      node.ontoggle = () => { app.planChecklistCollapsed = !node.open; };
    });
    const refreshDelivery = document.querySelector("#refresh-delivery");
    if (refreshDelivery) refreshDelivery.onclick = () => loadDeliveryState({ renderAfter: true, preserveScroll: true });
    const startDelivery = document.querySelector("#start-delivery");
    if (startDelivery) startDelivery.onclick = startDeliveryRun;
    document.querySelectorAll("[data-diff-path]").forEach((node) => {
      node.onclick = () => selectImplementationDiff(node.dataset.diffPath);
    });
    document.querySelectorAll("[data-diff-view-mode]").forEach((node) => {
      node.onclick = () => {
        app.implementationDiffViewMode = node.dataset.diffViewMode;
        loadImplementationState({ renderAfter: true, preserveScroll: true });
      };
    });
    document.querySelectorAll("[data-diff-dir]").forEach((node) => {
      node.ontoggle = () => {
        app.implementationOpenDiffDirs[node.dataset.diffDir] = node.open;
      };
    });
    document.querySelectorAll("[data-plan-task-work-item]").forEach((node) => {
      node.onclick = (event) => {
        event.stopPropagation();
        selectImplementationTask(node.dataset.planTaskWorkItem, Number(node.dataset.planTaskLine || 0));
      };
    });
    document.querySelectorAll("[data-plan-work-item]").forEach((node) => {
      node.onclick = () => selectImplementationWorkItem(node.dataset.planWorkItem);
    });
    document.querySelectorAll("[data-clear-plan-task]").forEach((node) => {
      node.onclick = () => clearImplementationTaskFilter();
    });
    const diffSearch = document.querySelector("#diff-search");
    if (diffSearch) diffSearch.oninput = (event) => {
      const cursor = event.target.selectionStart || 0;
      app.implementationDiffSearch = event.target.value;
      renderPreservingScroll();
      const next = document.querySelector("#diff-search");
      if (next) {
        next.focus();
        next.setSelectionRange(cursor, cursor);
      }
    };
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

function renderProjectDocuments() {
  const project = app.state.project_documents || { lanes: [], document_count: 0 };
  const projectLane = project.lanes.find((lane) => lane.id === "project");
  const scopedLanes = project.lanes.filter((lane) => lane.id !== "project");
  const selectedLane = scopedLanes.find((lane) => lane.id === app.projectSelectedLane) || scopedLanes[0];
  app.projectSelectedLane = selectedLane?.id || null;
  const selector = scopedLanes.length ? `<div class="project-lane-picker">
    <label for="project-lane-select">Use case or maintenance slice</label>
    <select id="project-lane-select">
      ${scopedLanes.map((lane) => `<option value="${escapeHtml(lane.id)}" ${lane.id === selectedLane?.id ? "selected" : ""}>${escapeHtml(lane.id)} — ${escapeHtml(lane.label)}</option>`).join("")}
    </select>
  </div>` : "";
  const lanes = [projectLane, selectedLane].filter(Boolean).map(renderProjectDocumentLane).join("");
  return `<section class="workflow-page project-documents-page">
    <p class="eyebrow">Current repository outputs</p>
    <h2>Project Document Map</h2>
    <p class="lead">${escapeHtml(project.document_count)} current documents. Independent from ChangeSet lifecycle.</p>
    ${selector}
    <section class="panel project-doc-map">${lanes || '<p>No supported project documents found.</p>'}</section>
    <section class="panel project-doc-preview"><h3>Document Preview</h3><div id="editor"><p class="small">Select document card.</p></div></section>
  </section>`;
}

function renderAppRuntime() {
  const environments = app.appRuntime?.environments || [];
  const cards = environments.map(renderAppRuntimeEnvironment).join("");
  return `<section class="workflow-page app-runtime-page">
    <p class="eyebrow">Repository runtime</p>
    <h2>App Runtime</h2>
    <p class="lead">Runs the repository app launcher contract created during implementation: <code>scripts/run-app*.sh</code>.</p>
    ${app.error ? `<p class="error">${escapeHtml(app.error)}</p>` : ""}
    <div class="app-runtime-grid">${cards || '<section class="panel"><p>No runtime environments found.</p></section>'}</div>
  </section>`;
}

function renderAppRuntimeEnvironment(environment) {
  const configured = Boolean(environment.configured);
  const busy = app.appRuntimeBusy === environment.id;
  const scripts = (environment.contract?.scripts || []).map((script) => `
    <li class="${script.exists ? "done" : script.required ? "missing" : ""}">
      <code>${escapeHtml(script.path)}</code>
      <span>${script.exists ? "exists" : script.required ? "missing" : "optional missing"}</span>
    </li>`).join("");
  const logs = (environment.logs || []).map((log) => `
    <details class="runtime-log">
      <summary>${escapeHtml(log.component)} log <code>${escapeHtml(log.path)}</code></summary>
      ${log.exists && log.tail ? `<pre>${escapeHtml(log.tail)}</pre>` : '<p class="small">No log output yet.</p>'}
    </details>`).join("");
  const health = environment.health || {};
  const commands = Object.entries(environment.commands || {}).map(([name, command]) => `<li><strong>${escapeHtml(name)}</strong> <code>${escapeHtml(command)}</code></li>`).join("");
  return `<section class="panel app-runtime-card">
    <div class="runtime-card-heading">
      <div>
        <h3>${escapeHtml(environment.label || environment.id)}</h3>
        <p><span class="pill ${configured ? "ready_to_complete" : "stale"}">${configured ? "configured" : "not configured"}</span></p>
      </div>
      <button id="refresh-runtime-${escapeHtml(environment.id)}" type="button" ${busy ? "disabled" : ""}>Refresh</button>
    </div>
    <section>
      <h4>Contract</h4>
      <ul class="runtime-script-list">${scripts || '<li>No scripts declared.</li>'}</ul>
      ${(environment.contract?.missing_required || []).length ? `<p class="error">Missing required: ${escapeHtml(environment.contract.missing_required.join(", "))}</p>` : ""}
    </section>
    <section>
      <h4>Status</h4>
      <pre class="runtime-status">${escapeHtml(environment.status || "")}</pre>
    </section>
    <section>
      <h4>Health</h4>
      <p><span class="pill ${runtimeHealthClass(health.status)}">${escapeHtml(health.status || "unknown")}</span> <span class="small">${escapeHtml(health.checked_at || "")}</span></p>
      ${health.detail ? `<pre class="runtime-status">${escapeHtml(health.detail)}</pre>` : ""}
    </section>
    <div class="runtime-actions">
      <button class="primary" id="start-runtime-${escapeHtml(environment.id)}" type="button" ${!configured || busy ? "disabled" : ""}>${busy ? "Running..." : "Start"}</button>
      <button id="stop-runtime-${escapeHtml(environment.id)}" type="button" ${!configured || busy ? "disabled" : ""}>Stop</button>
      <button id="health-runtime-${escapeHtml(environment.id)}" type="button" ${!configured || busy ? "disabled" : ""}>Check Health</button>
    </div>
    ${commands ? `<section><h4>Commands</h4><ul>${commands}</ul></section>` : ""}
    <section><h4>Logs</h4>${logs || '<p class="small">No managed logs yet.</p>'}</section>
  </section>`;
}

function runtimeHealthClass(status) {
  if (status === "healthy") return "ready_to_complete";
  if (status === "unhealthy" || status === "timeout") return "stale";
  return "completed";
}

function bindAppRuntime() {
  (app.appRuntime?.environments || []).forEach((environment) => {
    const id = environment.id;
    const refresh = document.querySelector(`#refresh-runtime-${CSS.escape(id)}`);
    if (refresh) refresh.onclick = () => loadAppRuntime({ renderAfter: true });
    const start = document.querySelector(`#start-runtime-${CSS.escape(id)}`);
    if (start) start.onclick = () => runAppRuntimeAction(id, "start");
    const stop = document.querySelector(`#stop-runtime-${CSS.escape(id)}`);
    if (stop) stop.onclick = () => runAppRuntimeAction(id, "stop");
    const health = document.querySelector(`#health-runtime-${CSS.escape(id)}`);
    if (health) health.onclick = () => runAppRuntimeAction(id, "health");
  });
}

function renderProjectDocumentLane(lane) {
  return `<section class="project-doc-lane">
    <header><strong>${escapeHtml(lane.id)}</strong><span>${escapeHtml(lane.label)}</span></header>
    <div class="project-doc-flow">
      ${lane.documents.map((document, index) => `
        ${index ? '<span class="project-doc-arrow" aria-hidden="true">→</span>' : ""}
        <button class="project-doc-card kind-${escapeHtml(document.kind)}" data-project-document="${escapeHtml(document.id)}">
          <span class="project-doc-stage">${escapeHtml(document.stage_label)}</span>
          <strong>${escapeHtml(document.label)}</strong>
          <span class="small">${escapeHtml(document.path)}</span>
        </button>`).join("")}
    </div>
  </section>`;
}

function bindProjectDocuments() {
  const laneSelect = document.querySelector("#project-lane-select");
  if (laneSelect) laneSelect.onchange = () => {
    app.projectSelectedLane = laneSelect.value;
    app.openDocument = null;
    render();
  };
  document.querySelectorAll("[data-project-document]").forEach((node) => {
    node.onclick = async () => {
      await openDocument(node.dataset.projectDocument);
      document.querySelectorAll("[data-project-document]").forEach((card) => {
        card.classList.toggle("selected", card.dataset.projectDocument === node.dataset.projectDocument);
      });
    };
  });
  if (app.openDocument?.id?.startsWith("project-document:")) renderEditor();
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
  const body = app.stageTab === "delivery"
    ? renderDeliveryWorkspace()
    : app.stageTab === "dddArchitecture"
    ? renderDddArchitectureWorkspace()
    : app.stageTab === "implementation"
    ? renderImplementationWorkspace()
    : app.stageTab === "planning"
    ? renderPlanningWorkspace()
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
  const technicalDone = changeSetStageStatus("technical-decisions") === "verified";
  const planningAvailable = technicalAvailable && technicalDone;
  const planItems = planningUseCases();
  const implementationAvailable = Boolean(planItems.length) && planItems.every((item) => item.plan?.path);
  const selected = app.state.change_sets.find((item) => item.id === app.requirementsChangeSet);
  const deliveryStage = selected?.stages?.find((stage) => stage.id === "change-set-pr");
  const deliveryAvailable = implementationAvailable;
  const deliveryDone = deliveryStage?.status === "verified" || Boolean(selected?.pull_request?.url);
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
      <span class="progress-dot ${technicalDone ? "complete" : dddDone ? "active" : ""}"></span>Technical Decisions
    </button>
    <button class="stage-tab ${app.stageTab === "planning" ? "selected" : ""}" data-stage-tab="planning" ${!planningAvailable ? "disabled" : ""}>
      <span class="progress-dot ${implementationAvailable ? "complete" : planningAvailable ? "active" : ""}"></span>Plan Writing
    </button>
    <button class="stage-tab ${app.stageTab === "implementation" ? "selected" : ""}" data-stage-tab="implementation" ${!implementationAvailable ? "disabled" : ""}>
      <span class="progress-dot ${implementationAvailable ? "active" : ""}"></span>Implementation
    </button>
    <button class="stage-tab ${app.stageTab === "delivery" ? "selected" : ""}" data-stage-tab="delivery" ${!deliveryAvailable ? "disabled" : ""}>
      <span class="progress-dot ${deliveryDone ? "complete" : deliveryAvailable ? "active" : ""}"></span>PR Delivery
    </button>
  </nav>`;
}

function changeSetStageStatus(stageId) {
  const selected = app.state.change_sets.find((item) => item.id === app.requirementsChangeSet);
  return selected?.stages?.find((stage) => stage.id === stageId)?.status || "";
}

function renderBusyState() {
  return `<div class="runtime-progress" role="status">
    <span class="spinner" aria-hidden="true"></span>
    <div><strong>${escapeHtml(app.busyLabel)}</strong><p>Runtime is processing. Keep this page open.</p></div>
    ${renderWorkflowActivityPanel(app.workflowActivity)}
  </div>`;
}

function renderWorkflowActivityPanel(activity) {
  if (!activity) return "";
  return `<details class="implementation-job workflow-activity" open>
    <summary>Agent activity: running</summary>
    <p class="small">Elapsed ${escapeHtml(activity.elapsed_seconds || 0)}s. Shows provider summaries and tool activity, not private chain-of-thought.</p>
    ${(activity.activity || []).length ? `<pre>${escapeHtml(activity.activity.join("\n"))}</pre>` : '<p class="small">Waiting for first agent event...</p>'}
  </details>`;
}

function startWorkflowActivity(label) {
  if (!app.requirementsChangeSet) {
    app.workflowActivity = null;
    return;
  }
  app.workflowActivity = {
    label,
    startedAtEpoch: Math.floor(Date.now() / 1000),
    elapsed_seconds: 0,
    activity: [],
  };
  scheduleWorkflowActivityPoll();
  scheduleDddPoll();
}

function stopWorkflowActivity() {
  if (app.workflowActivityPollTimer) {
    clearTimeout(app.workflowActivityPollTimer);
    app.workflowActivityPollTimer = null;
  }
  app.workflowActivity = null;
}

function setBusy(label) {
  app.busy = true;
  app.busyLabel = label;
  startWorkflowActivity(label);
}

function clearBusy() {
  app.busy = false;
  app.busyLabel = "";
  stopWorkflowActivity();
}

function scheduleWorkflowActivityPoll() {
  if (app.workflowActivityPollTimer) {
    clearTimeout(app.workflowActivityPollTimer);
    app.workflowActivityPollTimer = null;
  }
  if (!app.busy || !app.requirementsChangeSet || !app.workflowActivity) return;
  app.workflowActivityPollTimer = setTimeout(async () => {
    const since = app.workflowActivity?.startedAtEpoch || 0;
    const response = await fetch(`/api/dashboard/change-sets/${encodeURIComponent(app.requirementsChangeSet)}/activity?since=${encodeURIComponent(since)}`);
    if (response.ok) {
      const result = await response.json();
      app.workflowActivity = { ...(app.workflowActivity || {}), ...result, startedAtEpoch: since };
      if (app.busy) renderPreservingScroll();
    }
    scheduleWorkflowActivityPoll();
  }, 1000);
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
    <section class="panel"><h3>Requirements</h3><div id="editor"></div></section>
    ${renderGrillPanel(app.harvest?.requirements_gate_passed ? "Rerun Requirements" : "Grill-Me Questions", questionPanel)}
  `;
}

function renderUbiquitousLanguageWorkspace() {
  const document = app.harvest?.context_markdown
    ? `<div class="markdown-preview">${markdownPreview(app.harvest.context_markdown)}</div>`
    : '<p class="small">docs/design/ubiquitous-language.md unavailable.</p>';
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
    <section class="panel"><h3>Ubiquitous Language</h3>${document}</section>
    ${renderGrillPanel(app.harvest?.language_gate_passed ? "Rerun Ubiquitous Language" : "Language Gate", action)}
  `;
}

function renderUseCaseWorkspace() {
  const question = app.harvest?.current_question;
  const useCaseStartLabel = useCaseBlockedByLanguage() ? "Continue Ubiquitous Language" : (app.error ? "Retry Use Case Definition" : "Start Use Case Definition");
  const useCaseStartId = useCaseBlockedByLanguage() ? "start-ubiquitous-language" : "start-use-cases";
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
         <button class="primary next-stage" id="${useCaseStartId}" type="button" ${app.busy ? "disabled" : ""}>${useCaseStartLabel}</button>`;
  const document = app.harvest?.use_cases_markdown
    ? `<div class="markdown-preview">${markdownPreview(app.harvest.use_cases_markdown)}</div>`
    : '<p class="small">Generated use-case document appears here when runtime completes.</p>';
  return `
    <section class="panel"><h3>Use Case Document</h3>${document}</section>
    ${renderGrillPanel(app.harvest?.use_cases_ready ? "Rerun Use Case Definition" : "Use Case Questions", questionPanel)}
  `;
}

function useCaseBlockedByLanguage() {
  const text = `${app.error || ""} ${app.harvest?.runtime_error || ""}`.toLowerCase();
  return text.includes("ubiquitous language")
    || text.includes("ubiquitous-language")
    || text.includes("context.md")
    || text.includes("docs/design/ubiquitous-language.md");
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
  const dddRunning = state.status === "running";
  const currentId = app.dddSelectedUc || state.current_uc || state.uc_ids.find((id) => state.items[id]?.status === "complete");
  const item = currentId ? state.items[currentId] : null;
  const steps = state.step_order || [];
  const ucProgress = state.uc_ids.map((id) => `<button type="button" data-ddd-uc="${escapeHtml(id)}" class="event-progress-item ${escapeHtml(state.items[id]?.status || "pending")}">${escapeHtml(id)}: ${escapeHtml(state.items[id]?.status || "pending")}</button>`).join("");
  const stepTabs = steps.map((step) => {
    const status = item?.steps?.[step.id]?.status || "pending";
    const unlocked = status === "complete" || step.id === state.current_step || step.id === app.dddSelectedStep;
    return `<button type="button" data-ddd-step="${escapeHtml(step.id)}" class="ddd-step ${escapeHtml(status)} ${app.dddSelectedStep === step.id ? "selected" : ""}" ${!unlocked ? "disabled" : ""}>${escapeHtml(step.label)}</button>`;
  }).join("");
  const hasCompletedDddStep = steps.some((step) => item?.steps?.[step.id]?.status === "complete");
  const showRerunControls = currentId
    && steps.length
    && hasCompletedDddStep
    && !dddRunning
    && state.status !== "not_started"
    && !(item?.steps?.[state.current_step]?.status === "needs_input");
  const rerunPrompt = state.complete
    ? ""
    : `<label for="ddd-rerun-prompt">Additional rerun prompt</label>
        <textarea id="ddd-rerun-prompt" placeholder="Add correction or emphasis for the selected rerun..." ${app.busy ? "disabled" : ""}></textarea>`;
  const rerunControls = showRerunControls
    ? `<div class="ddd-rerun-controls">
        ${rerunPrompt}
        <div class="ddd-rerun-buttons">${steps.map((step) => {
          const status = item?.steps?.[step.id]?.status || "pending";
          const enabled = status !== "pending" && !app.busy && !dddRunning;
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
      <button class="primary" type="submit" ${app.busy || dddRunning ? "disabled" : ""}>Submit answer</button>
    </form>`;
  } else if (state.complete) {
    const runAllAgain = `<button class="secondary" id="run-all-ddd-architecture" type="button" ${app.busy || dddRunning ? "disabled" : ""}>Run All DDD Substeps</button>`;
    const nextAction = technicalDecisionUseCases().length
      ? '<button class="primary next-stage" type="button" data-stage-tab="technicalDecisions">Open Technical Decisions</button>'
      : '<button class="primary next-stage" type="button" disabled>Technical Decisions document not available</button>';
    interaction = renderWorkflowRerunPanel(
      "ddd-architecture-definition",
      `${currentId} DDD Architecture`,
      currentId,
      `${runAllAgain}${nextAction}`,
    );
  } else if (state.status === "not_started") {
    interaction = `<button class="primary next-stage" id="start-ddd-architecture" type="button" ${app.busy || dddRunning ? "disabled" : ""}>Start DDD Architecture</button>
      <button class="secondary" id="run-all-ddd-architecture" type="button" ${app.busy || dddRunning ? "disabled" : ""}>Run All DDD Substeps</button>`;
  } else if (state.status === "error") {
    interaction = `<p class="error">${escapeHtml(currentStep?.error || app.harvest?.runtime_error || "DDD architecture failed.")}</p><button class="primary next-stage" id="advance-ddd-architecture" type="button">Retry DDD Substep</button>
      <button class="secondary" id="run-all-ddd-architecture" type="button" ${app.busy || dddRunning ? "disabled" : ""}>Run All DDD Substeps</button>`;
  } else if (dddRunning) {
    interaction = `<p class="small">Running all remaining DDD substeps with one agent. Current target: ${escapeHtml(state.current_uc || "-")} / ${escapeHtml(state.current_step || "-")}.</p>
      <button class="secondary" id="run-all-ddd-architecture" type="button" disabled>Run All DDD Substeps</button>`;
  } else {
    interaction = `<p class="small">Review completed visualization, then continue explicitly.</p><button class="primary next-stage" id="advance-ddd-architecture" type="button" ${app.busy ? "disabled" : ""}>Continue DDD Architecture</button>
      <button class="secondary" id="run-all-ddd-architecture" type="button" ${app.busy || dddRunning ? "disabled" : ""}>Run All DDD Substeps</button>`;
  }
  const restartAction = state.status === "not_started"
    ? ""
    : `<button class="secondary" id="restart-ddd-architecture" type="button" ${app.busy || dddRunning ? "disabled" : ""}>Restart DDD Architecture</button>`;
  const runningSummary = dddRunning
    ? `<p class="small">Running: ${escapeHtml(state.current_uc || "-")} / ${escapeHtml(state.current_step || "-")}. Completed count updates when the single run-all agent returns a checkpoint or final result.</p>${renderWorkflowActivityPanel(app.workflowActivity)}`
    : "";
  return `<section class="panel"><h3>DDD Architecture Progress</h3><p class="small">Completed ${escapeHtml(state.completed_count || 0)} / ${escapeHtml(state.total_count || 0)} substeps</p>${runningSummary}${restartAction}<div class="event-progress">${ucProgress}</div><nav class="ddd-steps">${stepTabs}</nav></section>
    <section class="panel"><h3>${escapeHtml(currentId || "DDD")} Design Document</h3><div id="ddd-document-editor"></div></section>
    <section class="panel ddd-live-preview"><h3>Design Visualization</h3><div id="ddd-live-board"></div></section>
    ${renderGrillPanel(state.complete ? "Rerun DDD Architecture" : "DDD Architect Questions", `${rerunControls}${interaction}`)}`;
}

function technicalDecisionUseCases() {
  const change = app.state.change_sets.find((item) => item.id === app.requirementsChangeSet);
  const byId = new Map();
  for (const item of change?.work_items || []) {
    if (!item.id?.startsWith("UC-")) continue;
    byId.set(item.id, {
      id: item.id,
      documentId: `technical-decisions:${app.requirementsChangeSet}:${item.id}`,
      label: `${item.id} Technical Decisions`,
      name: item.name || "",
    });
  }
  const documents = (change?.documents || [])
    .filter((document) => document.kind === "technical-decisions")
    .map((document) => ({
      id: document.id.split(":").at(-1),
      documentId: document.id,
      label: document.label,
    }));
  for (const document of documents) byId.set(document.id, { ...(byId.get(document.id) || {}), ...document });
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
  const technicalDone = changeSetStageStatus("technical-decisions") === "verified";
  const rerun = currentId
    ? renderWorkflowRerunPanel(
        "technical-decisions",
        `${currentId} Technical Decisions`,
        currentId,
        `<button class="primary next-stage" type="button" data-stage-tab="planning" ${technicalDone ? "" : "disabled"}>Open Plan Writing</button>`,
      )
    : '<p class="small">No completed Technical Decisions document.</p>';
  return `<section class="panel"><h3>Technical Decisions</h3><div class="event-progress">${tabs}</div>
      <button class="primary" id="run-all-technical-decisions" type="button" ${app.busy ? "disabled" : ""}>Run All Technical Decisions</button>
    </section>
    <section class="panel"><h3>${escapeHtml(currentId || "Technical Decisions")} Document</h3><div id="editor"></div></section>
    ${renderGrillPanel("Rerun Technical Decisions", rerun)}`;
}

function planningUseCases() {
  const change = app.state.change_sets.find((item) => item.id === app.requirementsChangeSet);
  const planByWorkItem = new Map((app.planning?.plans || []).map((plan) => [plan.work_item_id, plan]));
  return (change?.work_items || [])
    .filter((item) => item.id.startsWith("UC-"))
    .map((item) => ({ id: item.id, name: item.name, plan: planByWorkItem.get(item.id) || item.plan || {} }));
}

function renderPlanningWorkspace() {
  const useCases = planningUseCases();
  const currentId = app.planningSelectedUc || useCases[0]?.id || "";
  const current = useCases.find((item) => item.id === currentId);
  const job = app.planning?.job;
  const running = job?.status === "running";
  const tabs = useCases.map((item) => `<button type="button" data-planning-uc="${escapeHtml(item.id)}" class="event-progress-item ${item.id === currentId ? "complete" : ""}">${escapeHtml(item.id)}</button>`).join("");
  const jobOutput = job
    ? `<details class="implementation-job" ${job.status !== "running" ? "open" : ""}><summary>Plan-writing job: ${escapeHtml(job.status)}</summary>
        <p class="small">Use case ${escapeHtml(job.uc_id || "")}; started ${escapeHtml(job.started_at || "")}${job.finished_at ? `, finished ${escapeHtml(job.finished_at)}` : ""}</p>
        ${job.reset_plan ? `<p class="small">Reset active plan: <code>${escapeHtml(job.reset_plan_path || "")}</code></p>` : ""}
        ${job.output ? `<pre>${escapeHtml(job.output)}</pre>` : ""}
        ${job.error ? `<pre class="error">${escapeHtml(job.error)}</pre>` : ""}
      </details>`
    : "";
  const plan = (app.planning?.plans || []).find((item) => item.work_item_id === currentId) || current?.plan;
  return `<section class="panel implementation-actions">
      <h3>Plan Writing</h3>
      <div class="event-progress">${tabs}</div>
      <p class="small">Runs <code>harness plan-writing ${escapeHtml(app.requirementsChangeSet)} --uc ${escapeHtml(currentId)}</code>.</p>
      <button class="primary" id="start-plan-writing" type="button" ${running || !currentId ? "disabled" : ""}>${running ? "Plan writing running" : plan?.path ? "Update Plan" : "Write Plan"}</button>
      <button id="reset-plan-writing" type="button" ${running || !currentId || !plan?.path ? "disabled" : ""}>초기화 후 작성</button>
      <button id="refresh-planning" type="button">Refresh plan</button>
      ${jobOutput}
    </section>
    ${renderPlanChecklistPanel(plan?.path ? renderImplementationPlan(plan) : '<p class="small">No plan written for this use case.</p>')}
    ${plan?.path ? '<button class="primary next-stage" type="button" data-stage-tab="implementation">Open Implementation</button>' : ""}`;
}

function renderImplementationLoop(loop) {
  const phases = loop?.phases || [];
  if (!phases.length) return "";
  const percent = Math.max(0, Math.min(100, Number(loop.percent || 0)));
  const attempt = loop.attempt?.number ? ` · 시도 ${escapeHtml(loop.attempt.number)}회${loop.attempt.execution_mode ? ` (${escapeHtml(loop.attempt.execution_mode)})` : ""}` : "";
  const status = loop.status && loop.status !== "idle" ? ` · ${escapeHtml(loop.status)}` : "";
  const checkpoint = loop.checkpoint_path ? `<p class="small">checkpoint: <code>${escapeHtml(loop.checkpoint_path)}</code></p>` : "";
  return `<div class="implementation-loop" aria-label="Implementation loop progress">
    <div class="implementation-loop-heading">
      <strong>현재 loop step: ${escapeHtml(loop.current_label || loop.current_phase || "대기")}</strong>
      <span>${escapeHtml(percent)}%${status}${attempt}</span>
    </div>
    <div class="implementation-loop-meter" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${escapeHtml(percent)}">
      <span style="width: ${percent}%"></span>
    </div>
    <ol class="implementation-loop-steps">
      ${phases.map((phase) => `<li class="${escapeHtml(phase.status || "pending")}">
        <span class="implementation-loop-dot" aria-hidden="true"></span>
        <span>${escapeHtml(phase.label || phase.id)}</span>
        ${phase.command_count ? `<small>${escapeHtml(phase.command_count)} cmds</small>` : ""}
      </li>`).join("")}
    </ol>
    ${checkpoint}
  </div>`;
}

function renderImplementationWorkspace() {
  const state = app.implementation;
  const job = state?.job;
  const running = job?.status === "running";
  const planItems = state?.plans || [];
  const plans = planItems.map(renderImplementationPlan).join("");
  const selectedUc = app.implementationSelectedUc || planItems[0]?.work_item_id || "";
  const files = state?.diff?.files || [];
  const sourceFiles = sourceVisibleDiffFiles(files);
  const activeFiles = app.implementationDiffViewMode === "source" ? sourceFiles : files;
  const workItemFiles = workItemDiffFiles(state?.diff, selectedUc, activeFiles);
  const activeWorkItemFiles = selectedUc ? workItemFiles.files : activeFiles;
  const selectedTask = selectedImplementationTask(planItems);
  const taskFiles = selectedTask ? taskDiffFiles(state?.diff, selectedTask, activeWorkItemFiles) : [];
  const visibleDiffFiles = selectedTask ? taskFiles : activeWorkItemFiles;
  const selectedPath = visibleDiffFiles.some((file) => file.path === app.implementationSelectedDiffPath)
    ? app.implementationSelectedDiffPath
    : visibleDiffFiles[0]?.path || "";
  const selectedSource = state?.selectedSource?.path === selectedPath ? state.selectedSource : null;
  const selectedDiff = state?.selectedDiff?.path === selectedPath ? state.selectedDiff : null;
  const diffTree = renderDiffTree(visibleDiffFiles, selectedPath, app.implementationDiffSearch, selectedTask);
  const sourceBody = selectedSource
    ? renderSourceViewer(selectedSource)
    : visibleDiffFiles.length ? '<p class="small">Select a changed file to inspect source.</p>' : selectedTask ? '<p class="small">No files matched this plan item.</p>' : '<p class="small">No current source files changed.</p>';
  const diffBody = app.implementationDiffViewMode === "source"
    ? sourceBody
    : selectedDiff?.patch
      ? renderDiffEditor(selectedDiff.patch)
      : visibleDiffFiles.length ? '<p class="small">Select a changed file to inspect its diff.</p>' : selectedTask ? '<p class="small">No files matched this plan item.</p>' : '<p class="small">No working tree diff yet.</p>';
  const ucOptions = planItems.map((plan) => `<option value="${escapeHtml(plan.work_item_id)}" ${plan.work_item_id === selectedUc ? "selected" : ""}>${escapeHtml(plan.work_item_id)}: ${escapeHtml(plan.name || "")}</option>`).join("");
  const workItemSummary = selectedUc
    ? `<p class="small">Work item ${escapeHtml(selectedUc)} changed files: ${escapeHtml(activeWorkItemFiles.length)}</p>`
    : "";
  const taskSummary = selectedTask
    ? `<div class="diff-task-summary">
        <strong>Selected checkbox</strong>
        <p>${escapeHtml(selectedTask.work_item_id)} L${escapeHtml(selectedTask.line)} · ${escapeHtml(selectedTask.text)}</p>
        <p class="small">Matched files: ${escapeHtml(taskFiles.length)}</p>
        <button type="button" data-clear-plan-task>Show all changed files</button>
        ${taskFiles.length ? `<div class="diff-task-files">${taskFiles.map((file) => `<button type="button" data-diff-path="${escapeHtml(file.path)}" title="${escapeHtml(file.path)}">${escapeHtml(file.path)}</button>`).join("")}</div>` : '<p class="small">No path match. Use file tree manually.</p>'}
      </div>`
    : '<p class="small">Click a plan checkbox to show only related files.</p>';
  const jobOpen = job && !app.implementationJobCollapsed;
  const jobOutput = job
    ? `<details class="implementation-job" data-implementation-job ${jobOpen ? "open" : ""}><summary>Implementation job: ${escapeHtml(job.status)}</summary>
        <p class="small">Work item ${escapeHtml(job.uc_id || "all")}; started ${escapeHtml(job.started_at || "")}${job.finished_at ? `, finished ${escapeHtml(job.finished_at)}` : ""}</p>
        ${job.output ? `<pre class="implementation-job-output">${escapeHtml(job.output)}</pre>` : '<p class="small">Waiting for first CLI output...</p>'}
        ${(job.activity || []).length ? `<h4>Subagent activity</h4><pre class="implementation-job-output">${escapeHtml(job.activity.join("\n"))}</pre>` : ""}
        ${job.error ? `<pre class="error implementation-job-output">${escapeHtml(job.error)}</pre>` : ""}
      </details>`
    : "";
  return `<section class="panel implementation-actions">
      <h3>Implementation</h3>
      ${renderImplementationLoop(state?.loop)}
      <p class="small">Runs <code>harness implementation ${escapeHtml(app.requirementsChangeSet)} --uc ${escapeHtml(selectedUc || "<work-item>")} --apply</code>.</p>
      <label for="implementation-uc">Work item</label>
      <select id="implementation-uc" ${running ? "disabled" : ""}>${ucOptions}</select>
      <button class="primary" id="start-implementation" type="button" ${running ? "disabled" : ""}>${running ? "Implementation running" : "Start Implementation"}</button>
      <button id="refresh-implementation" type="button">Refresh progress</button>
      ${jobOutput}
    </section>
    <section class="implementation-grid">
      ${renderPlanChecklistPanel(plans || '<p class="small">No active or completed plan found.</p>')}
      <div class="panel diff-explorer"><h3>Diff Explorer</h3>
        ${workItemSummary}
        ${taskSummary}
        <div class="diff-toolbar"><input id="diff-search" type="search" placeholder="Search source files" value="${escapeHtml(app.implementationDiffSearch)}"></div>
        <div class="diff-tabs">
          <button type="button" data-diff-view-mode="diff" class="${app.implementationDiffViewMode === "diff" ? "selected" : ""}">Diff</button>
          <button type="button" data-diff-view-mode="source" class="${app.implementationDiffViewMode === "source" ? "selected" : ""}">Source</button>
        </div>
        <div class="diff-layout"><nav class="diff-files">${diffTree}</nav><div class="diff-view">${diffBody}</div></div>
      </div>
    </section>`;
}

function renderPlanChecklistPanel(content) {
  return `<details class="panel plan-checklist-panel" data-plan-checklist ${app.planChecklistCollapsed ? "" : "open"}>
    <summary><h3>Plan Checklist</h3></summary>
    ${content}
  </details>`;
}

function renderDiffTree(files, selectedPath, query, selectedTask = null) {
  const normalizedQuery = String(query || "").trim().toLowerCase();
  const visibleFiles = normalizedQuery
    ? files.filter((file) => file.path.toLowerCase().includes(normalizedQuery))
    : files;
  if (!files.length) return '<p class="small">No source code diff yet.</p>';
  if (!visibleFiles.length) return '<p class="small">No matching source files.</p>';
  const root = { dirs: new Map(), files: [], statuses: new Set() };
  for (const file of visibleFiles) {
    const parts = file.path.split("/").filter(Boolean);
    let node = root;
    node.statuses.add(file.status);
    for (const part of parts.slice(0, -1)) {
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [], statuses: new Set() });
      node = node.dirs.get(part);
      node.statuses.add(file.status);
    }
    node.files.push({ ...file, name: parts.at(-1) || file.path, taskMatched: selectedTask ? taskMatchesFile(selectedTask, file) : false });
  }
  return `<div class="diff-tree">${renderDiffTreeNode(root, selectedPath, 0, normalizedQuery, "")}</div>`;
}

function sourceVisibleDiffFiles(files) {
  return (files || []).filter((file) => String(file.status || "").trim() !== "D");
}

function renderDiffTreeNode(node, selectedPath, depth, query, parentPath) {
  const directories = [...node.dirs.entries()].sort(([a], [b]) => a.localeCompare(b));
  const files = [...node.files].sort((a, b) => a.name.localeCompare(b.name));
  return [
    ...directories.map(([name, child]) => {
      const dirPath = parentPath ? `${parentPath}/${name}` : name;
      const open = app.implementationOpenDiffDirs[dirPath] !== false;
      return `<details class="diff-dir" data-diff-dir="${escapeHtml(dirPath)}" ${open ? "open" : ""}>
      <summary style="--depth:${depth}">
        <span class="diff-node-icon diff-node-folder" aria-hidden="true"></span>
        <span class="diff-status ${diffStatusClass(diffNodeStatus(child))}">${escapeHtml(diffNodeStatus(child))}</span>
        <span class="diff-node-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
      </summary>
      ${renderDiffTreeNode(child, selectedPath, depth + 1, query, dirPath)}
    </details>`;
    }),
    ...files.map((file) => `<button type="button" data-diff-path="${escapeHtml(file.path)}" class="diff-file ${file.path === selectedPath ? "selected" : ""} ${file.taskMatched ? "task-match" : ""}" style="--depth:${depth}" title="${escapeHtml(file.path)}">
      <span class="diff-node-icon diff-node-file" aria-hidden="true"></span>
      <span class="diff-status ${diffStatusClass(file.status)}">${escapeHtml(file.status)}</span>
      <span class="diff-file-name" title="${escapeHtml(file.path)}">${highlightDiffMatch(file.name, query)}</span>
    </button>`),
  ].join("");
}

function diffNodeStatus(node) {
  const statuses = [...node.statuses].filter(Boolean);
  return statuses.length === 1 ? statuses[0] : "*";
}

function diffStatusClass(status) {
  const normalized = String(status || "").trim();
  if (normalized === "A" || normalized === "??") return "added";
  if (normalized === "D") return "deleted";
  if (normalized === "R") return "renamed";
  if (normalized === "*") return "mixed";
  return "modified";
}

function highlightDiffMatch(value, query) {
  const text = String(value || "");
  if (!query) return escapeHtml(text);
  const lower = text.toLowerCase();
  const index = lower.indexOf(query);
  if (index < 0) return escapeHtml(text);
  return `${escapeHtml(text.slice(0, index))}<mark>${escapeHtml(text.slice(index, index + query.length))}</mark>${escapeHtml(text.slice(index + query.length))}`;
}

function selectedImplementationTask(plans) {
  const selected = app.implementationSelectedTask;
  if (!selected) return null;
  const plan = (plans || []).find((candidate) => candidate.work_item_id === selected.workItemId);
  const task = plan?.tasks?.find((candidate) => Number(candidate.line) === Number(selected.line));
  return task ? { ...task, work_item_id: plan.work_item_id } : null;
}

function selectImplementationWorkItem(workItemId) {
  app.implementationSelectedUc = workItemId || "";
  app.implementationSelectedTask = null;
  const files = implementationVisibleFilesForCurrentSelection();
  app.implementationSelectedDiffPath = files[0]?.path || "";
  if (app.implementationSelectedDiffPath) {
    loadImplementationDiff(app.implementationSelectedDiffPath).then(() => renderPreservingScroll());
  } else {
    app.implementation = { ...(app.implementation || {}), selectedDiff: null, selectedSource: null };
    renderPreservingScroll();
  }
}

function selectImplementationTask(workItemId, line) {
  const plans = app.implementation?.plans || [];
  const task = plans.find((plan) => plan.work_item_id === workItemId)?.tasks?.find((item) => Number(item.line) === Number(line));
  if (!task) return;
  app.implementationSelectedUc = workItemId || app.implementationSelectedUc;
  app.implementationSelectedTask = { workItemId, line };
  const taskFiles = implementationVisibleFilesForCurrentSelection({ task: { ...task, work_item_id: workItemId } });
  app.implementationSelectedDiffPath = taskFiles[0]?.path || "";
  if (app.implementationSelectedDiffPath) {
    loadImplementationDiff(app.implementationSelectedDiffPath).then(() => renderPreservingScroll());
  } else {
    app.implementation = { ...(app.implementation || {}), selectedDiff: null, selectedSource: null };
    renderPreservingScroll();
  }
}

function clearImplementationTaskFilter() {
  app.implementationSelectedTask = null;
  const files = implementationVisibleFilesForCurrentSelection();
  app.implementationSelectedDiffPath = files[0]?.path || "";
  if (app.implementationSelectedDiffPath) {
    loadImplementationDiff(app.implementationSelectedDiffPath).then(() => renderPreservingScroll());
  } else {
    app.implementation = { ...(app.implementation || {}), selectedDiff: null, selectedSource: null };
    renderPreservingScroll();
  }
}

function implementationVisibleFilesForCurrentSelection({ task = null } = {}) {
  const diff = app.implementation?.diff || {};
  const files = diff.files || [];
  const activeFiles = app.implementationDiffViewMode === "source" ? sourceVisibleDiffFiles(files) : files;
  const workItemFiles = workItemDiffFiles(diff, app.implementationSelectedUc, activeFiles);
  const scopedFiles = app.implementationSelectedUc ? workItemFiles.files : activeFiles;
  const selectedTask = task || selectedImplementationTask(app.implementation?.plans || []);
  return selectedTask ? taskDiffFiles(diff, selectedTask, scopedFiles) : scopedFiles;
}

function workItemDiffFiles(diff, workItemId, files) {
  if (!workItemId) return { matched: false, files: [] };
  const entry = (diff?.work_item_file_map || []).find((item) =>
    String(item.work_item_id || "") === String(workItemId)
  );
  if (entry) {
    const byPath = new Map((files || []).map((file) => [file.path, file]));
    const mappedFiles = (entry.files || [])
      .map((file) => byPath.get(file.path) || file)
      .filter((file) => file?.path);
    return { matched: true, files: mappedFiles };
  }
  const filtered = (files || []).filter((file) =>
    String(file.work_item_id || "") === String(workItemId) ||
    (file.work_item_ids || []).some((candidate) => String(candidate) === String(workItemId))
  );
  return { matched: filtered.length > 0, files: filtered };
}

function taskDiffFiles(diff, task, files) {
  const mapped = taskMappedFiles(diff?.task_file_map || [], task, files);
  if (mapped.matched) return mapped.files;
  return (files || []).filter((file) => taskMatchesFile(task, file));
}

function taskMappedFiles(taskFileMap, task, files) {
  const entry = (taskFileMap || []).find((item) =>
    String(item.work_item_id || "") === String(task?.work_item_id || "") &&
    Number(item.line) === Number(task?.line)
  );
  if (!entry) return { matched: false, files: [] };
  const byPath = new Map((files || []).map((file) => [file.path, file]));
  const mappedFiles = (entry.files || [])
    .map((file) => byPath.get(file.path) || file)
    .filter((file) => file?.path);
  return { matched: true, files: mappedFiles };
}

function taskMatchesFile(task, file) {
  const path = String(file?.path || "").toLowerCase();
  const name = path.split("/").at(-1) || path;
  const tokens = checkboxFileTokens(task?.text || "");
  return tokens.some((token) => path.includes(token) || name.includes(token));
}

function checkboxFileTokens(text) {
  const raw = String(text || "");
  const tokens = new Set();
  for (const match of raw.matchAll(/`([^`]+)`/g)) {
    for (const part of match[1].split(/[^A-Za-z0-9_.$/-]+/)) addCheckboxToken(tokens, part);
  }
  for (const match of raw.matchAll(/\b[A-Z][A-Za-z0-9]*(?:[A-Z][A-Za-z0-9]*)+\b/g)) {
    addCheckboxToken(tokens, match[0]);
  }
  for (const match of raw.matchAll(/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+/g)) {
    addCheckboxToken(tokens, match[0]);
  }
  return [...tokens];
}

function addCheckboxToken(tokens, value) {
  const token = String(value || "").trim().toLowerCase();
  if (token.length < 4) return;
  if (/^(http|https|api|user|true|false|null|count|list|page|size|sort)$/.test(token)) return;
  tokens.add(token);
  if (token.includes(".")) tokens.add(token.split(".")[0]);
}

function renderDeliveryWorkspace() {
  const selected = app.state.change_sets.find((item) => item.id === app.requirementsChangeSet);
  const stage = app.delivery?.stage || selected?.stages?.find((item) => item.id === "change-set-pr");
  const pr = app.delivery?.pull_request || selected?.pull_request;
  const job = app.delivery?.job;
  const running = job?.status === "running";
  const stageStatus = stage?.status || "pending";
  const notes = stage?.notes || "";
  const reportPath = pr?.path || ".harness/runs/<RUN-ID>/pull-request.json";
  const prLink = pr?.url
    ? `<p><a href="${escapeHtml(pr.url)}" target="_blank" rel="noreferrer">${escapeHtml(pr.url)}</a></p>`
    : '<p class="small">No PR URL recorded yet. Runtime records it after PR delivery succeeds.</p>';
  const error = pr?.error ? `<pre class="error">${escapeHtml(pr.error)}</pre>` : "";
  const jobPanel = job ? `<div class="agent-run">
      <p class="small">Status ${escapeHtml(job.status || "")}; started ${escapeHtml(job.started_at || "")}${job.finished_at ? `; finished ${escapeHtml(job.finished_at)}` : ""}</p>
      ${job.output ? `<pre>${escapeHtml(job.output)}</pre>` : ""}
      ${job.error ? `<pre class="error">${escapeHtml(job.error)}</pre>` : ""}
    </div>` : "";
  return `<section class="panel implementation-actions">
      <h3>PR Delivery</h3>
      <p class="small">Final runtime step: <code>harness-change-set-pr</code>. It commits completed ChangeSet output, pushes the target repository branch, and records the PR URL.</p>
      <button class="primary" id="start-delivery" type="button" ${running ? "disabled" : ""}>${running ? "PR Delivery running" : "Run PR Delivery"}</button>
      <button id="refresh-delivery" type="button">Refresh delivery state</button>
      ${jobPanel}
    </section>
    <section class="panel">
      <h3>ChangeSet PR Step</h3>
      <p><span class="pill ${escapeHtml(stageStatus)}">${escapeHtml(stageStatus)}</span></p>
      ${notes ? `<p class="small">${escapeHtml(notes)}</p>` : ""}
      <p class="small">Report: <code>${escapeHtml(reportPath)}</code></p>
      ${prLink}
      ${pr?.already_exists ? '<p class="small">Existing PR reused.</p>' : ""}
      ${error}
    </section>`;
}

function renderDiffEditor(patch) {
  const rows = parseUnifiedDiff(patch);
  if (!rows.length) return '<p class="small">No textual diff for this file.</p>';
  return `<div class="diff-editor" role="table" aria-label="File diff">
    ${rows.map((row) => {
      if (row.kind === "hunk") {
        return `<div class="diff-row hunk" role="row">
          <div class="diff-line-no"></div><div class="diff-line-no"></div><div class="diff-marker"></div><pre>${escapeHtml(row.text)}</pre>
        </div>`;
      }
      return `<div class="diff-row ${escapeHtml(row.kind)}" role="row">
        <div class="diff-line-no">${escapeHtml(row.oldLine || "")}</div>
        <div class="diff-line-no">${escapeHtml(row.newLine || "")}</div>
        <div class="diff-marker">${escapeHtml(row.marker)}</div>
        <pre>${escapeHtml(row.text)}</pre>
      </div>`;
    }).join("")}
  </div>`;
}

function renderSourceViewer(source) {
  if (source.binary) return '<p class="small">Binary source file cannot be previewed.</p>';
  if (!source.exists) return '<p class="small">Source file no longer exists in the working tree.</p>';
  const lines = String(source.content || "").split(/\r?\n/);
  return `<div class="source-viewer" role="table" aria-label="Source file">
    ${lines.map((line, index) => `<div class="source-row" role="row">
      <div class="source-line-no">${escapeHtml(index + 1)}</div><pre>${escapeHtml(line)}</pre>
    </div>`).join("")}
  </div>`;
}

function parseUnifiedDiff(patch) {
  const rows = [];
  let oldLine = 0;
  let newLine = 0;
  for (const line of String(patch || "").split(/\r?\n/)) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      rows.push({ kind: "hunk", text: line });
      continue;
    }
    if (!rows.length || /^diff --git |^index |^--- |^\+\+\+ /.test(line)) continue;
    if (line.startsWith("-")) {
      rows.push({ kind: "deleted", oldLine: oldLine++, newLine: "", marker: "-", text: line.slice(1) });
    } else if (line.startsWith("+")) {
      rows.push({ kind: "added", oldLine: "", newLine: newLine++, marker: "+", text: line.slice(1) });
    } else if (line.startsWith(" ")) {
      rows.push({ kind: "context", oldLine: oldLine++, newLine: newLine++, marker: "", text: line.slice(1) });
    } else if (line.startsWith("\\ No newline")) {
      rows.push({ kind: "meta", oldLine: "", newLine: "", marker: "", text: line });
    }
  }
  return rows;
}

function renderImplementationPlan(plan) {
  const selected = app.implementationSelectedUc === plan.work_item_id;
  const lifecycle = plan.lifecycle || "missing";
  const lifecycleLabel = lifecycle.replace(/_/g, " ");
  const blocker = plan.completion_blocker && !plan.completion_ready
    ? `<p class="small warning-text">${escapeHtml(plan.completion_blocker)}</p>`
    : "";
  const tasks = (plan.tasks || []).map((task) => `<li class="${task.checked ? "done" : ""} ${app.implementationSelectedTask?.workItemId === plan.work_item_id && Number(app.implementationSelectedTask?.line) === Number(task.line) ? "selected" : ""}" data-plan-task-work-item="${escapeHtml(plan.work_item_id)}" data-plan-task-line="${escapeHtml(task.line)}">
    <span class="checkbox">${task.checked ? "x" : ""}</span>
    <span>${escapeHtml(task.text)}</span>
    <button class="plan-task-link" type="button" data-plan-task-work-item="${escapeHtml(plan.work_item_id)}" data-plan-task-line="${escapeHtml(task.line)}">L${escapeHtml(task.line)}</button>
  </li>`).join("");
  return `<article class="plan-card ${selected ? "selected" : ""}" data-plan-work-item="${escapeHtml(plan.work_item_id)}">
    <div class="plan-card-heading"><strong>${escapeHtml(plan.work_item_id)} ${escapeHtml(plan.name || "")}</strong><span class="pill ${escapeHtml(lifecycle)}">${escapeHtml(lifecycleLabel)}</span></div>
    <p class="small">${escapeHtml(plan.path || "missing plan")} · ${escapeHtml(plan.completed_count || 0)} / ${escapeHtml(plan.total_count || 0)} (${escapeHtml(plan.percent || 0)}%)</p>
    ${blocker}
    <div class="plan-meter"><span style="width: ${Math.max(0, Math.min(100, Number(plan.percent || 0)))}%"></span></div>
    ${tasks ? `<ul class="plan-tasks">${tasks}</ul>` : '<p class="small">No checkbox tasks found.</p>'}
  </article>`;
}

function renderWorkflowRerunPanel(stageId, label, ucId = "", nextAction = "") {
  const question = app.rerunJob?.status === "needs_input" ? (app.rerunJob.pending_questions || [])[0] : null;
  const promptLabel = question ? question.question : "Correction prompt (optional)";
  const promptHelp = question
    ? `<p class="small">Recommended: ${escapeHtml(question.recommended || "-")}</p>
       <p class="small">Your answer is sent as Grill-Me answer history, so the agent should not ask this again.</p>`
    : "";
  const placeholder = question ? "Answer this Grill-Me question..." : "Describe corrections or additional decisions...";
  const buttonLabel = question ? "Submit answer and rerun" : "Rerun and verify";
  const restartAction = stageId === "technical-decisions" && question
    ? `<button id="restart-technical-decisions" class="secondary" type="button" ${app.busy ? "disabled" : ""}>Discard questions and restart from scratch</button>`
    : "";
  return `<form id="workflow-rerun-form" class="stage-rerun-form" data-stage-id="${escapeHtml(stageId)}" data-uc-id="${escapeHtml(ucId)}">
    <p class="completion">${escapeHtml(label)} complete.</p>
    <p class="small">Reruns this stage with <code>--force</code>, verifies output, and marks downstream design stale.</p>
    <label for="workflow-rerun-prompt">${escapeHtml(promptLabel)}</label>
    ${promptHelp}
    <textarea id="workflow-rerun-prompt" placeholder="${escapeHtml(placeholder)}" ${app.busy ? "disabled" : ""}></textarea>
    <div class="stage-rerun-actions">
      <button class="primary" type="submit" ${app.busy ? "disabled" : ""}>${app.busy ? "Rerunning..." : buttonLabel}</button>
      ${restartAction}
    </div>
    ${nextAction}
  </form>`;
}

function currentRerunAnswerFromPrompt(prompt) {
  const question = (app.rerunJob?.pending_questions || [])[0];
  if (app.rerunJob?.status !== "needs_input" || !question || !prompt) return null;
  return {
    question: question.question || "",
    recommended: question.recommended || "",
    answer: prompt,
  };
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
  setBusy("Submitting answer");
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
    clearBusy();
    render();
  } catch (error) {
    clearBusy();
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
  if (tab === "planning" && (!technicalDecisionUseCases().length || changeSetStageStatus("technical-decisions") !== "verified")) return;
  const planItems = planningUseCases();
  if (tab === "implementation" && (!planItems.length || !planItems.every((item) => item.plan?.path))) return;
  if (tab === "delivery" && (!planItems.length || !planItems.every((item) => item.plan?.path))) return;
  app.stageTab = tab;
  if (tab === "requirements") {
    if (app.workflowRecovered) setRecoveredRequirementsDocument();
    else await openRequirementsDocument();
  }
  if (tab === "eventStorming") await openCurrentEventDocument();
  if (tab === "dddArchitecture") await openCurrentDddDocument();
  if (tab === "technicalDecisions") await openCurrentTechnicalDecisionsDocument();
  if (tab === "planning") await loadPlanningState();
  if (tab === "implementation") await loadImplementationState();
  if (tab === "delivery") await loadDeliveryState();
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
  setBusy(busyLabel);
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
    clearBusy();
    render();
  } catch (error) {
    clearBusy();
    app.error = error.message;
    render();
  }
}

async function startUseCaseDefinition() {
  app.stageTab = "useCases";
  setBusy("Starting Use Case Definition");
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
    clearBusy();
    render();
  } catch (error) {
    clearBusy();
    app.error = error.message;
    render();
  }
}

async function submitUseCaseAnswer(event) {
  event.preventDefault();
  const answer = document.querySelector("#use-case-answer").value.trim();
  if (!answer) return;
  setBusy("Submitting use case answer");
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
    clearBusy();
    render();
  } catch (error) {
    clearBusy();
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
  const answer = currentRerunAnswerFromPrompt(prompt);
  if (app.rerunJob?.status === "needs_input" && !answer) return;
  if (!stageId) return;
  setBusy(`Rerunning ${stageId}`);
  app.error = "";
  render();
  try {
    const response = await fetch(`/api/dashboard/change-sets/${encodeURIComponent(app.requirementsChangeSet)}/rerun-stage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stage_id: stageId,
        uc_id: ucId,
        user_prompt: answer ? "" : prompt,
        ...(answer ? { answers: [answer] } : {}),
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Unable to rerun event storming.");
    app.rerunJob = result.job;
    scheduleWorkflowRerunPoll(stageId, ucId);
  } catch (error) {
    app.error = error.message;
    clearBusy();
    render();
  }
}

async function runAllTechnicalDecisionsStage() {
  setBusy("Running technical decisions");
  app.error = "";
  render();
  try {
    const response = await fetch(`/api/dashboard/change-sets/${encodeURIComponent(app.requirementsChangeSet)}/rerun-stage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stage_id: "technical-decisions",
        uc_id: "",
        user_prompt: "",
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Unable to run technical decisions.");
    app.rerunJob = result.job;
    scheduleWorkflowRerunPoll("technical-decisions", "");
  } catch (error) {
    app.error = error.message;
    clearBusy();
    render();
  }
}

async function restartTechnicalDecisionsFromScratch() {
  const form = document.querySelector("#workflow-rerun-form");
  const stageId = form?.dataset.stageId || app.rerunJob?.stage_id || "";
  const ucId = form?.dataset.ucId || app.rerunJob?.uc_id || "";
  if (stageId !== "technical-decisions" || !ucId) return;
  if (!window.confirm("Discard current Technical Decisions draft and all pending questions, then restart from scratch?")) return;
  setBusy("Restarting technical decisions");
  app.error = "";
  render();
  try {
    const response = await fetch(`/api/dashboard/change-sets/${encodeURIComponent(app.requirementsChangeSet)}/rerun-stage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stage_id: stageId,
        uc_id: ucId,
        user_prompt: "",
        restart: true,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Unable to restart Technical Decisions.");
    app.rerunJob = result.job;
    scheduleWorkflowRerunPoll(stageId, ucId);
  } catch (error) {
    app.error = error.message;
    clearBusy();
    render();
  }
}

function scheduleWorkflowRerunPoll(stageId, ucId) {
  if (app.rerunPollTimer) {
    clearTimeout(app.rerunPollTimer);
    app.rerunPollTimer = null;
  }
  if (app.rerunJob?.status !== "running") return;
  app.rerunPollTimer = setTimeout(async () => {
    const response = await fetch(`/api/dashboard/change-sets/${encodeURIComponent(app.requirementsChangeSet)}/rerun-stage`);
    const result = await response.json();
    if (!response.ok) {
      app.error = result.error || "Unable to load rerun progress.";
      clearBusy();
      render();
      return;
    }
    app.rerunJob = result.job;
    if (result.job?.status === "succeeded") {
      if (result.job.harvest) app.harvest = result.job.harvest;
      if (result.job.dashboard) app.state = result.job.dashboard;
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
      app.rerunJob = null;
      clearBusy();
    } else if (result.job?.status === "needs_input") {
      if (result.job.harvest) app.harvest = result.job.harvest;
      if (result.job.dashboard) app.state = result.job.dashboard;
      clearBusy();
    } else if (["failed", "blocked"].includes(result.job?.status)) {
      app.error = result.job.error || "Stage rerun failed.";
      clearBusy();
    }
    if (result.job?.status === "running") renderPreservingScroll();
    else render();
    scheduleWorkflowRerunPoll(stageId, ucId);
  }, 1000);
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
  } else {
    app.technicalSelectedUc = ucId;
    app.openDocument = {
      id: document.documentId,
      label: document.label,
      editable: false,
      content: `# ${document.label}\n\nNo completed Technical Decisions document exists for ${ucId}.`,
    };
    app.editorMode = "preview";
  }
}

async function selectTechnicalUseCase(ucId) {
  app.technicalSelectedUc = ucId;
  await openCurrentTechnicalDecisionsDocument();
  render();
}

async function selectPlanningUseCase(ucId) {
  app.planningSelectedUc = ucId;
  render();
}

async function loadPlanningState({ renderAfter = false, preserveScroll = false } = {}) {
  if (!app.requirementsChangeSet) return;
  const response = await fetch(`/api/dashboard/change-sets/${encodeURIComponent(app.requirementsChangeSet)}/planning`);
  const result = await response.json();
  if (!response.ok) {
    app.error = result.error || "Unable to load planning state.";
    if (renderAfter) preserveScroll ? renderPreservingScroll() : render();
    return;
  }
  app.planning = result;
  const selected = app.planningSelectedUc || result.plans?.[0]?.work_item_id || "";
  app.planningSelectedUc = selected;
  const change = app.state.change_sets.find((item) => item.id === app.requirementsChangeSet);
  if (change) {
    for (const item of change.work_items) {
      const plan = result.plans.find((candidate) => candidate.work_item_id === item.id);
      if (plan) item.plan = plan;
    }
  }
  schedulePlanningPoll();
  if (renderAfter) preserveScroll ? renderPreservingScroll() : render();
}

async function startPlanWritingRun({ resetPlan = false } = {}) {
  app.error = "";
  const response = await fetch(`/api/dashboard/change-sets/${encodeURIComponent(app.requirementsChangeSet)}/planning/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uc_id: app.planningSelectedUc, reset_plan: resetPlan }),
  });
  const result = await response.json();
  if (!response.ok) {
    app.error = result.error || "Unable to start plan writing.";
  } else {
    app.planning = { ...(app.planning || {}), job: result.job };
  }
  await loadPlanningState({ renderAfter: true });
}

function schedulePlanningPoll() {
  if (app.planningPollTimer) {
    clearTimeout(app.planningPollTimer);
    app.planningPollTimer = null;
  }
  if (app.stageTab !== "planning" || app.planning?.job?.status !== "running") return;
  app.planningPollTimer = setTimeout(async () => {
    await loadPlanningState({ renderAfter: true, preserveScroll: true });
  }, 2500);
}

async function loadImplementationState({ renderAfter = false, preserveScroll = false } = {}) {
  if (!app.requirementsChangeSet) return;
  const response = await fetch(`/api/dashboard/change-sets/${encodeURIComponent(app.requirementsChangeSet)}/implementation`);
  const result = await response.json();
  if (!response.ok) {
    app.error = result.error || "Unable to load implementation state.";
    if (renderAfter) preserveScroll ? renderPreservingScroll() : render();
    return;
  }
  app.implementation = result;
  if (!app.implementationSelectedUc || !(result.plans || []).some((plan) => plan.work_item_id === app.implementationSelectedUc)) {
    app.implementationSelectedUc = result.plans?.[0]?.work_item_id || "";
  }
  const selectableFiles = implementationVisibleFilesForCurrentSelection();
  const selectedStillExists = selectableFiles.some((file) => file.path === app.implementationSelectedDiffPath);
  if (!selectedStillExists) {
    app.implementationSelectedDiffPath = selectableFiles[0]?.path || "";
    app.implementation = { ...app.implementation, selectedDiff: null, selectedSource: null };
  }
  if (app.implementationSelectedDiffPath) {
    await loadImplementationDiff(app.implementationSelectedDiffPath);
  }
  scheduleImplementationPoll();
  if (renderAfter) preserveScroll ? renderPreservingScroll() : render();
}

async function loadImplementationDiff(path) {
  const [diffResponse, sourceResponse] = await Promise.all([
    fetch(`/api/dashboard/change-sets/${encodeURIComponent(app.requirementsChangeSet)}/implementation/diff?path=${encodeURIComponent(path)}`),
    fetch(`/api/dashboard/change-sets/${encodeURIComponent(app.requirementsChangeSet)}/implementation/source?path=${encodeURIComponent(path)}`),
  ]);
  const result = await diffResponse.json();
  const source = await sourceResponse.json();
  if (!diffResponse.ok || !sourceResponse.ok) {
    app.error = result.error || source.error || "Unable to load diff.";
    return;
  }
  if (result.stale) {
    app.implementationSelectedDiffPath = "";
    app.implementation = {
      ...(app.implementation || {}),
      diff: { files: result.files || [] },
      selectedDiff: null,
      selectedSource: null,
    };
    return;
  }
  app.implementationSelectedDiffPath = path;
  app.implementation = { ...(app.implementation || {}), selectedDiff: result, selectedSource: source };
}

async function selectImplementationDiff(path) {
  await loadImplementationDiff(path);
  renderPreservingScroll();
}

async function startImplementationRun() {
  app.error = "";
  await fetch(`/api/dashboard/change-sets/${encodeURIComponent(app.requirementsChangeSet)}/implementation/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uc_id: app.implementationSelectedUc }),
  }).then(async (response) => {
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Unable to start implementation.");
    app.implementation = { ...(app.implementation || {}), job: result.job };
  }).catch((error) => {
    app.error = error.message;
  });
  await loadImplementationState({ renderAfter: true });
}

async function loadDeliveryState({ renderAfter = false, preserveScroll = false } = {}) {
  if (!app.requirementsChangeSet) return;
  const response = await fetch(`/api/dashboard/change-sets/${encodeURIComponent(app.requirementsChangeSet)}/delivery`);
  const result = await response.json();
  if (!response.ok) {
    app.error = result.error || "Unable to load delivery state.";
    if (renderAfter) preserveScroll ? renderPreservingScroll() : render();
    return;
  }
  app.delivery = result;
  scheduleDeliveryPoll();
  if (renderAfter) preserveScroll ? renderPreservingScroll() : render();
}

async function startDeliveryRun() {
  app.error = "";
  await fetch(`/api/dashboard/change-sets/${encodeURIComponent(app.requirementsChangeSet)}/delivery/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  }).then(async (response) => {
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Unable to start PR delivery.");
    app.delivery = { ...(app.delivery || {}), job: result.job };
  }).catch((error) => {
    app.error = error.message;
  });
  await loadDeliveryState({ renderAfter: true });
}

async function loadAppRuntime({ renderAfter = false } = {}) {
  const response = await fetch("/api/app-runtime");
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Unable to load app runtime state.");
  app.appRuntime = result;
  if (renderAfter) render();
}

async function runAppRuntimeAction(environmentId, action) {
  app.appRuntimeBusy = environmentId;
  app.error = "";
  render();
  try {
    const response = await fetch(`/api/app-runtime/${encodeURIComponent(environmentId)}/${encodeURIComponent(action)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ timeout: 60 }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `Unable to ${action} app runtime.`);
    app.appRuntime = result.runtime;
    app.appRuntimeBusy = "";
    render();
  } catch (error) {
    app.appRuntimeBusy = "";
    app.error = error.message;
    await loadAppRuntime({ renderAfter: false }).catch(() => {});
    render();
  }
}

function scheduleImplementationPoll() {
  if (app.implementationPollTimer) {
    clearTimeout(app.implementationPollTimer);
    app.implementationPollTimer = null;
  }
  if (app.stageTab !== "implementation" || app.implementation?.job?.status !== "running") return;
  app.implementationPollTimer = setTimeout(async () => {
    await loadImplementationState({ renderAfter: true, preserveScroll: true });
  }, 1000);
}

function scheduleDeliveryPoll() {
  if (app.deliveryPollTimer) {
    clearTimeout(app.deliveryPollTimer);
    app.deliveryPollTimer = null;
  }
  if (app.stageTab !== "delivery" || app.delivery?.job?.status !== "running") return;
  app.deliveryPollTimer = setTimeout(async () => {
    await loadDeliveryState({ renderAfter: true, preserveScroll: true });
    await loadDashboard({ preserveScroll: true });
  }, 1000);
}

async function runEventStormingTurn(endpoint, label, extra = {}) {
  setBusy(label);
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
  clearBusy();
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

async function runAllDddArchitecture() {
  app.stageTab = "dddArchitecture";
  await runDddTurn("/api/ddd-architecture/run-all", "Running all DDD architecture substeps");
}

async function rerunDddArchitectureStep(stepId) {
  const prompt = (
    document.querySelector("#ddd-rerun-prompt")?.value.trim()
    || document.querySelector("#workflow-rerun-prompt")?.value.trim()
    || ""
  );
  const ucId = app.dddSelectedUc || app.harvest?.ddd_architecture?.current_uc;
  if (!ucId) {
    app.error = "Select a DDD use case before rerunning a substep.";
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
  setBusy(label);
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
    scheduleDddPoll();
    if (state.status === "running") {
      render();
      return;
    }
  } catch (error) {
    app.error = error.message;
  }
  clearBusy();
  render();
}

async function loadHarvestState({ renderAfter = false, preserveScroll = false } = {}) {
  const response = await fetch("/api/harvest");
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Unable to load harvest state.");
  app.harvest = result;
  if (app.harvest.ddd_architecture?.current_uc) app.dddSelectedUc = app.harvest.ddd_architecture.current_uc;
  if (app.harvest.ddd_architecture?.current_step) app.dddSelectedStep = app.harvest.ddd_architecture.current_step;
  await openCurrentDddDocument();
  await loadDashboard({ preserveScroll });
  if (renderAfter) {
    if (preserveScroll) renderPreservingScroll();
    else render();
  }
}

function scheduleDddPoll() {
  if (app.dddPollTimer) {
    clearTimeout(app.dddPollTimer);
    app.dddPollTimer = null;
  }
  if (app.stageTab !== "dddArchitecture" || app.harvest?.ddd_architecture?.status !== "running") return;
  if (!app.busy) {
    app.busy = true;
    app.busyLabel = "Running all DDD architecture substeps";
  }
  if (!app.workflowActivity && app.requirementsChangeSet) {
    app.workflowActivity = {
      label: app.busyLabel,
      startedAtEpoch: Math.floor(Date.now() / 1000),
      elapsed_seconds: 0,
      activity: [],
    };
    scheduleWorkflowActivityPoll();
  }
  app.dddPollTimer = setTimeout(async () => {
    try {
      await loadHarvestState({ renderAfter: true, preserveScroll: true });
      if (app.harvest?.ddd_architecture?.status !== "running" && app.busy) {
        clearBusy();
        renderPreservingScroll();
        return;
      }
    } catch (error) {
      app.error = error.message;
      if (app.busy) clearBusy();
      render();
    }
    scheduleDddPoll();
  }, 2500);
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
      ${change.lifecycle === "active" && stage.status === "blocked" && stage.id === "use-case-definition"
        ? `<button type="button" class="stage-rerun-button" data-continue-stage="ubiquitousLanguage">Continue Ubiquitous Language</button>`
        : ""}
      ${change.lifecycle === "active" && stage.status === "blocked" && stage.id === "ubiquitous-language-definition"
        ? `<button type="button" class="stage-rerun-button" data-continue-stage="ubiquitousLanguage">Continue Ubiquitous Language</button>`
        : ""}
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
    node.onclick = async () => {
      app.rerunStageId = node.dataset.rerunStage;
      app.rerunResult = "";
      app.rerunJob = null;
      app.error = "";
      await loadStageRerunProgress(change);
      render();
    };
  });
  document.querySelectorAll("[data-continue-stage]").forEach((node) => {
    node.onclick = async () => {
      app.requirementsChangeSet = change.id;
      app.selectedChangeSet = change.id;
      app.view = "requirements";
      await loadWorkflowResults(change.id);
      await selectStageTab(node.dataset.continueStage);
    };
  });
  const rerunForm = document.querySelector("#stage-rerun-form");
  if (rerunForm) rerunForm.onsubmit = (event) => submitStageRerun(event, change);
  const restartStage = document.querySelector("#restart-stage-from-scratch");
  if (restartStage) restartStage.onclick = () => restartStageFromScratch(change);
  const implementationJob = document.querySelector("[data-implementation-job]");
  if (implementationJob) implementationJob.ontoggle = () => {
    app.implementationJobCollapsed = !implementationJob.open;
  };
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

function renderPreservingScroll() {
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  const scrollSelector = ".plan-tasks, .diff-files, .diff-view, .diff-editor, .source-viewer, .implementation-job-output";
  const preserved = [...document.querySelectorAll(scrollSelector)].map((node, index) => ({
    index,
    selector: node.className,
    top: node.scrollTop,
    left: node.scrollLeft,
  }));
  render();
  requestAnimationFrame(() => {
    window.scrollTo(scrollX, scrollY);
    const nodes = [...document.querySelectorAll(scrollSelector)];
    for (const item of preserved) {
      const node = nodes[item.index];
      if (!node) continue;
      node.scrollTop = item.top;
      node.scrollLeft = item.left;
    }
  });
}

function rerunnableDesignStage(stageId) {
  return [
    "requirements-definition",
    "ubiquitous-language-definition",
    "use-case-definition",
    "event-storming",
    "ddd-architecture-definition",
    "technical-decisions",
    "plan-writing",
  ].includes(stageId);
}

function stageRequiresUseCase(stageId) {
  return [
    "event-storming",
    "ddd-architecture-definition",
    "technical-decisions",
    "plan-writing",
  ].includes(stageId);
}

function renderStageRerunForm(change) {
  if (!app.rerunStageId) {
    return app.rerunResult ? `<p class="completion stage-rerun-result">${escapeHtml(app.rerunResult)}</p>` : "";
  }
  const stage = change.stages.find((item) => item.id === app.rerunStageId);
  if (!stage) return "";
  const job = app.rerunJob;
  const running = job?.status === "running";
  const question = job?.status === "needs_input" ? (job.pending_questions || [])[0] : null;
  const requiresUc = stageRequiresUseCase(stage.id);
  const workItems = change.work_items.filter((item) => item.id.startsWith("UC-"));
  const ucField = requiresUc
    ? `<label for="stage-rerun-uc">Use case</label>
       <select id="stage-rerun-uc" required>
         <option value="">Select use case</option>
         ${workItems.map((item) => `<option value="${escapeHtml(item.id)}" ${job?.uc_id === item.id ? "selected" : ""}>${escapeHtml(item.id)}: ${escapeHtml(item.name)}</option>`).join("")}
       </select>`
    : "";
  const activity = job
    ? `<details class="implementation-job" open>
        <summary>Agent activity: ${escapeHtml(job.status)}</summary>
        <p class="small">Started ${escapeHtml(job.started_at || "")}; elapsed ${escapeHtml(job.elapsed_seconds || 0)}s${job.finished_at ? `; finished ${escapeHtml(job.finished_at)}` : ""}. Shows provider summaries and tool activity, not private chain-of-thought.</p>
        ${(job.activity || []).length ? `<pre>${escapeHtml(job.activity.join("\n"))}</pre>` : '<p class="small">Waiting for first agent event...</p>'}
        ${job.error ? `<pre class="error">${escapeHtml(job.error)}</pre>` : ""}
      </details>`
    : "";
  const promptLabel = question ? question.question : "Correction prompt (optional)";
  const promptHelp = question
    ? `<p class="small">Recommended: ${escapeHtml(question.recommended || "-")}</p>
       <p class="small">Your answer is sent as Grill-Me answer history, so the agent should not ask this again.</p>`
    : "";
  const placeholder = question ? "Answer this Grill-Me question..." : "Describe corrections or additional decisions...";
  const buttonLabel = question ? "Submit answer and rerun" : "Rerun and verify";
  const restartAction = stage.id === "technical-decisions" && question
    ? '<button id="restart-stage-from-scratch" class="secondary" type="button">Discard questions and restart from scratch</button>'
    : "";
  return `<form id="stage-rerun-form" class="stage-rerun-form">
    <h4>Rerun ${escapeHtml(stage.procedure)}</h4>
    <p class="small">Stage agent runs again with <code>--force</code>, updates artifacts, then runs normal stage verification.</p>
    ${ucField}
    <label for="stage-rerun-prompt">${escapeHtml(promptLabel)}</label>
    ${promptHelp}
    <textarea id="stage-rerun-prompt" placeholder="${escapeHtml(placeholder)}" ${running || app.busy ? "disabled" : ""}></textarea>
    <div class="stage-rerun-actions">
      <button class="primary" type="submit" ${running || app.busy ? "disabled" : ""}>${running || app.busy ? "Rerunning..." : buttonLabel}</button>
      ${restartAction}
      <button id="cancel-stage-rerun" type="button" ${running || app.busy ? "disabled" : ""}>Cancel</button>
    </div>
    ${activity}
  </form>`;
}

async function submitStageRerun(event, change) {
  event.preventDefault();
  const prompt = document.querySelector("#stage-rerun-prompt")?.value.trim() || "";
  const answer = currentRerunAnswerFromPrompt(prompt);
  if (app.rerunJob?.status === "needs_input" && !answer) return;
  const ucId = document.querySelector("#stage-rerun-uc")?.value || "";
  app.busy = true;
  app.error = "";
  render();
  try {
    const response = await fetch(`/api/dashboard/change-sets/${encodeURIComponent(change.id)}/rerun-stage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stage_id: app.rerunJob?.stage_id || app.rerunStageId,
        uc_id: app.rerunJob?.uc_id || ucId,
        user_prompt: answer ? "" : prompt,
        ...(answer ? { answers: [answer] } : {}),
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Unable to rerun design stage.");
    app.rerunJob = result.job;
    scheduleStageRerunPoll(change);
  } catch (error) {
    app.error = error.message;
  } finally {
    app.busy = false;
    render();
  }
}

async function restartStageFromScratch(change) {
  const stageId = app.rerunJob?.stage_id || app.rerunStageId;
  const ucId = app.rerunJob?.uc_id || document.querySelector("#stage-rerun-uc")?.value || "";
  if (stageId !== "technical-decisions" || !ucId) return;
  if (!window.confirm("Discard current Technical Decisions draft and all pending questions, then restart from scratch?")) return;
  app.busy = true;
  app.error = "";
  render();
  try {
    const response = await fetch(`/api/dashboard/change-sets/${encodeURIComponent(change.id)}/rerun-stage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stage_id: stageId,
        uc_id: ucId,
        user_prompt: "",
        restart: true,
      }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Unable to restart Technical Decisions.");
    app.rerunJob = result.job;
    scheduleStageRerunPoll(change);
  } catch (error) {
    app.error = error.message;
  } finally {
    app.busy = false;
    render();
  }
}

async function loadStageRerunProgress(change) {
  try {
    const response = await fetch(`/api/dashboard/change-sets/${encodeURIComponent(change.id)}/rerun-stage`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Unable to load rerun progress.");
    if (result.job?.status) {
      app.rerunJob = result.job;
      app.rerunStageId = result.job.stage_id || app.rerunStageId;
      if (result.job.dashboard) app.state = result.job.dashboard;
    }
  } catch (error) {
    app.error = error.message;
  }
}

function scheduleStageRerunPoll(change) {
  if (app.rerunPollTimer) {
    clearTimeout(app.rerunPollTimer);
    app.rerunPollTimer = null;
  }
  if (app.rerunJob?.status !== "running") return;
  app.rerunPollTimer = setTimeout(async () => {
    const response = await fetch(`/api/dashboard/change-sets/${encodeURIComponent(change.id)}/rerun-stage`);
    const result = await response.json();
    if (!response.ok) {
      app.error = result.error || "Unable to load rerun progress.";
      render();
      return;
    }
    app.rerunJob = result.job;
    if (result.job?.status === "succeeded") {
      if (result.job.dashboard) app.state = result.job.dashboard;
      app.rerunResult = result.job.output || "Stage rerun and verification completed.";
      app.rerunStageId = "";
      app.rerunJob = null;
    } else if (result.job?.status === "needs_input") {
      if (result.job.dashboard) app.state = result.job.dashboard;
    } else if (["failed", "blocked"].includes(result.job?.status)) {
      app.error = result.job.error || "Stage rerun failed.";
    }
    if (result.job?.status === "running") renderPreservingScroll();
    else render();
    scheduleStageRerunPoll(change);
  }, 1000);
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
  app.rerunJob = null;
  await loadStageRerunProgress({ id: changeSetId });
  app.stageTab = workflowTabForRerunJob(app.rerunJob) || app.stageTab;
  app.workflowRecovered = true;
  app.view = "requirements";
  if (app.stageTab === "dddArchitecture") {
    app.dddSelectedUc = result.harvest.ddd_architecture?.current_uc;
    app.dddSelectedStep = result.harvest.ddd_architecture?.current_step || "entity_vo";
    await openCurrentDddDocument();
  } else if (app.stageTab === "eventStorming") {
    app.eventSelectedUc = result.harvest.event_storming?.current_uc;
    await openCurrentEventDocument();
  } else if (app.stageTab === "technicalDecisions") {
    app.technicalSelectedUc = app.rerunJob?.uc_id || app.technicalSelectedUc;
    await openCurrentTechnicalDecisionsDocument();
  } else {
    setRecoveredRequirementsDocument();
  }
  app.error = "";
  render();
}

function workflowTabForRerunJob(job) {
  if (!job || !["needs_input", "blocked", "failed"].includes(job.status)) return "";
  if (job.stage_id === "event-storming") return "eventStorming";
  if (job.stage_id === "ddd-architecture-definition") return "dddArchitecture";
  if (job.stage_id === "technical-decisions") return "technicalDecisions";
  if (job.stage_id === "use-case-definition") return "useCases";
  if (job.stage_id === "ubiquitous-language-definition") return "ubiquitousLanguage";
  return "requirements";
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
document.querySelector("#project-documents").onclick = () => {
  app.view = "project";
  app.openDocument = null;
  app.error = "";
  render();
};
document.querySelector("#app-runtime").onclick = async () => {
  app.view = "appRuntime";
  app.openDocument = null;
  app.error = "";
  try {
    await loadAppRuntime({ renderAfter: true });
  } catch (error) {
    app.error = error.message;
    render();
  }
};
setInterval(() => {
  if (app.view === "dashboard" && !isEditingDashboardDocument()) loadDashboard({ preserveScroll: true }).catch(() => {});
}, 5000);
