const app = {
  state: { change_sets: [] },
  selectedChangeSet: null,
  openDocument: null,
  editorMode: "preview",
};

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

function markdownPreview(content) {
  const lines = String(content ?? "").split(/\r?\n/);
  const html = [];
  for (let index = 0; index < lines.length; index += 1) {
    const heading = renderHeading(lines[index]);
    if (heading) {
      html.push(heading);
      continue;
    }
    const headers = splitTableRow(lines[index]);
    if (headers && isTableDivider(lines[index + 1], headers.length)) {
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
    html.push(escapeHtml(lines[index]));
  }
  return html.join("\n");
}

function renderHeading(line) {
  const heading = line.match(/^(#{1,3}) (.+)$/);
  if (!heading) return "";
  const level = Number(heading[1].length) + 1;
  return `<h${level}>${escapeHtml(heading[2])}</h${level}>`;
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
  const head = headers.map((cell) => `<th>${escapeHtml(cell)}</th>`).join("");
  const body = rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`).join("");
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
  document.querySelector("#change-sets").innerHTML = changes.map((item) => `
    <button class="change-button ${selected?.id === item.id ? "selected" : ""}" data-change="${escapeHtml(item.id)}">
      <span class="pill ${item.lifecycle}">${escapeHtml(item.lifecycle)}</span>
      <strong>${escapeHtml(item.id)}</strong><br>
      <span class="small">${escapeHtml(item.title)}</span>
    </button>`).join("");
  document.querySelectorAll("[data-change]").forEach((node) => node.onclick = () => {
    app.selectedChangeSet = node.dataset.change;
    app.openDocument = null;
    render();
  });
  document.querySelector("#detail").innerHTML = selected ? renderDetail(selected) : "<p>No ChangeSets found.</p>";
  bindDetail(selected);
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
    <span class="pill ${change.lifecycle}">${escapeHtml(change.lifecycle)}</span>
    <h2>${escapeHtml(change.id)} ${escapeHtml(change.title)}</h2>
    <p>${escapeHtml(change.intent)}</p>
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
  if (app.openDocument && change.documents.some((item) => item.id === app.openDocument.id)) {
    renderEditor();
  }
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
setInterval(() => loadDashboard().catch(() => {}), 5000);
