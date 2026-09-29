import {
  createOffice,
  deskPositions,
  agentColors,
  statusNames,
} from "/office.js";

const $ = (id) => document.getElementById(id);
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
const office = createOffice($("office-canvas"));
const stateLabels = {
  starting: "Team connecting",
  running: "Work in progress",
  idle: "Team idle",
  stopping: "Stopping team",
  stopped: "Team stopped",
  failed: "Startup failed",
  interrupted: "Session interrupted",
};
let config,
  snapshot = { runs: [], run: null, messages: [] },
  source,
  selectedRun,
  channel = "global",
  messageSignature = "",
  rosterSignature = "",
  detailsSignature = "",
  toastTimer;
const color = (name) =>
  name === "human"
    ? "#c9ef9b"
    : agentColors[
        Math.max(0, Number(name.split("-")[1]) - 1) % agentColors.length
      ] || "#b5a1d8";
const displayName = (name) => (name === "human" ? "You" : name);
const number = (value) =>
  new Intl.NumberFormat("en-US", {
    notation: value > 9999 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(value);
const quantity = (value, noun) =>
  `${number(value)} ${noun}${value === 1 ? "" : "s"}`;
const time = (value) =>
  new Date(value).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
const running = () =>
  snapshot.run && ["starting", "running", "idle"].includes(snapshot.run.status);

function toast(message, error = false) {
  clearTimeout(toastTimer);
  $("toast").textContent = message;
  $("toast").classList.toggle("error", error);
  $("toast").hidden = false;
  toastTimer = setTimeout(
    () => ($("toast").hidden = true),
    error ? 6500 : 3500,
  );
}
async function api(path, body) {
  const response = await fetch(
    path,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Mesh-Token": config.token,
          },
          body: JSON.stringify(body),
        },
  );
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Something went wrong");
  return result;
}
function connect(id) {
  selectedRun = id;
  if (source) source.close();
  source = new EventSource(
    `/api/events${id ? `?run=${encodeURIComponent(id)}` : ""}`,
  );
  source.onmessage = (event) => {
    snapshot = JSON.parse(event.data);
    $("connection").innerHTML = "<i></i>Connected";
    $("connection").classList.add("live");
    render();
  };
  source.onerror = () => {
    $("connection").innerHTML = "<i></i>Reconnecting";
    $("connection").classList.remove("live");
  };
}
function render() {
  const { run, messages } = snapshot;
  office.update(snapshot);
  $("welcome-card").hidden = Boolean(run);
  $("office-title").textContent = run
    ? "Your team, in its own rhythm."
    : "Where ideas get to work.";
  $("goal-preview").textContent = run
    ? run.goal
    : "One goal. Equal peers. A rhythm of their own.";
  $("goal-preview").title = run?.goal || "";
  $("run-state").textContent = run ? stateLabels[run.status] : "Office ready";
  $("stop-team").hidden = !running();
  $("stop-team").disabled = run?.status === "stopping";
  $("room-number").textContent = String(
    Math.max(1, snapshot.runs.findIndex((item) => item.id === run?.id) + 1),
  ).padStart(2, "0");
  const members = run?.members || [],
    working = members.filter((member) => member.status === "working").length;
  $("team-stats").innerHTML =
    `<span><i class="dot green"></i>${quantity(members.length, "agent")}${working ? ` · ${working} working` : ""}</span><span>${quantity(messages.length, "message")}</span><span>${quantity(
      members.reduce((total, member) => total + member.tokens, 0),
      "token",
    )}</span>`;
  $("run-error").hidden = !run?.error;
  $("run-error").textContent = run?.error || "";
  const rosterKey = JSON.stringify(
    members.map(({ name, status, statusMessage, pendingQuestion }) => ({
      name,
      status,
      statusMessage,
      question: pendingQuestion?.id,
    })),
  );
  if (rosterKey !== rosterSignature) {
    rosterSignature = rosterKey;
    const positions = deskPositions(members.length);
    $("agent-hotspots").innerHTML = members
      .map((member, index) => {
        const { x, y, scale } = positions[index];
        return `<button class="agent-hotspot" data-agent="${escape(member.name)}" aria-label="Open ${escape(member.name)}: ${escape(member.statusMessage || statusNames[member.status])}" title="${escape(member.name)} · ${escape(member.statusMessage || statusNames[member.status])}" style="left:${(x - 62 * scale) / 9.6}%;top:${(y - 58 * scale) / 6.2}%;width:${(124 * scale) / 9.6}%;height:${(155 * scale) / 6.2}%"><span>${escape(member.name)} ↗</span></button>`;
      })
      .join("");
    $("agent-channels").innerHTML = members
      .map(
        (member) =>
          `<button class="channel-button" data-channel="agent:${escape(member.name)}"><span class="agent-icon" style="--avatar-color:${color(member.name)}"></span>${escape(member.name)}${member.pendingQuestion ? " ?" : ""}<span class="status-${member.status}">●</span></button>`,
      )
      .join("");
  }
  $("member-count").textContent = members.length;
  $("global-count").textContent = messages.filter(
    (message) => message.channel === "global",
  ).length;
  const pairs = new Map();
  for (const message of messages)
    if (
      message.channel === "direct" &&
      message.from !== "human" &&
      message.to !== "human"
    ) {
      const pair = [message.from, message.to].sort();
      pairs.set(pair.join(":"), pair);
    }
  const peerMarkup =
    [...pairs.entries()]
      .map(
        ([key, pair]) =>
          `<button class="channel-button peer-button" data-channel="pair:${escape(key)}">${escape(pair[0])} ↔ ${escape(pair[1])}</button>`,
      )
      .join("") ||
    '<p class="history-empty" style="padding:0 12px;font-size:10px">Conversations will appear here.</p>';
  if ($("peer-channels").innerHTML !== peerMarkup)
    $("peer-channels").innerHTML = peerMarkup;
  $("export-link").href = run ? `/api/runs/${run.id}/export` : "#";
  if ($("chat-dialog").open) renderChat();
  if ($("history-dialog").open) renderHistory();
}
function setChannel(next) {
  channel = next;
  messageSignature = "";
  detailsSignature = "";
  renderChat();
}
function openChat(next = "global") {
  setChannel(next);
  $("chat-dialog").showModal();
  renderChat();
}

function renderChat() {
  const { run } = snapshot;
  const kind = channel.split(":")[0],
    agentName = kind === "agent" ? channel.slice(6) : null;
  const pair = kind === "pair" ? channel.slice(5).split(":") : null;
  const member = run?.members.find((item) => item.name === agentName);
  $("channel-title").textContent =
    kind === "global"
      ? "# Global Chat"
      : kind === "all"
        ? "All conversations"
        : pair
          ? pair.join(" ↔ ")
          : agentName;
  $("channel-description").textContent = member
    ? "This agent's work and team conversations."
    : pair
      ? "A direct conversation between teammates."
      : "Shared plans, questions, and results.";
  $("chat-goal").hidden = !run;
  if (run) $("chat-goal").innerHTML = `<b>Shared goal</b>${escape(run.goal)}`;
  document
    .querySelectorAll("[data-channel]")
    .forEach((button) =>
      button.classList.toggle("selected", button.dataset.channel === channel),
    );
  const filtered = snapshot.messages.filter((message) => {
    if (kind === "global") return message.channel === "global";
    if (kind === "all") return true;
    if (pair)
      return (
        message.channel === "direct" &&
        pair.includes(message.from) &&
        pair.includes(message.to)
      );
    return message.from === agentName || message.to === agentName;
  });
  const signature = channel + filtered.map((message) => message.id).join(",");
  if (signature !== messageSignature) {
    const container = $("messages"),
      atBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight <
        100;
    const changedChannel =
      !messageSignature || !messageSignature.startsWith(channel);
    messageSignature = signature;
    container.innerHTML = filtered.length
      ? filtered
          .map((message) => {
            const route =
              message.channel === "global"
                ? "# global"
                : `${displayName(message.from)} → ${displayName(message.to)}`;
            return `<article class="message"><div class="message-avatar" style="--avatar-color:${color(message.from)}">${escape(message.from === "human" ? "Y" : message.from.split("-")[1] || "m")}</div><div class="message-content"><div class="message-meta"><strong>${escape(displayName(message.from))}</strong><time datetime="${escape(message.timestamp)}">${time(message.timestamp)}</time><span class="message-route">${escape(route)}${message.urgent ? " · urgent" : ""}</span></div><p>${escape(message.text)}</p></div></article>`;
          })
          .join("")
      : `<div class="empty-chat"><span class="empty-symbol">${kind === "global" ? "#" : "···"}</span><h3>${run ? "The conversation starts here" : "The office is quiet for now"}</h3><p>${run ? "Messages your teammates send to each other will appear here." : "Create a team with a shared goal to bring this board to life."}</p></div>`;
    if (atBottom || changedChannel)
      container.scrollTop = container.scrollHeight;
  }
  const canSend = run && ["running", "idle"].includes(run.status) && !pair;
  $("message-text").disabled = !canSend;
  $("send-message").disabled = !canSend;
  $("compose-label").textContent = pair
    ? "You are viewing a conversation between two agents"
    : member
      ? `Your message to ${agentName}`
      : "Your message to the whole team";
  $("message-text").placeholder = pair
    ? "Select an agent in the sidebar to send a direct message."
    : !canSend
      ? "Messaging is available while the team is running."
      : member
        ? `Message ${agentName}…`
        : "Message your team…";
  $("agent-detail").hidden = !member;
  if (member) {
    const key = JSON.stringify(member);
    if (key !== detailsSignature) {
      detailsSignature = key;
      let question = "";
      if (member.pendingQuestion) {
        const q = member.pendingQuestion;
        question = `<div class="question"><p>${escape(q.title || "The agent is waiting for your answer")}</p>${q.message ? `<p>${escape(q.message)}</p>` : ""}`;
        if (q.method === "confirm")
          question +=
            '<button data-answer="yes">Confirm</button><button data-answer="no">Decline</button>';
        else if (q.method === "select")
          question += (q.options || [])
            .map(
              (option) =>
                `<button data-answer="option" data-value="${escape(option)}">${escape(option)}</button>`,
            )
            .join("");
        else
          question +=
            '<textarea id="question-answer" rows="3" placeholder="Your answer"></textarea><button data-answer="text">Reply</button>';
        question += '<button data-answer="cancel">Cancel</button></div>';
      }
      $("agent-detail").innerHTML =
        `<div class="message-avatar" style="--avatar-color:${color(member.name)};width:43px;height:43px;font-size:20px">${escape(member.name.split("-")[1])}</div><h3>${escape(member.name)}</h3><span class="detail-status">${escape(statusNames[member.status])}</span><p>${escape(member.statusMessage || member.activity)}</p>${question}${member.error ? `<p class="form-error">${escape(member.error)}</p>` : ""}<div class="detail-label">MODEL</div><p>${escape(member.model || "Pi default")}</p><div class="detail-label">ACTIVITY</div><p>${quantity(member.toolCalls, "tool call")} · ${quantity(member.tokens, "token")}</p>${member.reservations?.length ? `<div class="detail-label">RESERVED FILES</div><pre>${escape(member.reservations.map((item) => item.pattern).join("\n"))}</pre>` : ""}<div class="detail-label">LATEST RESULT</div><p>${escape(member.output || "This agent has not shared a result yet.")}</p>`;
    }
  }
}

function renderHistory() {
  $("run-history").innerHTML = snapshot.runs.length
    ? snapshot.runs
        .map(
          (run) =>
            `<button class="history-row" data-run="${escape(run.id)}"><strong>${escape(run.goal)}</strong><span>${new Date(run.createdAt).toLocaleString("en-US", { dateStyle: "short", timeStyle: "short" })} · ${quantity(run.count, "agent")} · ${escape(stateLabels[run.status])}</span></button>`,
        )
        .join("")
    : '<p class="history-empty">Your workrooms and conversations will be saved here.</p>';
}
function openCreate() {
  if (
    snapshot.runs.some((run) =>
      ["starting", "running", "idle", "stopping"].includes(run.status),
    )
  ) {
    toast("Stop the current team before starting another one.");
    return;
  }
  $("form-error").hidden = true;
  $("create-dialog").showModal();
  $("goal").focus();
}
$("new-team").addEventListener("click", openCreate);
$("welcome-start").addEventListener("click", openCreate);
$("board-button").addEventListener("click", () => openChat());
$("open-chat").addEventListener("click", () => openChat());
$("history-button").addEventListener("click", () => {
  renderHistory();
  $("history-dialog").showModal();
});
document.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.close) {
    $(button.dataset.close).close();
    if (document.fullscreenElement)
      await document.exitFullscreen().catch(() => {});
  }
  if (button.dataset.agent) openChat(`agent:${button.dataset.agent}`);
  if (button.dataset.channel) setChannel(button.dataset.channel);
  if (button.dataset.run) {
    $("history-dialog").close();
    messageSignature = "";
    rosterSignature = "";
    connect(button.dataset.run);
  }
  if (button.dataset.answer) {
    const kind = button.dataset.answer,
      agent = channel.slice(6);
    const answer =
      kind === "yes"
        ? { confirmed: true }
        : kind === "no"
          ? { confirmed: false }
          : kind === "cancel"
            ? { cancelled: true }
            : {
                value:
                  kind === "text"
                    ? $("question-answer").value
                    : button.dataset.value,
              };
    try {
      await api(`/api/runs/${snapshot.run.id}/answer`, { agent, answer });
    } catch (error) {
      toast(error.message, true);
    }
  }
});
$("fullscreen-chat").addEventListener("click", () =>
  $("chat-dialog").classList.toggle("expanded"),
);
$("count-minus").addEventListener(
  "click",
  () => ($("count").value = Math.max(1, Number($("count").value) - 1)),
);
$("count-plus").addEventListener(
  "click",
  () => ($("count").value = Math.min(20, Number($("count").value) + 1)),
);
$("create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("launch-button").disabled = true;
  $("form-error").hidden = true;
  try {
    const run = await api("/api/runs", {
      goal: $("goal").value,
      cwd: $("cwd").value,
      count: Number($("count").value),
      model: $("model").value,
    });
    $("create-dialog").close();
    channel = "global";
    rosterSignature = "";
    messageSignature = "";
    connect(run.id);
    toast("Your team is connecting to the office.");
  } catch (error) {
    $("form-error").textContent = error.message;
    $("form-error").hidden = false;
  } finally {
    $("launch-button").disabled = false;
  }
});
$("message-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = $("message-text").value.trim();
  if (!text || !snapshot.run) return;
  const to = channel.startsWith("agent:") ? channel.slice(6) : "#global";
  $("send-message").disabled = true;
  try {
    await api(`/api/runs/${snapshot.run.id}/messages`, { to, text });
    $("message-text").value = "";
  } catch (error) {
    toast(error.message, true);
  } finally {
    $("send-message").disabled = false;
  }
});
$("message-text").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    $("message-form").requestSubmit();
  }
});
$("stop-team").addEventListener("click", async () => {
  if (!snapshot.run) return;
  $("stop-team").disabled = true;
  try {
    await api(`/api/runs/${snapshot.run.id}/stop`, {});
    toast("Team stopped. History saved.");
  } catch (error) {
    toast(error.message, true);
    $("stop-team").disabled = false;
  }
});

try {
  config = await api("/api/config");
  $("cwd").value = config.defaultCwd;
  connect();
  void api("/api/models").then((result) => {
    for (const model of result.models || []) {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = model.name;
      $("model").append(option);
    }
    if (result.error)
      $("model-note").textContent = `Could not load Pi models: ${result.error}`;
  });
} catch (error) {
  toast(`Could not connect to the office: ${error.message}`, true);
}
