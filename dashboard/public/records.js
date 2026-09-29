const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const $ = (id) => document.getElementById(id);
const label = (value) =>
  ({
    knowledge: "Knowledge",
    work: "Work in progress",
    delivery: "Deliveries",
    draft: "Draft",
    ready: "Ready",
    superseded: "Superseded",
    needs_attention: "Needs attention",
    answered: "Answered",
    resolved: "Resolved",
    withdrawn: "Withdrawn",
    open: "Open",
  })[value] || value;
const date = (value) =>
  new Date(value).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
const empty = (title, description) =>
  `<div class="records-empty"><span class="pixel-glyph">▤</span><h3>${esc(title)}</h3><p>${esc(description)}</p></div>`;
export function createRecords({ api, toast, openChat }) {
  let snapshot = { run: null, office: {} },
    shelf = "delivery",
    selected,
    historical,
    questionFilter = "open",
    signatures = {},
    textRequest = 0;
  const drafts = new Map();
  let previousFocus;
  let pdfDocument,
    pdfPage = 1;
  let pdfTask;
  function clearPreview() {
    textRequest++;
    if (pdfTask) void pdfTask.destroy();
    pdfTask = undefined;
    pdfDocument = undefined;
  }
  document.body.insertAdjacentHTML(
    "beforeend",
    `
  <dialog id="shelves-dialog" class="records-dialog" aria-labelledby="shelves-title"><header class="records-header"><div><span class="records-kicker">THE SHARED SHELVES</span><h2 id="shelves-title">Made by your team.</h2></div><div class="records-actions"><a id="bundle-all" class="quiet" download>Download all ↓</a><button id="add-artifact" class="primary">＋ Register artifact</button><button class="icon-button" data-expand-records="shelves-dialog" aria-label="Expand shelves">⛶</button><button class="icon-button" data-close="shelves-dialog" aria-label="Close shelves">×</button></div></header><div class="records-shell"><nav class="records-nav" aria-label="Shelves"><p>ARTIFACTS</p><button data-shelf="delivery">▣ Deliveries <b id="count-delivery">0</b></button><button data-shelf="work">▧ Work in progress <b id="count-work">0</b></button><button data-shelf="knowledge">▤ Knowledge <b id="count-knowledge">0</b></button><button data-shelf="all">All artifacts</button><p>TEAM AGREEMENT</p><button data-shelf="agreement">Completion & handoff</button><div class="shelf-note">Shared work stays here.<br>Even after the office goes quiet.</div></nav><main id="shelf-content" class="records-main"></main></div></dialog>
  <dialog id="questions-dialog" class="records-dialog" aria-labelledby="questions-title"><header class="records-header"><div><span class="records-kicker">A LITTLE CLARITY GOES A LONG WAY</span><h2 id="questions-title">Questions for you.</h2></div><div class="records-actions"><button class="icon-button" data-expand-records="questions-dialog" aria-label="Expand questions">⛶</button><button class="icon-button" data-close="questions-dialog" aria-label="Close questions">×</button></div></header><div class="records-shell"><nav class="records-nav" aria-label="Question filters"><p>YOUR INPUT</p><button data-question-filter="open">Open <b id="count-open">0</b></button><button data-question-filter="blocking">Blocking work</button><button data-question-filter="answered">Answered & resolved</button><button data-question-filter="all">All questions</button><div class="shelf-note">Answers are saved for the team.<br>A paused team stays paused.</div></nav><main id="question-content" class="records-main"></main></div></dialog>
  <dialog id="artifact-form-dialog" class="artifact-form-dialog" aria-labelledby="register-title"><header class="records-header"><div><span class="records-kicker">SHARE SOMETHING USEFUL</span><h2 id="register-title">Register an artifact</h2></div><button class="icon-button" data-close="artifact-form-dialog" aria-label="Close registration">×</button></header><form id="artifact-form" class="records-form"><label>Title<input name="title" required maxlength="200" placeholder="A useful name for this work"></label><label>Summary<textarea name="summary" required rows="2" placeholder="What is this, and why does it matter?"></textarea></label><fieldset><legend>Put it on a shelf</legend><label><input name="purpose" type="checkbox" value="knowledge" checked> Knowledge</label><label><input name="purpose" type="checkbox" value="work"> Work in progress</label><label><input name="purpose" type="checkbox" value="delivery"> Deliveries</label></fieldset><div class="record-form-row"><label>Resource type<select name="type"><option value="file">File</option><option value="directory">Directory</option><option value="url">Link</option><option value="note">Note</option></select></label><label>Readiness<select name="state"><option value="draft">Draft</option><option value="ready">Ready</option></select></label></div><label><span id="resource-value-label">Workspace-relative path</span><textarea name="value" rows="3" required placeholder="reports/brief.pdf"></textarea></label><label>Limitations<textarea name="limitations" rows="2" placeholder="What is unfinished or not verified?"></textarea></label><p class="field-note">Local files are saved as a versioned snapshot. Registration does not publish anything online.</p><button class="primary" type="submit">Register artifact</button></form></dialog>`,
  );
  const current = () =>
    historical || snapshot.office?.artifacts?.find((a) => a.id === selected);
  const fileUrl = (a, r, f) =>
    `/api/runs/${snapshot.run.id}/artifacts/${a.id}/${a.revision}/${r}/${f.path.split("/").map(encodeURIComponent).join("/")}`;
  const bundleUrl = (query) =>
    `/api/runs/${snapshot.run.id}/bundle${query ? "?" + query : ""}`;
  const open = (id) => {
    previousFocus = document.activeElement;
    signatures[id] = "";
    $(id).showModal();
    render();
  };
  const refresh = async () => {
    update(await api(`/api/state?run=${snapshot.run.id}`));
  };
  function update(next) {
    if (snapshot.run?.id !== next.run?.id) {
      selected = undefined;
      historical = undefined;
      drafts.clear();
      signatures = {};
    }
    snapshot = next;
    render();
  }
  function render() {
    const data = snapshot.office || {},
      artifacts = data.artifacts || [],
      questions = data.questions || [];
    const pending = questions.filter((q) => q.status === "open").length;
    const runtime = (snapshot.run?.members || []).filter(
      (m) => m.pendingQuestion,
    );
    $("questions-count").textContent = pending + runtime.length;
    $("shelves-count").textContent = artifacts.filter(
      (a) => a.purpose.includes("delivery") && a.state !== "superseded",
    ).length;
    $("delivery-state").textContent = data.delivery
      ? label(data.delivery.effectiveState)
      : "Not collected";
    $("question-hotspot").setAttribute(
      "aria-label",
      `Open questions, ${pending + runtime.length} pending`,
    );
    $("shelves-hotspot").setAttribute(
      "aria-label",
      `Open shelves, ${artifacts.length} artifacts`,
    );
    for (const p of ["knowledge", "work", "delivery"])
      $("count-" + p).textContent = artifacts.filter(
        (a) => a.purpose.includes(p) && a.state !== "superseded",
      ).length;
    $("count-open").textContent = pending;
    $("add-artifact").disabled = !snapshot.run;
    $("bundle-all").hidden = !artifacts.length;
    if (snapshot.run) $("bundle-all").href = bundleUrl();
    document
      .querySelectorAll("[data-shelf]")
      .forEach((b) =>
        b.classList.toggle("selected", b.dataset.shelf === shelf),
      );
    document
      .querySelectorAll("[data-question-filter]")
      .forEach((b) =>
        b.classList.toggle(
          "selected",
          b.dataset.questionFilter === questionFilter,
        ),
      );
    if ($("shelves-dialog").open) {
      const key = JSON.stringify([
        snapshot.run?.id,
        data.revision,
        shelf,
        selected,
        historical?.revision,
        data.delivery?.effectiveState,
        data.delivery?.issues,
      ]);
      if (key !== signatures.shelves) {
        signatures.shelves = key;
        renderShelf();
      }
    }
    if ($("questions-dialog").open) {
      const key = JSON.stringify([
        snapshot.run?.id,
        data.revision,
        questionFilter,
        questions.map((q) => q.deliveryReceipts),
        runtime.map((m) => [m.name, m.pendingQuestion.id]),
      ]);
      if (key !== signatures.questions) {
        signatures.questions = key;
        renderQuestions(runtime);
      }
    }
  }
  function renderShelf() {
    clearPreview();
    const target = $("shelf-content");
    const data = snapshot.office || {};
    const a = current();
    if (a) {
      renderArtifact(a);
      return;
    }
    if (shelf === "agreement") {
      renderAgreement();
      return;
    }
    const list = (data.artifacts || []).filter(
      (a) =>
        shelf === "all" ||
        (a.purpose.includes(shelf) && a.state !== "superseded"),
    );
    const description = {
      delivery:
        "Outputs selected for you. Drafts and readiness are shown on each card.",
      work: "Drafts, experiments, and pieces the team is still building.",
      knowledge:
        "Research, decisions, and reference material shared by your peers.",
      all: "Every registered artifact, including older work.",
    }[shelf];
    target.innerHTML = `<div class="shelf-intro"><div><span class="records-kicker">${esc(shelf === "all" ? "THE WHOLE COLLECTION" : label(shelf))}</span><h3>${shelf === "delivery" ? "The work you came for." : shelf === "knowledge" ? "What the team knows." : shelf === "work" ? "Taking shape." : "All the pieces."}</h3><p>${description}</p></div>${shelf === "delivery" && data.delivery ? `<button class="quiet" data-shelf="agreement">${esc(label(data.delivery.effectiveState))} · View handoff ↗</button>` : ""}</div>`;
    if (!list.length) {
      target.innerHTML += empty(
        "This shelf is ready for its first artifact.",
        "Agents can register files, links, notes, and directories here.",
      );
      return;
    }
    target.innerHTML += `<div class="artifact-grid">${list
      .map((a) => {
        const files = a.resources.flatMap((r) => r.files || []);
        const type =
          a.resources[0]?.type === "note"
            ? "NOTE"
            : files[0]?.mime === "application/pdf"
              ? "PDF"
              : a.resources[0]?.type === "url"
                ? "LINK"
                : a.resources[0]?.type === "directory"
                  ? "COLLECTION"
                  : "FILE";
        const checks = [
          ...new Map(
            a.checks
              .filter((c) => c.digest === a.digest)
              .map((c) => [c.label, c]),
          ).values(),
        ];
        return `<button class="artifact-card" data-artifact="${a.id}"><div class="artifact-cover cover-${type.toLowerCase()}"><span>${type}</span><b>${type === "PDF" ? "▤" : type === "LINK" ? "↗" : type === "NOTE" ? "≡" : "▥"}</b><small>${files.length ? files.length + " file" + (files.length === 1 ? "" : "s") : "Shared reference"}</small></div><div class="artifact-card-body"><div class="record-meta"><span class="record-state state-${a.state}">${label(a.state)}</span><span>v${a.revision}</span></div><h4>${esc(a.title)}</h4><p>${esc(a.summary)}</p><div class="card-foot"><span>${esc(a.by)}</span><span>${checks.some((c) => c.outcome === "failed") ? "Check failed" : checks.some((c) => c.outcome === "passed") ? "Checks recorded" : "Not checked"}</span></div></div></button>`;
      })
      .join("")}</div>`;
  }
  function renderArtifact(a) {
    const latest = snapshot.office.artifacts.find((x) => x.id === a.id);
    const index = 0,
      resource = a.resources[index],
      files = resource.files || [];
    $("shelf-content").innerHTML =
      `<div class="artifact-breadcrumb"><button class="text-button" id="back-to-shelf">← Back to shelf</button><label>Version <select id="artifact-version" aria-label="Artifact version">${(latest.revisions || [a.revision]).map((r) => `<option value="${r}" ${r === a.revision ? "selected" : ""}>${r}${r === latest.revision ? " · latest" : ""}</option>`).join("")}</select></label></div><div class="shelf-intro"><div><span class="record-state state-${a.state}">${label(a.state)}</span><h3>${esc(a.title)}</h3><p>${esc(a.summary)}</p></div><a class="quiet" href="${bundleUrl(`artifact=${a.id}&revision=${a.revision}`)}" download>Download artifact ↓</a></div><div class="artifact-byline">${esc(a.by)} · ${date(a.updatedAt)} · ${a.purpose.map(label).join(" / ")}</div>${a.limitations ? `<p class="record-warning">${esc(a.limitations)}</p>` : ""}<div class="resource-toolbar"><label>Resource <select id="resource-select">${a.resources.map((r, i) => `<option value="${i}">${esc(r.path || r.url || "Note " + (i + 1))}</option>`).join("")}</select></label><label id="file-select-label" ${files.length ? "" : "hidden"}>File <select id="file-select">${files.map((f) => `<option value="${esc(f.path)}" ${f.path === resource.entry ? "selected" : ""}>${esc(f.path)}</option>`).join("")}</select></label><a id="resource-download" class="text-button" download>Download file ↓</a></div><div id="artifact-preview" class="artifact-preview"></div><section class="record-section"><h4>Verification</h4>${a.checks.length ? a.checks.map((c) => `<div class="check-row"><span class="record-state ${c.outcome === "passed" ? "state-ready" : c.outcome === "failed" ? "state-needs_attention" : ""}">${c.digest !== a.digest ? "Stale" : esc(c.outcome.replace("_", " "))}</span><div><strong>${esc(c.label)}</strong><p>${esc(c.evidence)}</p><small>${esc(c.by)} · ${date(c.at)}</small></div></div>`).join("") : '<p class="muted">No checks recorded. Ready is the author’s readiness claim.</p>'}</section><details class="record-section"><summary>Origin and related work</summary><p>${esc(a.provenance)}</p>${a.related.map((id) => `<button class="quiet" data-artifact="${esc(id)}">${esc(snapshot.office.artifacts.find((x) => x.id === id)?.title || id)}</button>`).join("")}<p class="field-note">Registered ${date(a.at)}. File contents are preserved with this version.</p></details>`;
    renderResource(a, 0, resource.entry);
  }
  async function renderResource(a, index, path) {
    const request = ++textRequest,
      resource = a.resources[index],
      holder = $("artifact-preview"),
      download = $("resource-download");
    download.hidden = true;
    if (pdfTask) {
      void pdfTask.destroy();
      pdfTask = undefined;
      pdfDocument = undefined;
    }
    if (resource.type === "note") {
      holder.innerHTML = `<pre>${esc(resource.text)}</pre>`;
      return;
    }
    if (resource.type === "url") {
      holder.innerHTML =
        empty(
          "An external reference",
          "This link is not included in offline downloads. Localhost links require a running process.",
        ) +
        `<a class="primary" href="${esc(resource.url)}" target="_blank" rel="noopener noreferrer">Open link ↗</a>`;
      return;
    }
    const f = resource.files.find((f) => f.path === path) || resource.files[0];
    const url = fileUrl(a, index, f);
    download.href = url + "?download=1";
    download.hidden = false;
    if (f.mime === "application/pdf") {
      holder.innerHTML = '<p class="muted">Opening PDF…</p>';
      try {
        const pdf = await import("/pdf.mjs");
        pdf.GlobalWorkerOptions.workerSrc = "/pdf.worker.mjs";
        if (request !== textRequest) return;
        pdfTask = pdf.getDocument({
          url,
          isEvalSupported: false,
          useSystemFonts: true,
        });
        const doc = await pdfTask.promise;
        if (request !== textRequest) {
          void doc.destroy();
          return;
        }
        pdfDocument = doc;
        pdfPage = 1;
        await drawPdf();
      } catch (e) {
        if (request === textRequest)
          holder.innerHTML = empty(
            "PDF preview unavailable",
            "Download the preserved PDF above to open it.",
          );
      }
    } else if (f.mime === "text/html")
      holder.innerHTML = `<iframe title="${esc(a.title)} preview" sandbox="allow-scripts allow-downloads" src="${url}"></iframe>`;
    else if (f.mime.startsWith("image/"))
      holder.innerHTML = `<img src="${url}" alt="${esc(a.title)}">`;
    else if (f.mime.startsWith("video/") || f.mime.startsWith("audio/")) {
      const tag = f.mime.startsWith("video/") ? "video" : "audio";
      holder.innerHTML = `<${tag} src="${url}" controls preload="metadata"></${tag}>`;
    } else if (f.mime === "application/octet-stream")
      holder.innerHTML = empty(
        "Download to open this file",
        "This format has no built-in preview. The original file is preserved.",
      );
    else {
      holder.innerHTML = '<p class="muted">Opening document…</p>';
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error("File could not be opened");
        const text = await response.text();
        if (request === textRequest)
          holder.innerHTML = `<pre>${esc(text.slice(0, 200000))}</pre>${text.length > 200000 ? "<p>Preview shortened. Download the full file above.</p>" : ""}`;
      } catch (e) {
        if (request === textRequest) holder.textContent = e.message;
      }
    }
  }
  async function drawPdf() {
    const doc = pdfDocument,
      pageNumber = pdfPage;
    if (!doc) return;
    const holder = $("artifact-preview");
    holder.innerHTML = `<div class="pdf-controls"><button class="quiet" data-pdf-step="-1" ${pageNumber === 1 ? "disabled" : ""}>← Previous</button><span>Page ${pageNumber} of ${doc.numPages}</span><button class="quiet" data-pdf-step="1" ${pageNumber === doc.numPages ? "disabled" : ""}>Next →</button></div><canvas id="pdf-page" aria-label="PDF page ${pageNumber}"></canvas>`;
    const canvas = $("pdf-page");
    const page = await doc.getPage(pageNumber);
    if (doc !== pdfDocument || pageNumber !== pdfPage || !canvas.isConnected)
      return;
    const original = page.getViewport({ scale: 1 });
    const width = Math.max(250, holder.clientWidth - 24),
      scale = Math.min(1.6, width / original.width);
    const viewport = page.getViewport({
      scale: scale * Math.min(devicePixelRatio || 1, 2),
    });
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    canvas.style.width = `${original.width * scale}px`;
    await page.render({
      canvasContext: canvas.getContext("2d"),
      canvas,
      viewport,
    }).promise;
  }
  function renderAgreement() {
    const data = snapshot.office || {},
      a = data.agreement,
      d = data.delivery;
    $("shelf-content").innerHTML =
      `<div class="shelf-intro"><div><span class="records-kicker">DECIDED BY THE TEAM</span><h3>What does done look like?</h3><p>Your peers agree on the result and how to check it. Activity and delivery readiness are separate.</p></div></div>${a ? `<section class="agreement-card"><div class="record-meta"><b>Completion agreement · v${a.revision}</b><span>${esc(a.by)}</span></div><p>${esc(a.summary)}</p>${a.criteria.map((c) => `<div class="criterion"><span class="criterion-mark ${c.met ? "met" : ""}">${c.met ? "✓" : "○"}</span><div><strong>${esc(c.text)}</strong><p>${esc(c.verification)}</p>${c.evidence.map((id) => `<button class="text-button" data-artifact="${id}">${esc(data.artifacts.find((x) => x.id === id)?.title || id)} ↗</button>`).join("")}</div></div>`).join("")}${a.exclusions ? `<p class="record-warning">Exclusions: ${esc(a.exclusions)}</p>` : ""}<h4>Peer review</h4>${a.reviews.length ? a.reviews.map((r) => `<p><span class="record-state ${r.stance === "object" ? "state-needs_attention" : "state-ready"}">${esc(r.stance)}</span> ${esc(r.by)} · ${esc(r.note)}</p>`).join("") : '<p class="muted">No peer reviews recorded. Silence is not agreement.</p>'}</section>` : empty("No completion agreement yet.", "Agents can discuss the criteria in Chat and record them with mesh_delivery.")}<section class="agreement-card"><div class="record-meta"><h3>Team handoff</h3><span class="record-state state-${d?.effectiveState || "draft"}">${d ? label(d.effectiveState) : "Not collected"}</span></div>${d ? `<h4>${esc(d.title)}</h4><p>${esc(d.summary)}</p><h4>Completed</h4><p>${esc(d.completed)}</p><h4>Remaining</h4><p>${esc(d.remaining || "None listed")}</p><h4>Next</h4><p>${esc(d.next || "No action listed")}</p>${d.issues.length ? `<ul class="record-warning">${d.issues.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}<div class="handoff-artifacts">${d.artifacts.map((ref) => `<button class="quiet" data-artifact="${ref.id}" data-artifact-revision="${ref.revision}">${esc(data.artifacts.find((x) => x.id === ref.id)?.title || ref.id)} · v${ref.revision} ↗</button>`).join("")}</div><a class="primary" href="${bundleUrl("delivery=" + d.revision)}" download>Download this delivery ↓</a><p class="field-note">Handoff v${d.revision} · agreement v${d.agreementRevision} · ${esc(d.by)} · ${date(d.at)}</p>` : '<p class="muted">A peer can volunteer to assemble the handoff. All agents being idle does not mark it ready.</p>'}</section>${data.claim ? `<p class="field-note">${esc(data.claim.by)} is assembling the handoff.</p>` : ""}`;
  }
  function renderQuestions(runtime) {
    const list = (snapshot.office?.questions || []).filter(
      (q) =>
        questionFilter === "all" ||
        (questionFilter === "blocking" &&
          q.blocking &&
          ["open", "answered"].includes(q.status)) ||
        (questionFilter === "open" && q.status === "open") ||
        (questionFilter === "answered" &&
          ["answered", "resolved"].includes(q.status)),
    );
    $("question-content").innerHTML =
      `<div class="shelf-intro"><div><span class="records-kicker">${questionFilter === "blocking" ? "WAITING ON A DECISION" : "YOUR TEAM IS ASKING"}</span><h3>${questionFilter === "answered" ? "Decisions the team can use." : "Help the next piece fall into place."}</h3><p>${snapshot.run?.status === "stopped" || snapshot.run?.status === "interrupted" ? "Your team is paused. Answers are saved now and delivered when you resume." : "Answer once. The peers who need it receive the same decision."}</p></div></div>${runtime.map((m) => `<div class="question-card"><span class="record-state">Live Pi dialog</span><h4>${esc(m.pendingQuestion.title || "A session needs your input")}</h4><p>${esc(m.name)}</p><button class="quiet" data-live-question="${m.name}">Open agent dialog ↗</button></div>`).join("")}${
        !list.length
          ? empty(
              "Nothing waiting here.",
              "Questions and decisions remain available after the team pauses or finishes.",
            )
          : list
              .map((q) => {
                const a = q.answers.at(-1),
                  draft = drafts.get(q.id);
                return `<article class="question-card"><div class="record-meta"><div><span class="record-state state-${q.status}">${label(q.status)}</span>${q.blocking ? '<span class="record-state state-needs_attention">Blocks dependent work</span>' : ""}${q.deferred ? '<span class="record-state">Deferred</span>' : ""}</div><span>${esc(q.by)}</span></div><h4>${esc(q.title)}</h4><p class="question-copy">${esc(q.question)}</p><p class="muted">${esc(q.reason)}</p>${q.recommendation ? `<p class="record-recommendation">Recommendation: ${esc(q.recommendation)}</p>` : ""}${q.assumption ? `<p class="field-note">Independent work: ${esc(q.assumption)}</p>` : ""}${q.related.map((id) => `<button class="text-button" data-question-artifact="${id}">${esc(snapshot.office.artifacts.find((x) => x.id === id)?.title || id)} ↗</button>`).join("")}${a ? `<div class="saved-answer"><span class="records-kicker">YOUR ANSWER · ${date(a.at)}</span><p>${esc(a.text)}</p><small>${q.deliveryReceipts.filter((x) => x.delivered).length}/${q.deliveryReceipts.length} peers received this answer${snapshot.run?.status === "stopped" ? " · queued until Resume" : ""}</small></div>` : ""}${q.resolution ? `<p class="field-note">Resolution: ${esc(q.resolution)}</p>` : ""}${q.status !== "withdrawn" ? `<form class="question-answer-form" data-question="${q.id}" data-revision="${draft?.revision || q.revision}"><div class="answer-options">${q.options.map((o, i) => `<button class="quiet" type="button" data-question-option="${q.id}" data-option="${i}">${esc(o)}</button>`).join("")}</div><label for="answer-${q.id}">${a ? "Update your answer" : "Your answer"}</label><textarea id="answer-${q.id}" rows="3" maxlength="12000" required placeholder="Choose a suggestion or write your own answer…">${esc(draft?.text || "")}</textarea><div class="question-actions"><span class="field-note">${q.subscribers.length} peer${q.subscribers.length === 1 ? "" : "s"} following</span>${q.status === "open" ? `<button class="text-button" type="button" data-defer-question="${q.id}">${q.deferred ? "Return to open" : "Answer later"}</button>` : ""}<button class="primary" type="submit">${a ? "Update answer" : "Send answer"} ↗</button></div></form>` : ""}${
                  q.answers.length > 1
                    ? `<details><summary>Earlier answers</summary>${q.answers
                        .slice(0, -1)
                        .map((a) => `<p>${date(a.at)}<br>${esc(a.text)}</p>`)
                        .join("")}</details>`
                    : ""
                }</article>`;
              })
              .join("")
      }`;
  }
  async function chooseArtifact(id, rev) {
    selected = id;
    historical = rev
      ? await api(`/api/runs/${snapshot.run.id}/records/artifacts`, {
          action: "get",
          id,
          revision: rev,
        })
      : undefined;
    signatures.shelves = "";
    render();
    $("shelf-content").scrollTop = 0;
  }
  document.addEventListener("click", async (event) => {
    const b = event.target.closest("button");
    if (!b) return;
    try {
      if (b.dataset.pdfStep) {
        pdfPage += Number(b.dataset.pdfStep);
        await drawPdf();
      }
      if (b.dataset.shelf) {
        shelf = b.dataset.shelf;
        selected = undefined;
        historical = undefined;
        render();
        $("shelf-content").scrollTop = 0;
      }
      if (b.dataset.questionFilter) {
        questionFilter = b.dataset.questionFilter;
        render();
      }
      if (b.dataset.artifact)
        await chooseArtifact(
          b.dataset.artifact,
          Number(b.dataset.artifactRevision) || undefined,
        );
      if (b.id === "back-to-shelf") {
        selected = undefined;
        historical = undefined;
        render();
        $("shelf-content").scrollTop = 0;
      }
      if (b.dataset.expandRecords)
        $(b.dataset.expandRecords).classList.toggle("expanded");
      if (b.dataset.liveQuestion) {
        $("questions-dialog").close();
        openChat("agent:" + b.dataset.liveQuestion);
      }
      if (b.dataset.questionArtifact) {
        $("questions-dialog").close();
        await chooseArtifact(b.dataset.questionArtifact);
        open("shelves-dialog");
      }
      if (b.dataset.questionOption) {
        const q = snapshot.office.questions.find(
          (q) => q.id === b.dataset.questionOption,
        );
        const area = $("answer-" + q.id);
        area.value = q.options[Number(b.dataset.option)];
        area.dispatchEvent(new Event("input", { bubbles: true }));
        area.focus();
      }
      if (b.dataset.deferQuestion) {
        const q = snapshot.office.questions.find(
          (q) => q.id === b.dataset.deferQuestion,
        );
        await api(`/api/runs/${snapshot.run.id}/records/questions`, {
          action: "defer",
          id: q.id,
          revision: q.revision,
        });
        await refresh();
      }
    } catch (e) {
      toast(e.message, true);
    }
  });
  document.addEventListener("input", (event) => {
    const form = event.target.closest(".question-answer-form");
    if (form)
      drafts.set(form.dataset.question, {
        text: event.target.value,
        revision: Number(form.dataset.revision),
      });
  });
  document.addEventListener("submit", async (event) => {
    const form = event.target.closest(".question-answer-form");
    if (!form) return;
    event.preventDefault();
    const b = form.querySelector("[type=submit]");
    b.disabled = true;
    try {
      await api(`/api/runs/${snapshot.run.id}/records/questions`, {
        action: "answer",
        id: form.dataset.question,
        revision: Number(form.dataset.revision),
        text: form.querySelector("textarea").value,
      });
      drafts.delete(form.dataset.question);
      await refresh();
      toast("Answer saved for your team.");
    } catch (e) {
      if (e.message.startsWith("Revision conflict:")) {
        const id = form.dataset.question;
        const text = form.querySelector("textarea").value;
        await refresh();
        const latest = snapshot.office.questions.find((q) => q.id === id);
        if (latest) {
          drafts.set(id, { text, revision: latest.revision });
          signatures.questions = "";
          render();
        }
        toast(
          "This question changed. Your draft is kept. Review the latest answer and send again.",
          true,
        );
      } else toast(e.message, true);
      b.disabled = false;
    }
  });
  $("shelf-content").addEventListener("change", async (event) => {
    try {
      if (event.target.id === "artifact-version")
        await chooseArtifact(selected, Number(event.target.value));
      if (event.target.id === "resource-select") {
        const a = current(),
          i = Number(event.target.value),
          r = a.resources[i];
        $("file-select-label").hidden = !r.files?.length;
        $("file-select").innerHTML = (r.files || [])
          .map(
            (f) =>
              `<option value="${esc(f.path)}" ${f.path === r.entry ? "selected" : ""}>${esc(f.path)}</option>`,
          )
          .join("");
        renderResource(a, i, r.entry);
      }
      if (event.target.id === "file-select")
        renderResource(
          current(),
          Number($("resource-select").value),
          event.target.value,
        );
    } catch (e) {
      toast(e.message, true);
    }
  });
  $("add-artifact").addEventListener("click", () => {
    $("artifact-form-dialog").showModal();
  });
  $("artifact-form").elements.type.addEventListener("change", (event) => {
    const type = event.target.value;
    $("resource-value-label").textContent =
      type === "note"
        ? "Note content"
        : type === "url"
          ? "URL"
          : "Workspace-relative path";
    $("artifact-form").elements.value.placeholder =
      type === "note"
        ? "Write a note for the team…"
        : type === "url"
          ? "https://example.com/result"
          : "reports/brief.pdf";
  });
  $("artifact-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.target,
      f = new FormData(form),
      b = form.querySelector("[type=submit]");
    b.disabled = true;
    const type = f.get("type");
    const resource = {
      type,
      [type === "url" ? "url" : type === "note" ? "text" : "path"]:
        f.get("value"),
    };
    try {
      const a = await api(`/api/runs/${snapshot.run.id}/records/artifacts`, {
        action: "register",
        title: f.get("title"),
        summary: f.get("summary"),
        purpose: f.getAll("purpose"),
        state: f.get("state"),
        limitations: f.get("limitations"),
        resources: [resource],
      });
      form.reset();
      $("resource-value-label").textContent = "Workspace-relative path";
      form.elements.value.placeholder = "reports/brief.pdf";
      $("artifact-form-dialog").close();
      await refresh();
      await chooseArtifact(a.id);
      toast("Artifact registered.");
    } catch (e) {
      toast(e.message, true);
    } finally {
      b.disabled = false;
    }
  });
  for (const id of ["shelves-dialog", "questions-dialog"])
    $(id).addEventListener("close", () => {
      if (id === "shelves-dialog") clearPreview();
      previousFocus?.focus?.();
    });
  $("question-hotspot").addEventListener("click", () =>
    open("questions-dialog"),
  );
  $("shelves-hotspot").addEventListener("click", () => open("shelves-dialog"));
  $("open-questions").addEventListener("click", () => open("questions-dialog"));
  $("open-shelves").addEventListener("click", () => open("shelves-dialog"));
  return { update };
}
