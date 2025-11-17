// Minimal WebRTC client to OpenAI Realtime via your /session token.
// Shows ONLY AI questions live; records (internally) AI Qs and student answers.
// After session, /analyze builds the table & summaries.

const els = {
  topic: document.getElementById("topic"),
  startBtn: document.getElementById("startBtn"),
  endBtn: document.getElementById("endBtn"),
  aiStream: document.getElementById("aiStream"),
  aiAudio: document.getElementById("aiAudio"),
  analyzeBtn: document.getElementById("analyzeBtn"),
  analyzeStatus: document.getElementById("analyzeStatus"),
  analysisTableWrapper: document.getElementById("analysisTableWrapper"),
  analysisSections: document.getElementById("analysisSections"),
  scoreSummary: document.getElementById("scoreSummary"),
};

let pc, dc, micStream;
let interviewerTurns = [];   // AI questions/prompts
let candidateTurns   = [];   // student answers
let pendingAIText    = "";
let pendingStudentText = "";
let started = false;

// for de-dupe: avoid the same AI text being appended 4x
let lastAssistantText = "";

// ---------- small helpers ----------

function appendAI(text) {
  const div = document.createElement("div");
  div.className = "q";
  div.textContent = text;
  els.aiStream.appendChild(div);
  els.aiStream.scrollTop = els.aiStream.scrollHeight;
}

function setBtns(running) {
  els.startBtn.disabled = running;
  els.endBtn.disabled = !running;
  els.analyzeBtn.disabled = !running && (interviewerTurns.length === 0 && candidateTurns.length === 0);
}

// crude HTML stripper (safety)
function stripHtml(s) {
  return (s || "").replace(/<\/?[^>]+(>|$)/g, "");
}

// central helper: push assistant text once, no duplicates
function pushAssistantText(text) {
  const t = stripHtml(text || "").trim();
  if (!t) return;
  if (t === lastAssistantText) return;       // de-dupe consecutive repeats
  lastAssistantText = t;

  interviewerTurns.push(t);
  appendAI(t);
  els.analyzeBtn.disabled = interviewerTurns.length === 0;
}

// Extract assistant / user text from various shapes
function extractAssistantText(msg) {
  const chunks = [];

  // 1) response.output style: { output: [ { content: [...] }, ... ] }
  if (Array.isArray(msg.output)) {
    msg.output.forEach(o => {
      if (Array.isArray(o.content)) {
        o.content.forEach(c => {
          if (!c) return;
          const t = c.text || c.value || "";
          if (t) chunks.push(t);
        });
      }
    });
  }

  // 2) response.created / response.output.{...}
  if (msg.response && Array.isArray(msg.response.output)) {
    msg.response.output.forEach(o => {
      if (Array.isArray(o.content)) {
        o.content.forEach(c => {
          if (!c) return;
          const t = c.text || c.value || "";
          if (t) chunks.push(t);
        });
      }
    });
  }

  // 3) conversation.item.created shapes
  if (msg.item) {
    const it = msg.item;
    if (Array.isArray(it.content)) {
      it.content.forEach(c => {
        if (!c) return;
        const t =
          (c.transcript && (c.transcript.text || c.transcript)) ||
          c.text ||
          c.value ||
          "";
        if (t) chunks.push(t);
      });
    }
    if (typeof it.text === "string") chunks.push(it.text);
    if (typeof it.transcript === "string") chunks.push(it.transcript);
    if (it.transcript && typeof it.transcript.text === "string") {
      chunks.push(it.transcript.text);
    }
  }

  // 4) fallback: plain text field
  if (!chunks.length && typeof msg.text === "string") {
    chunks.push(msg.text);
  }

  return stripHtml(chunks.join(" ").trim());
}

// ---------- renderAnalysis (keeps your existing layout) ----------

function renderAnalysis(result) {
  const {
    overall_score = 0,
    items = [],
    strengths = [],
    improvements = [],
    next_steps = [],
    analysis = "",
    buckets = []
  } = result || {};

  els.scoreSummary.textContent = `Overall Score: ${overall_score}/10`;

  // Table
  const tbl = document.createElement("table");
  const thead = document.createElement("thead");
  thead.innerHTML = `
    <tr>
      <th>Interviewer asked</th>
      <th>Student said</th>
      <th>Expected (JSON)</th>
      <th>Score</th>
    </tr>`;
  tbl.appendChild(thead);

  const tbody = document.createElement("tbody");
  items.forEach(it => {
    const tr   = document.createElement("tr");
    const tdQ  = document.createElement("td");
    const tdA  = document.createElement("td");
    const tdE  = document.createElement("td");
    const tdS  = document.createElement("td");

    tdQ.textContent = it.question || "";
    tdA.textContent = it.answer || "";
    tdE.textContent = it.expected || "";
    tdS.textContent = (it.item_score ?? "");

    tr.append(tdQ, tdA, tdE, tdS);
    tbody.appendChild(tr);
  });
  tbl.appendChild(tbody);

  els.analysisTableWrapper.innerHTML = "";
  els.analysisTableWrapper.appendChild(tbl);

  // Sections + optional buckets
  const sections = document.createElement("div");

  if (buckets && buckets.length) {
    const p = document.createElement("div");
    p.innerHTML = `<h3>Progress by topic</h3>`;
    const ul = document.createElement("ul");
    buckets.forEach(b => {
      const li = document.createElement("li");
      li.textContent = `${b.topic}: ${b.score.toFixed(1)}/10 (${b.level})`;
      ul.appendChild(li);
    });
    p.appendChild(ul);
    sections.appendChild(p);
  }

  sections.innerHTML += `
    <h3>Strengths</h3>
    <ul>${(strengths || []).map(s => `<li>${s}</li>`).join("") || "<li>—</li>"}</ul>
    <h3>Improvements</h3>
    <ul>${(improvements || []).map(s => `<li>${s}</li>`).join("") || "<li>—</li>"}</ul>
    <h3>Next steps</h3>
    <ul>${(next_steps || []).map(s => `<li>${s}</li>`).join("") || "<li>—</li>"}</ul>
    <pre style="white-space:pre-wrap;background:#0f1833;padding:8px;border-radius:8px;border:1px solid #1e2a4a">${analysis || ""}</pre>
  `;

  els.analysisSections.innerHTML = "";
  els.analysisSections.appendChild(sections);
}

// ---------- handleEvent: *your* working version + de-dupe ----------

function handleEvent(ev) {
  if (typeof ev.data !== "string") return;

  let msg;
  try { msg = JSON.parse(ev.data); } catch { return; }

  // --- (A) Streaming assistant text (new + legacy) ---

  if (msg.type === "response.delta" && msg.delta?.type === "output_text") {
    pendingAIText += msg.delta.text || "";
    return;
  }

  if (msg.type === "response.completed") {
    const text = (pendingAIText || "").trim();
    pendingAIText = "";
    if (text) {
      pushAssistantText(text);
    }
    return;
  }

  if (msg.type === "response.output_text.delta") {  // legacy
    pendingAIText += msg.delta || "";
    return;
  }

  if (msg.type === "response.output_text.completed") { // legacy
    const text = (pendingAIText || "").trim();
    pendingAIText = "";
    if (text) {
      pushAssistantText(text);
    }
    return;
  }

  if (msg.type === "response.output" && Array.isArray(msg.output)) {
    const txt = extractAssistantText(msg);
    if (txt) {
      pushAssistantText(txt);
    }
    return;
  }

  if (msg.type === "response.created" && msg.response && Array.isArray(msg.response.output)) {
    const txt = extractAssistantText(msg.response);
    if (txt) {
      pushAssistantText(txt);
    }
    return;
  }

  // --- (B) Student transcription (completed events) ---

  if (
    msg.type === "conversation.item.input_audio_transcription.completed" ||
    msg.type === "input_audio_transcription.completed" ||
    msg.type === "response.input_audio_transcription.completed"
  ) {
    const t = (msg.transcript || msg.text || "").trim();
    if (t) candidateTurns.push(t);
    return;
  }

  // --- (C) conversation.item.created (assistant + user) ---

  if (msg.type === "conversation.item.created" && msg.item) {
    if (msg.item.role === "assistant") {
      const txt = extractAssistantText(msg);
      if (txt) {
        pushAssistantText(txt);
      }
    } else if (msg.item.role === "user") {
      const t = extractAssistantText(msg);
      if (t) candidateTurns.push(t);
    }
    return;
  }

  // --- (D) Last-resort: anything that looks like assistant text ---

  if ((msg.type && String(msg.type).startsWith("response")) || msg.role === "assistant") {
    const txt = extractAssistantText(msg);
    if (txt) {
      pushAssistantText(txt);
      return;
    }
  }
}

// ---------- Interview lifecycle ----------

async function startInterview() {
  if (started) return;
  started = true;
  setBtns(true);

  els.aiStream.innerHTML = "";
  els.analysisTableWrapper.innerHTML = "";
  els.analysisSections.innerHTML = "";
  els.scoreSummary.textContent = "";
  interviewerTurns = [];
  candidateTurns   = [];
  pendingAIText    = "";
  pendingStudentText = "";
  lastAssistantText = "";

  // 1) get ephemeral token
  const topic = els.topic.value;
  const tokResp = await fetch("/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ topic }),
  });

  if (!tokResp.ok) {
    appendAI("Failed to create session. Check server logs.");
    setBtns(false);
    started = false;
    return;
  }

  const { token } = await tokResp.json();

  // 2) Prepare WebRTC
  pc = new RTCPeerConnection();
  dc = pc.createDataChannel("oai-events");

  const sessionUpdate = {
    type: "session.update",
    session: {
      modalities: ["audio", "text"],
      turn_detection: { type: "server_vad", silence_duration_ms: 800 },
      input_audio_transcription: { model: "whisper-1", language: "en" }
    }
  };

  dc.onopen = () => {
    console.log("data channel open");
    dc.send(JSON.stringify(sessionUpdate));
    dc.send(JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        instructions:
          "Greet briefly and ask the student to introduce themselves and relate to the selected topic. " +
          "For every spoken question, also output the same text as output_text. English only."
      }
    }));
  };

  dc.onmessage = (ev) => handleEvent(ev);

  pc.ondatachannel = (e) => {
    const ch = e.channel;
    ch.onopen = () => {
      console.log("remote data channel open");
      ch.send(JSON.stringify(sessionUpdate));
      ch.send(JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions:
            "Greet briefly and ask the student to introduce themselves and relate to the selected topic. " +
            "For every spoken question, also output the same text as output_text. English only."
        }
      }));
    };
    ch.onmessage = (ev) => handleEvent(ev);
  };

  pc.ontrack = (e) => {
    els.aiAudio.srcObject = e.streams[0];
  };

  // 3) Local mic
  micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true }
  });
  micStream.getTracks().forEach(t => pc.addTrack(t, micStream));

  // 4) Offer / answer with OpenAI Realtime
  const offer = await pc.createOffer({
    offerToReceiveAudio: true,
    offerToReceiveVideo: false,
  });
  await pc.setLocalDescription(offer);

  const sdpResp = await fetch(
    "https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/sdp",
        "OpenAI-Beta": "realtime=v1",
      },
      body: offer.sdp,
    }
  );

  if (!sdpResp.ok) {
    console.error("Realtime SDP error", sdpResp.status, await sdpResp.text());
    appendAI("⚠️ Connection to OpenAI Realtime failed. Check console logs.");
    setBtns(false);
    started = false;
    return;
  }

  const answer = { type: "answer", sdp: await sdpResp.text() };
  await pc.setRemoteDescription(answer);

  appendAI("Connected. Interviewer will speak first…");
}

function endInterview() {
  if (!started) return;
  started = false;
  setBtns(false);
  if (dc) { try { dc.close(); } catch {} }
  if (pc) { try { pc.close(); } catch {} }
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); }
  appendAI("Session ended.");
}

// ---------- Analysis ----------

async function runAnalysis() {
  els.analyzeBtn.disabled = true;
  els.analyzeStatus.textContent = "Analyzing…";

  try {
    const topic = els.topic.value;
    const r = await fetch("/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic,
        interviewer: interviewerTurns,
        candidate: candidateTurns
      })
    });
    const data = await r.json();
    renderAnalysis(data);
  } catch (e) {
    console.error(e);
    els.analysisTableWrapper.innerHTML = "<div>Analysis failed. Please retry.</div>";
  } finally {
    els.analyzeStatus.textContent = "";
    els.analyzeBtn.disabled = false;
  }
}

// ---------- wiring + debug helpers ----------

console.log("UI wired");

(function wireUI() {
  const btn = els.startBtn;
  const end = els.endBtn;
  const ana = els.analyzeBtn;

  if (!btn) {
    console.error("startBtn not found in DOM");
    return;
  }

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    console.log("Start clicked");
    startInterview().catch(err => {
      console.error("startInterview error:", err);
    });
  });

  end?.addEventListener("click", (e) => {
    e.preventDefault();
    endInterview();
  });

  ana?.addEventListener("click", (e) => {
    e.preventDefault();
    runAnalysis();
  });
})();

// helper so you can type dumpTurns() in DevTools
window.dumpTurns = function () {
  const obj = { interviewerTurns, candidateTurns };
  console.log(obj);
  return obj;
};
