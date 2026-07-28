const API = ""; // same origin (served by server.ts)

const $ = (h) => {
  const t = document.createElement("template");
  t.innerHTML = h.trim();
  return t.content.firstChild;
};

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c],
  );

const fmt = (t) => (t ? new Date(t).toLocaleString() : "—");

// Dashboard token (only needed when the server is bound to the LAN with DASHBOARD_TOKEN set).
// Stored locally; sent on every /api call; prompted for on a 401.
const authHeader = () => {
  const t = localStorage.getItem("as_token");
  return t ? { "X-Dashboard-Token": t } : {};
};

const api = async (path, opts = {}) => {
  const r = await fetch(API + path, { ...opts, headers: { ...(opts.headers || {}), ...authHeader() } });
  if (r.status === 401) {
    const t = prompt("Dashboard access token:");
    if (t) {
      localStorage.setItem("as_token", t);
      location.reload();
    }
    throw new Error("unauthorized");
  }
  return r.json();
};

const post = (path, body) =>
  api(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });

const TABS = ["Jobs", "Schedules", "Confirmations", "Memory", "Policy", "Run"];

let tab = "Jobs";

const view = document.getElementById("view");

function renderNav() {
  const nav = document.getElementById("nav");
  nav.innerHTML = "";
  for (const t of TABS) {
    const b = $(`<button class="${t === tab ? "active" : ""}">${t}</button>`);
    b.onclick = () => {
      tab = t;
      render();
    };
    nav.appendChild(b);
  }
}

async function getStatus() {
  try {
    const s = await api("/api/status");
    const busy = s.queue?.running || s.queue?.depth > 0;
    document.getElementById("status").innerHTML =
      `<span class="dot ${busy ? "busy" : "idle"}"></span>${busy ? "running a cycle" : "idle"} · ${s.schedules} schedule(s)`;
  } catch {
    document.getElementById("status").textContent = "backend unreachable";
  }
}

async function render() {
  renderNav();
  view.innerHTML = '<div class="empty">loading…</div>';
  if (tab === "Jobs") return renderJobs();
  if (tab === "Schedules") return renderSchedules();
  if (tab === "Confirmations") return renderConfirmations();
  if (tab === "Memory") return renderMemory();
  if (tab === "Policy") return renderPolicy();
  if (tab === "Run") return renderRun();
}

// --- Jobs ---
async function renderJobs() {
  const runs = await api("/api/runs?limit=50");
  view.innerHTML = "";
  const card = $('<div class="card"><h2>Recent jobs</h2></div>');
  if (!runs.length)
    card.appendChild(
      $(
        '<div class="empty">No runs yet. Use the Run tab or add a schedule.</div>',
      ),
    );
  else {
    const t = $(
      "<table><thead><tr><th>#</th><th>kind</th><th>status</th><th>task</th><th>when</th><th>summary</th></tr></thead><tbody></tbody></table>",
    );
    const tb = t.querySelector("tbody");
    for (const r of runs) {
      const tr =
        $(`<tr class="click"><td class="mono">${r.id}</td><td><span class="tag">${esc(r.kind)}</span></td>
              <td class="s-${esc(r.status)}">${esc(r.status)}</td><td>${esc((r.task || "").slice(0, 60))}</td>
              <td class="muted mono">${fmt(r.started)}</td><td>${esc((r.note || "").slice(0, 80))}</td></tr>`);
      tr.onclick = () => openRun(r.id);
      tb.appendChild(tr);
    }
    card.appendChild(t);
  }
  view.appendChild(card);
}

async function openRun(id) {
  const d = await api("/api/runs/" + id);
  const card = $(
    `<div class="card"><h2>Job #${id} · ${esc(d.run.kind)} · <span class="s-${esc(d.run.status)}">${esc(d.run.status)}</span></h2></div>`,
  );
  card.appendChild($(`<p class="muted">${esc(d.run.task || "(no task)")}</p>`));
  card.appendChild(
    $(
      `<p class="muted mono">${fmt(d.run.started)} → ${fmt(d.run.finished)}</p>`,
    ),
  );
  if (d.run.note) card.appendChild($(`<pre>${esc(d.run.note)}</pre>`));
  if (d.actions?.length) {
    card.appendChild($('<h2 style="margin-top:14px">Tool calls</h2>'));
    for (const a of d.actions)
      card.appendChild(
        $(`<div class="msg"><span class="tag">${esc(a.decision)}</span> <b class="mono">${esc(a.tool)}</b>
              <span class="muted">${esc(a.reversibility || "")} ${esc(a.target || "")}</span><pre>${esc((a.output || "").slice(0, 600))}</pre></div>`),
      );
  }
  card.appendChild($('<h2 style="margin-top:14px">Conversation</h2>'));
  const tr = $('<div class="trace"></div>');
  for (const m of d.trace)
    tr.appendChild(
      $(
        `<div class="msg"><div class="role">${esc(m.role)}</div><pre>${esc(m.content)}</pre></div>`,
      ),
    );
  card.appendChild(tr);
  const back = $(
    '<button class="act" style="margin-bottom:12px">← back to jobs</button>',
  );
  back.onclick = renderJobs;
  view.innerHTML = "";
  view.appendChild(back);
  view.appendChild(card);
}

// --- Schedules ---
async function renderSchedules() {
  const list = await api("/api/schedules");
  view.innerHTML = "";
  const card = $('<div class="card"><h2>Schedules</h2></div>');
  if (!list.length)
    card.appendChild(
      $('<div class="empty">No schedules. Create one below.</div>'),
    );
  for (const s of list) {
    const row = $(`<div class="msg"><div class="row">
            <div><b>${esc(s.name)}</b> <span class="tag">${esc(s.spec || s.interval_minutes + " min")}</span>
              ${s.enabled ? '<span class="tag" style="color:var(--ok)">enabled</span>' : '<span class="tag">paused</span>'}
              <div class="muted">${esc(s.task)}</div>
              <div class="muted mono">last ${fmt(s.last_run)} · next ${fmt(s.next_run)}</div></div>
            </div></div>`);
    const ctrls = $('<div style="margin-top:8px;display:flex;gap:8px"></div>');
    const toggle = $(
      `<button class="act">${s.enabled ? "Pause" : "Enable"}</button>`,
    );
    toggle.onclick = async () => {
      await api("/api/schedules/" + s.id, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !s.enabled }),
      });
      renderSchedules();
    };
    const runNow = $('<button class="act primary">Run now</button>');
    runNow.onclick = async () => {
      runNow.textContent = "running…";
      await post("/api/schedules/" + s.id + "/run");
      renderSchedules();
    };
    const del = $('<button class="act danger">Delete</button>');
    del.onclick = async () => {
      if (confirm("Delete schedule?")) {
        await api("/api/schedules/" + s.id, { method: "DELETE" });
        renderSchedules();
      }
    };
    ctrls.append(toggle, runNow, del);
    row.appendChild(ctrls);
    card.appendChild(row);
  }
  view.appendChild(card);

  const form = $(`<div class="card"><h2>New schedule</h2>
          <div class="row"><div><label>Name</label><input id="s-name" placeholder="morning brief"></div>
          <div><label>Schedule</label><input id="s-when" placeholder="weekdays at 8:00am"></div></div>
          <div class="muted" style="margin-top:6px;font-size:12px">Examples: <span class="mono">weekdays at 8:00am</span> · <span class="mono">daily at 07:30</span> · <span class="mono">mon,wed,fri at 6pm</span> · <span class="mono">every 30 minutes</span> · <span class="mono">every 2 hours</span></div>
          <div style="margin-top:10px"><label>Task</label><textarea id="s-task" rows="2" placeholder="Search for X and save a summary to memory."></textarea></div>
          <div style="margin-top:10px"><button class="act primary" id="s-add">Create</button></div></div>`);
  form.querySelector("#s-add").onclick = async () => {
    const name = form.querySelector("#s-name").value.trim();
    const task = form.querySelector("#s-task").value.trim();
    const schedule = form.querySelector("#s-when").value.trim();
    if (!name || !task || !schedule)
      return alert("name, task, and schedule required");
    const r = await post("/api/schedules", { name, task, schedule });
    if (r && r.error) return alert(r.error);
    renderSchedules();
  };
  view.appendChild(form);
}

// --- Confirmations ---
async function renderConfirmations() {
  const all = await api("/api/confirmations");
  view.innerHTML = "";
  const pending = all.filter((c) => c.state === "pending");
  const card = $('<div class="card"><h2>Awaiting your approval</h2></div>');
  if (!pending.length)
    card.appendChild($('<div class="empty">Nothing pending.</div>'));
  for (const c of pending) {
    // A draft's summary IS the proposed text, so it must keep its line breaks — a wall of
    // run-together prose is not something you can actually review. pre-wrap preserves the
    // newlines while still wrapping long lines.
    const row =
      $(`<div class="msg"><b>#${c.id}</b> <span class="tag">${esc(c.tool)}</span>
            <div style="white-space:pre-wrap;margin-top:6px">${esc(c.summary)}</div>
            <pre>${esc(c.args)}</pre></div>`);
    const ctrls = $('<div style="margin-top:8px;display:flex;gap:8px"></div>');
    const ok = $('<button class="act primary">Approve &amp; run</button>');
    ok.onclick = async () => {
      ok.textContent = "running…";
      const r = await post("/api/confirmations/" + c.id + "/approve");
      alert(r.message);
      renderConfirmations();
    };
    const no = $('<button class="act danger">Reject</button>');
    no.onclick = async () => {
      // An optional reason becomes a preference memory, so it stops proposing this.
      const reason = prompt("Reject #" + c.id + " — why? (optional; helps it learn)") ?? "";
      await post("/api/confirmations/" + c.id + "/reject", { reason });
      renderConfirmations();
    };
    ctrls.append(ok, no);
    row.appendChild(ctrls);
    card.appendChild(row);
  }
  view.appendChild(card);

  const done = all.filter((c) => c.state !== "pending").slice(0, 20);
  if (done.length) {
    const h = $('<div class="card"><h2>History</h2></div>');
    for (const c of done)
      h.appendChild(
        $(
          `<div class="msg muted"><b>#${c.id}</b> <span class="tag">${esc(c.state)}</span> ${esc(c.summary)}</div>`,
        ),
      );
    view.appendChild(h);
  }
}

// --- Memory ---
async function renderMemory() {
  view.innerHTML = "";
  const card = $(
    '<div class="card"><h2>Long-term memory (RAG)</h2><div class="row"><div><input id="m-q" placeholder="search memories…"></div><div style="flex:0 0 80px"><button class="act" id="m-go">Search</button></div></div><div id="m-list" style="margin-top:12px"></div></div>',
  );
  view.appendChild(card);
  const load = async (q) => {
    const rows = await api(
      "/api/memories" + (q ? "?query=" + encodeURIComponent(q) : ""),
    );
    const list = card.querySelector("#m-list");
    list.innerHTML = rows.length
      ? ""
      : '<div class="empty">No memories yet.</div>';
    for (const r of rows)
      list.appendChild(
        $(
          `<div class="msg"><span class="tag">${esc(r.kind)}</span> ${esc(r.text)}<div class="muted mono">${fmt(r.ts)}</div></div>`,
        ),
      );
  };
  card.querySelector("#m-go").onclick = () =>
    load(card.querySelector("#m-q").value.trim());
  load("");
}

// --- Policy ---
async function renderPolicy() {
  const p = await api("/api/policy");
  view.innerHTML = "";
  const card = $(
    '<div class="card"><h2>Policy (read-only — edit policy.json on disk)</h2></div>',
  );
  card.appendChild($(`<pre>${esc(JSON.stringify(p, null, 2))}</pre>`));
  view.appendChild(card);
}

// --- Run ---
function renderRun() {
  view.innerHTML = "";
  const card = $(`<div class="card"><h2>Run a one-off task</h2>
          <textarea id="r-task" rows="3" placeholder="Read https://example.com and remember its heading."></textarea>
          <div style="margin-top:10px"><button class="act primary" id="r-go">Run</button></div>
          <div id="r-out" style="margin-top:12px"></div></div>`);
  view.appendChild(card);
  card.querySelector("#r-go").onclick = async () => {
    const task = card.querySelector("#r-task").value.trim();
    if (!task) return;
    const out = card.querySelector("#r-out");
    out.innerHTML =
      '<div class="muted">running… (an agent cycle can take a while on the local model)</div>';
    try {
      const r = await post("/api/do", { task });
      out.innerHTML = `<div class="msg"><b>done in ${r.steps} step(s)</b><pre>${esc(r.summary)}</pre>
              <button class="act" onclick="location.reload()">refresh</button> · job #${r.runId} (see Jobs tab)</div>`;
    } catch (e) {
      out.innerHTML = `<pre class="s-failed">${esc(String(e))}</pre>`;
    }
  };
}

render();
getStatus();
setInterval(status, 5000);
