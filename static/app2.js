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
let started = false;
let interviewerTurns = [];
let candidateTurns   = [];
let pendingAIText    = "";
let kickedOff = false;
const seenMsgIds = new Set();
const recentAssistantTexts = [];


// ------------------ NEW HELPER -------------------
function kickOffRealtime(ch) {
  if (!ch || ch.readyState !== "open") return;

  // 1. update session settings
  ch.send(JSON.stringify({
    type: "session.update",
    session: {
      modalities: ["audio", "text"],
      turn_detection: { type: "server_vad", silence_duration_ms: 800 },
      input_audio_transcription: { model: "whisper-1", language: "en" }
    }
  }));

  // 2. create first response
  ch.send(JSON.stringify({
    type: "response.create",
    response: {
      modalities: ["audio", "text"],
      instructions:
        "Greet briefly and ask: 'Tell me about yourself and how it relates to the selected topic.' " +
        "For every spoken question, also emit the exact same content as text. Speak only English."
    }
  }));
}
// -------------------------------------------------

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
function interviewTurnsEmpty() {
  return !(interviewerTurns.length || candidateTurns.length);
}
function appendAI(text) {
  const div = document.createElement("div");
  div.className = "q";
  div.textContent = text;
  els.aiStream.appendChild(div);
  els.aiStream.scrollTop = els.aiStream.scrollHeight;
}
function setBtns(running) {
  els.startBtn.disabled = running;
  els.endBtn.disabled   = !running;
  els.analyzeBtn.disabled = interviewTurnsEmpty();
}
// Build Analysis table UI
function renderAnalysis(result) {
  const { overall_score, items, strengths, improvements, next_steps, analysis, progress } = result;

  els.scoreSummary.textContent = `Overall Score: ${overall_score}/10`;

  // ===== Table: per-turn =====
  const tbl = document.createElement("table");
  tbl.innerHTML = `
    <thead>
      <tr>
        <th>Interviewer asked</th>
        <th>Student said</th>
        <th>Expected</th>
        <th>Score</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = tbl.querySelector("tbody");

  (items || []).forEach(it => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${it.question ? escapeHtml(it.question) : ""}</td>
      <td>${it.answer ? escapeHtml(it.answer) : ""}</td>
      <td>${it.expected ? escapeHtml(it.expected) : ""}</td>
      <td>${it.item_score ?? ""}</td>
    `;
    tbody.appendChild(tr);
  });

  els.analysisTableWrapper.innerHTML = "";
  els.analysisTableWrapper.appendChild(tbl);

  // ===== Sections + Progress =====
  const sections = document.createElement("div");

  // Progress bars
  const prog = document.createElement("div");
  prog.innerHTML = `<h3>Progress by topic</h3>`;
  (progress || []).forEach(p => {
    const pct = Math.round(10 * p.avg_score); // 0–100
    const row = document.createElement("div");
    row.className = "progress-row";
    row.innerHTML = `
      <div class="progress-title">${escapeHtml(p.bucket)} <span class="muted">(${p.turns} turns)</span></div>
      <div class="bar"><div class="fill" style="width:${pct}%;"></div></div>
      <div class="bar-label">${p.avg_score.toFixed ? p.avg_score.toFixed(1) : p.avg_score}/10</div>
    `;
    prog.appendChild(row);
  });

  sections.innerHTML = `
    <h3>Strengths</h3>
    <ul>${(strengths||[]).map(s=>`<li>${escapeHtml(s)}</li>`).join("") || "<li>—</li>"}</ul>
    <h3>Improvements</h3>
    <ul>${(improvements||[]).map(s=>`<li>${escapeHtml(s)}</li>`).join("") || "<li>—</li>"}</ul>
    <h3>Next steps</h3>
    <ul>${(next_steps||[]).map(s=>`<li>${escapeHtml(s)}</li>`).join("") || "<li>—</li>"}</ul>
    <pre style="white-space:pre-wrap;background:#0f1833;padding:8px;border-radius:8px;border:1px solid #1e2a4a">${escapeHtml(analysis || "")}</pre>
  `;

  els.analysisSections.innerHTML = "";
  els.analysisSections.appendChild(prog);
  els.analysisSections.appendChild(sections);
}
function extractAssistantText(msg) {
  // 1) direct fields commonly seen
  if (typeof msg.text === "string") return msg.text.trim();
  if (typeof msg.value === "string") return msg.value.trim();
  if (typeof msg.transcript === "string") return msg.transcript.trim();

  // 2) OpenAI response.output content array
  if (Array.isArray(msg.output)) {
    const txt = msg.output
      .flatMap(o => Array.isArray(o.content) ? o.content : [])
      .filter(c => c && (c.type === "output_text" || c.type === "text"))
      .map(c => (c.text || c.value || c.transcript || "").trim())
      .filter(Boolean)
      .join(" ")
      .trim();
    if (txt) return txt;
  }

  // 3) message.item/content shapes (conversation.item.created)
  if (msg.item && Array.isArray(msg.item.content)) {
    const txt = msg.item.content
      .filter(c => c && (c.type === "output_text" || c.type === "text"))
      .map(c => (c.text || c.value || "").trim())
      .filter(Boolean)
      .join(" ")
      .trim();
    if (txt) return txt;
    // sometimes assistants send an audio item with a transcript field
    const t2 = msg.item.content
      .map(c => (c && (c.transcript || c.caption)) || "")
      .filter(Boolean)
      .join(" ")
      .trim();
    if (t2) return t2;
  }

  // 4) deeply scan a few common places for 'transcript' or 'text'
  try {
    const pile = JSON.stringify(msg);
    // grab smallish transcripts if present
    const m = pile.match(/"transcript"\s*:\s*"([^"]{5,400})"/i);
    if (m && m[1]) return m[1].trim();
  } catch {}

  return "";
}
function handleEvent(ev) {
  if (typeof ev.data !== "string") return;

  let msg;
  try { msg = JSON.parse(ev.data); } catch { return; }

  // --- (A) Standard streaming shapes we already know ---
  if (msg.type === "response.delta" && msg.delta?.type === "output_text") {
    pendingAIText += msg.delta.text || "";
    return;
  }

  if (msg.type === "response.completed") {
    const text = (pendingAIText || "").trim();
    pendingAIText = "";
    if (text) {
      interviewerTurns.push(text);
      appendAI(text);
      els.analyzeBtn.disabled = interviewerTurns.length === 0;
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
      interviewerTurns.push(text);
      appendAI(text);
      els.analyzeBtn.disabled = interviewerTurns.length === 0;
    }
    return;
  }

  if (msg.type === "response.output" && Array.isArray(msg.output)) {
    const txt = extractAssistantText(msg);
    if (txt) {
      interviewerTurns.push(txt);
      appendAI(txt);
      els.analyzeBtn.disabled = interviewerTurns.length === 0;
    }
    return;
  }

  if (msg.type === "response.created" && msg.response && Array.isArray(msg.response.output)) {
    const txt = extractAssistantText(msg.response);
    if (txt) {
      interviewerTurns.push(txt);
      appendAI(txt);
      els.analyzeBtn.disabled = interviewerTurns.length === 0;
    }
    return;
  }

  // --- (B) Student transcription (we keep your cases and add one) ---
  if (
    msg.type === "conversation.item.input_audio_transcription.completed" ||
    msg.type === "input_audio_transcription.completed" ||
    msg.type === "response.input_audio_transcription.completed"
  ) {
    const t = (msg.transcript || msg.text || "").trim();
    if (t) candidateTurns.push(t);
    return;
  }

  // --- (C) Conversation item created (assistant/user) ---
  if (msg.type === "conversation.item.created" && msg.item) {
    if (msg.item.role === "assistant") {
      const txt = extractAssistantText(msg);
      if (txt) {
        interviewerTurns.push(txt);
        appendAI(txt);
        els.analyzeBtn.disabled = interviewerTurns.length === 0;
      }
    } else if (msg.item.role === "user") {
      const t = extractAssistantText(msg);
      if (t) candidateTurns.push(t);
    }
    return;
  }

  // --- (D) Last-resort catch-all: if the event smells like assistant text, grab it ---
  if ((msg.type && String(msg.type).startsWith("response")) || msg.role === "assistant") {
    const txt = extractAssistantText(msg);
    if (txt) {
      interviewerTurns.push(txt);
      appendAI(txt);
      els.analyzeBtn.disabled = interviewerTurns.length === 0;
      return;
    }
  }
}



window.dumpTurns = () => console.log({ interviewerTurns, candidateTurns });



async function startInterview() {
  // 0) fresh session state
  kickedOff = false;
  seenMsgIds.clear();
  recentAssistantTexts.length = 0;
  pendingAIText = "";
  interviewerTurns = [];
  candidateTurns = [];

  if (started) {
    console.warn("[start] already running; ignoring click");
    return;
  }
  started = true;
  setBtns(true);

  // 1) reset UI
  els.aiStream.innerHTML = "";
  els.analysisTableWrapper.innerHTML = "";
  els.analysisSections.innerHTML = "";
  els.scoreSummary.textContent = "";

  try {
    console.log("[start] fetching ephemeral token…");
    const topic = els.topic.value;
    const tokResp = await fetch("/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ topic })
    });
    if (!tokResp.ok) {
      const txt = await tokResp.text();
      console.error("[start] /session failed", tokResp.status, txt);
      appendAI("Failed to create session. Check server logs.");
      setBtns(false);
      started = false;
      return;
    }
    const { token } = await tokResp.json();
    console.log("[start] got token");

    // 2) peer connection + channels
    console.log("[start] creating RTCPeerConnection");
    pc = new RTCPeerConnection();

    // local data channel
    dc = pc.createDataChannel("oai-events");

// when our local DC opens
dc.onopen = () => {
  console.log("data channel open");
  kickOffRealtime(dc);
};

// handle messages
dc.onmessage = (ev) => handleEvent(ev);

// remote DC (safari / relay)
pc.ondatachannel = (e) => {
  const ch = e.channel;
  ch.onopen = () => {
    console.log("remote data channel open");
    kickOffRealtime(ch);
  };
  ch.onmessage = (ev) => handleEvent(ev);
};

    // 3) remote audio
    pc.ontrack = (e) => {
      console.log("[rtc] ontrack: attaching audio stream");
      els.aiAudio.srcObject = e.streams[0];
    };

    // 4) local mic
    console.log("[start] requesting mic…");
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true }
    });
    micStream.getTracks().forEach(t => pc.addTrack(t, micStream));
    console.log("[start] mic OK");

    // 5) SDP offer/answer
    console.log("[start] creating offer…");
    const offer = await pc.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: false
    });
    await pc.setLocalDescription(offer);
    console.log("[start] posting SDP to OpenAI…");

    const sdpResp = await fetch(
      "https://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/sdp",
          "OpenAI-Beta": "realtime=v1"
        },
        body: offer.sdp
      }
    );

    if (!sdpResp.ok) {
      console.error(
        "[start] Realtime SDP error",
        sdpResp.status,
        await sdpResp.text()
      );
      appendAI("⚠️ Connection to OpenAI Realtime failed. See console.");
      setBtns(false);
      started = false;
      return;
    }

    const answerSDP = await sdpResp.text();
    await pc.setRemoteDescription({ type: "answer", sdp: answerSDP });
    console.log("[start] remote description set; waiting for model audio…");

    appendAI("Connected. Interviewer will speak first…");
  } catch (err) {
    console.error("[start] fatal error", err);
    appendAI("Start failed. See console for details.");
    setBtns(false);
    started = false;
  }
}

function endInterview() {
  if (!started) return;
  started = false; setBtns(false);
  try { dc && dc.close(); } catch {}
  try { pc && pc.close(); } catch {}
  try { micStream && micStream.getTracks().forEach(t => t.stop()); } catch {}
  appendAI("Session ended.");
}

async function runAnalysis() {
  els.analyzeBtn.disabled = true;
  els.analyzeStatus.textContent = "Analyzing…";
  try {
    const topic = els.topic.value;
    const r = await fetch("/analyze", {
      method: "POST",
      headers: { "Content-Type":"application/json" },
      body: JSON.stringify({ topic, interviewer: interviewerTurns, candidate: candidateTurns })
    });
    const data = await r.json();
    renderAnalysis(data);
  } catch (e) {
    console.error(e);
    els.analysisTableWrapper.innerHTML = "<div>Analysis failed. Please retry.</div>";
  } finally {
    els.analyzeStatus.textContent = "";
    els.analyzeBtn.disabled = interviewTurnsEmpty();
  }
}

// ===== wire buttons =====
(function wireUI() {
  els.startBtn?.addEventListener("click", (e) => { e.preventDefault(); startInterview().catch(console.error); });
  els.endBtn?.addEventListener("click",   (e) => { e.preventDefault(); endInterview(); });
  els.analyzeBtn?.addEventListener("click",(e) => { e.preventDefault(); runAnalysis(); });
  setBtns(false);
})();


