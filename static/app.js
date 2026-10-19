// ============================================================================
// 《感恩星球｜Lumi 的每日心光日記》 Frontend Logic
// ============================================================================

const QUESTIONS = [
  {
    index: 1,
    field: "q1_affirmation",
    category: "1. 一個肯定",
    prompt: "今天有什麼事情是你想肯定或讚美自己的？",
    placeholder: "寫下今天任何一件值得肯定自己的小事...",
  },
  {
    index: 2,
    field: "q2_gratitude_1",
    category: "2. 第一個感恩",
    prompt: "今天第一件讓你想感謝的事情是什麼？",
    placeholder: "可以是一個人、一頓飯、好天氣，或一個溫暖的瞬間...",
  },
  {
    index: 3,
    field: "q3_gratitude_2",
    category: "3. 第二個感恩",
    prompt: "今天第二件讓你想感謝的事情是什麼？",
    placeholder: "今天還有哪個片刻讓你覺得心存感謝呢？",
  },
  {
    index: 4,
    field: "q4_gratitude_self",
    category: "4. 第三個感恩：感謝自己",
    prompt: "今天你想感謝自己什麼？",
    placeholder: "謝謝今天努力生活、照顧自己的你...",
  },
  {
    index: 5,
    field: "q5_reflection",
    category: "5. 一個檢討",
    prompt: "回顧今天，有哪件事情是你希望下次可以做得更好的？",
    placeholder: "溫柔地回顧今天，有沒有哪個地方下次想調整看看？",
  },
];

const MOOD_LABELS = {
  1: "1 分（非常不好 🌧️）",
  2: "2 分（不太好 ☁️）",
  3: "3 分（普通 ⛅）",
  4: "4 分（不錯 🌤️）",
  5: "5 分（非常好 ☀️）",
};

const WEEKDAY_NAMES = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"];

function getTodayDateString() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatChineseDate(dateStr) {
  if (!dateStr) return "";
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const w = WEEKDAY_NAMES[dt.getDay()];
  return `${y} 年 ${m} 月 ${d} 日（${w}）`;
}

// Application State
const state = {
  participant: null,
  entriesByDate: {}, // { 'YYYY-MM-DD': entryObj }
  selectedDate: getTodayDateString(),
  calYear: new Date().getFullYear(),
  calMonth: new Date().getMonth(), // 0-indexed
  activeView: "diary", // 'diary' | 'starry-sky' | 'history' | 'settings'
  currentQuestionIdx: 0, // 0..4
  tempMoodBefore: null,
  tempMoodAfter: null,
  adminPassword: "",
};

// ============================================================================
// API Helper
// ============================================================================
async function apiFetch(url, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  const res = await fetch(url, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `請求失敗 (${res.status})`);
  }
  return data;
}

// ============================================================================
// Initialization & Auth
// ============================================================================
document.addEventListener("DOMContentLoaded", async () => {
  bindEvents();

  const savedParticipantId = localStorage.getItem("lumi_participant_id");
  if (savedParticipantId) {
    try {
      const data = await apiFetch(`/api/participant/${savedParticipantId}`);
      if (data.participant) {
        await onParticipantAuthenticated(data.participant);
        return;
      }
    } catch (_) {
      localStorage.removeItem("lumi_participant_id");
    }
  }
  showLoginScreen();
});

function showLoginScreen() {
  document.getElementById("login-screen").classList.remove("hidden");
  document.getElementById("onboarding-screen").classList.add("hidden");
  document.getElementById("app-shell").classList.add("hidden");
}

async function onParticipantAuthenticated(participant) {
  state.participant = participant;
  localStorage.setItem("lumi_participant_id", String(participant.id));

  if (!participant.onboarding_completed) {
    showOnboardingScreen();
  } else {
    await enterMainApp();
  }
}

function showOnboardingScreen() {
  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("onboarding-screen").classList.remove("hidden");
  document.getElementById("app-shell").classList.add("hidden");

  document.getElementById("onboarding-user-name").textContent =
    state.participant.name;
}

async function enterMainApp() {
  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("onboarding-screen").classList.add("hidden");
  document.getElementById("app-shell").classList.remove("hidden");

  // Populate sidebar user badge
  document.getElementById("sidebar-user-name").textContent =
    state.participant.name;
  document.getElementById("sidebar-user-code").textContent =
    state.participant.participant_code;

  // Populate settings page
  syncSettingsForm();

  // Load all diary entries for this participant
  await refreshEntriesList();

  // Default to today's date
  const todayStr = getTodayDateString();
  selectDateOnCalendar(todayStr, false);
}

async function refreshEntriesList() {
  if (!state.participant) return;
  const data = await apiFetch(`/api/diary/list/${state.participant.id}`);
  const map = {};
  let starCount = 0;
  for (const e of data.entries || []) {
    map[e.diary_date] = e;
    if (e.star_lit) starCount += 1;
  }
  state.entriesByDate = map;
  document.getElementById("sidebar-star-count").textContent = String(starCount);
  renderCalendar();
  renderStarrySkyView();
  renderHistoryView();
}

// ============================================================================
// Left Calendar Rendering & Date Selection
// ============================================================================
function renderCalendar() {
  const year = state.calYear;
  const month = state.calMonth;
  document.getElementById("cal-month-label").textContent =
    `${year} 年 ${month + 1} 月`;

  const grid = document.getElementById("calendar-days-grid");
  grid.innerHTML = "";

  const firstDayOfWeek = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayStr = getTodayDateString();

  // Leading empty cells
  for (let i = 0; i < firstDayOfWeek; i++) {
    const emptyCell = document.createElement("div");
    emptyCell.className = "cal-day empty";
    grid.appendChild(emptyCell);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(
      d
    ).padStart(2, "0")}`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cal-day";
    if (dateStr === todayStr) btn.classList.add("is-today");
    if (dateStr === state.selectedDate) btn.classList.add("is-selected");

    const entry = state.entriesByDate[dateStr];
    let markerHtml = "";
    if (entry) {
      if (entry.star_lit) {
        markerHtml = `<span title="已完成並點亮星星">⭐</span>`;
      } else {
        markerHtml = `<span class="cal-dot-inprogress" title="書寫中"></span>`;
      }
    }

    btn.innerHTML = `
      <span class="cal-day-num">${d}</span>
      <span class="cal-day-marker">${markerHtml}</span>
    `;

    btn.addEventListener("click", () => {
      selectDateOnCalendar(dateStr, true);
    });

    grid.appendChild(btn);
  }
}

function selectDateOnCalendar(dateStr, autoOpenCompletedReview = false) {
  state.selectedDate = dateStr;
  const [y, m] = dateStr.split("-").map(Number);
  state.calYear = y;
  state.calMonth = m - 1;

  switchMainView("diary");
  renderCalendar();
  renderSelectedDateDiaryStage(autoOpenCompletedReview);
}

// ============================================================================
// Right Panel: Diary Stages & Wizard
// ============================================================================
function hideAllDiaryStages() {
  const ids = [
    "diary-stage-welcome",
    "diary-stage-mood-before",
    "diary-stage-questions",
    "diary-stage-mood-after",
    "diary-stage-review",
  ];
  for (const id of ids) {
    document.getElementById(id).classList.add("hidden");
  }
}

function renderSelectedDateDiaryStage(autoOpenCompletedReview = false) {
  const dateStr = state.selectedDate;
  const todayStr = getTodayDateString();
  const isToday = dateStr === todayStr;
  const entry = state.entriesByDate[dateStr] || null;

  document.getElementById("selected-date-badge").textContent = isToday
    ? "今日心光"
    : "日曆選取日期";
  document.getElementById("selected-date-heading").textContent =
    formatChineseDate(dateStr);

  const statusPill = document.getElementById("diary-status-pill");
  if (!entry) {
    statusPill.className = "status-pill status-empty";
    statusPill.textContent = "尚未書寫";
  } else if (entry.star_lit) {
    statusPill.className = "status-pill status-done";
    statusPill.textContent = "⭐ 已完成心光日記";
  } else {
    statusPill.className = "status-pill status-progress";
    statusPill.textContent = "● 書寫中";
  }

  // If the user clicked a starred date on calendar/history/sky, or if we want to show welcome first
  if (entry && entry.star_lit && autoOpenCompletedReview) {
    showReviewStage(entry);
    return;
  }

  hideAllDiaryStages();
  document.getElementById("diary-stage-welcome").classList.remove("hidden");

  const titleEl = document.getElementById("welcome-greeting-title");
  const descEl = document.getElementById("welcome-greeting-desc");
  const primaryBtn = document.getElementById("start-diary-primary-btn");

  if (!entry) {
    titleEl.textContent = isToday
      ? `${state.participant.name}，歡迎來到今天的感恩日記`
      : `${formatChineseDate(dateStr)} 的感恩日記`;
    descEl.textContent =
      "透過五個簡單的日常提問，記錄今天的肯定、感謝與反思。完成後 Lumi 會為你留下一段專屬的心光回饋。";
    primaryBtn.textContent = isToday
      ? "開始今天的感恩日記 ✨"
      : "開始感恩日記 ✨";
    primaryBtn.onclick = () => openMoodBeforeStage();
  } else if (!entry.star_lit) {
    titleEl.textContent = "這天有一篇尚未完成的感恩日記";
    descEl.textContent =
      "系統已經幫你保留了先前寫下的進度，隨時可以接續完成並點亮今天的星星。";
    primaryBtn.textContent = "繼續書寫 ✍️";
    primaryBtn.onclick = () => resumeDiaryEntry(entry);
  } else {
    titleEl.textContent = "🌟 這天的心光日記已經完成！";
    descEl.textContent =
      "你已經在這天點亮了一顆溫暖的星星。點選下方按鈕即可查看當天的五題回答、前後心情與 Lumi 的整體回饋。";
    primaryBtn.textContent = "查看今日心光回顧 📖";
    primaryBtn.onclick = () => showReviewStage(entry);
  }
}

function resumeDiaryEntry(entry) {
  if (!entry.mood_before) {
    openMoodBeforeStage();
    return;
  }
  const step = entry.current_step || 1;
  if (step >= 2 && step <= 6) {
    openQuestionStage(step - 2);
  } else if (step === 7 || !entry.mood_after) {
    openMoodAfterStage();
  } else {
    showReviewStage(entry);
  }
}

// --- Stage 1: 書寫前心情評分 ---
function openMoodBeforeStage() {
  hideAllDiaryStages();
  document
    .getElementById("diary-stage-mood-before")
    .classList.remove("hidden");

  const entry = state.entriesByDate[state.selectedDate];
  state.tempMoodBefore = entry && entry.mood_before ? entry.mood_before : null;
  updateMoodButtonsUI("mood-before-scale", state.tempMoodBefore);
  document.getElementById("mood-before-next-btn").disabled =
    !state.tempMoodBefore;
}

function updateMoodButtonsUI(containerId, selectedScore) {
  const buttons = document.querySelectorAll(`#${containerId} .mood-btn`);
  buttons.forEach((btn) => {
    const score = Number(btn.getAttribute("data-score"));
    btn.classList.toggle("selected", score === selectedScore);
  });
}

// --- Stage 2: 五題感恩日記書寫 ---
function openQuestionStage(questionIndex) {
  state.currentQuestionIdx = Math.max(0, Math.min(4, questionIndex));
  const q = QUESTIONS[state.currentQuestionIdx];
  const entry = state.entriesByDate[state.selectedDate] || {};

  hideAllDiaryStages();
  document.getElementById("diary-stage-questions").classList.remove("hidden");

  document.getElementById("question-step-label").textContent =
    `第 ${q.index} 題／共 5 題`;
  document.getElementById("question-progress-bar").style.width = `${
    q.index * 20
  }%`;
  document.getElementById("question-category-badge").textContent = q.category;
  document.getElementById("question-prompt-title").textContent = q.prompt;

  const textarea = document.getElementById("question-answer-input");
  textarea.placeholder = q.placeholder;
  textarea.value = entry[q.field] || "";
  textarea.focus();

  const prevBtn = document.getElementById("question-prev-btn");
  prevBtn.textContent =
    state.currentQuestionIdx === 0 ? "← 返回書寫前心情" : "← 上一題";
}

async function saveCurrentQuestionAndAdvance(skipped = false) {
  const q = QUESTIONS[state.currentQuestionIdx];
  const answerVal = skipped
    ? ""
    : document.getElementById("question-answer-input").value.trim();

  const nextStepCode =
    state.currentQuestionIdx < 4 ? state.currentQuestionIdx + 3 : 7;

  const submitBtn = document.getElementById("question-submit-btn");
  const skipBtn = document.getElementById("question-skip-btn");
  submitBtn.disabled = true;
  skipBtn.disabled = true;

  try {
    const payload = {
      participant_id: state.participant.id,
      diary_date: state.selectedDate,
      current_step: nextStepCode,
      [q.field]: answerVal,
    };
    const res = await apiFetch("/api/diary/save", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    state.entriesByDate[state.selectedDate] = res.entry;
    renderCalendar();

    if (state.currentQuestionIdx < 4) {
      openQuestionStage(state.currentQuestionIdx + 1);
    } else {
      openMoodAfterStage();
    }
  } catch (err) {
    alert(err.message);
  } finally {
    submitBtn.disabled = false;
    skipBtn.disabled = false;
  }
}

// --- Stage 3: 書寫後心情評分 ---
function openMoodAfterStage() {
  hideAllDiaryStages();
  document.getElementById("diary-stage-mood-after").classList.remove("hidden");

  const entry = state.entriesByDate[state.selectedDate];
  state.tempMoodAfter = entry && entry.mood_after ? entry.mood_after : null;
  updateMoodButtonsUI("mood-after-scale", state.tempMoodAfter);
  document.getElementById("mood-after-submit-btn").disabled =
    !state.tempMoodAfter;
}

// --- Stage 4 & 5: 今日心光回顧 + Lumi 回饋 + 點亮今日星星 ---
function showReviewStage(entry) {
  hideAllDiaryStages();
  document.getElementById("diary-stage-review").classList.remove("hidden");

  document.getElementById("review-date-text").textContent = formatChineseDate(
    entry.diary_date
  );
  document.getElementById("review-mood-before").textContent = entry.mood_before
    ? MOOD_LABELS[entry.mood_before]
    : "未評分";
  document.getElementById("review-mood-after").textContent = entry.mood_after
    ? MOOD_LABELS[entry.mood_after]
    : "未評分";

  const setAnswerText = (elId, text) => {
    const el = document.getElementById(elId);
    if ((text || "").trim()) {
      el.textContent = text.trim();
      el.classList.remove("review-a-empty");
    } else {
      el.textContent = "（此題選擇跳過）";
      el.classList.add("review-a-empty");
    }
  };

  setAnswerText("review-a1", entry.q1_affirmation);
  setAnswerText("review-a2", entry.q2_gratitude_1);
  setAnswerText("review-a3", entry.q3_gratitude_2);
  setAnswerText("review-a4", entry.q4_gratitude_self);
  setAnswerText("review-a5", entry.q5_reflection);

  const styleTag =
    entry.ai_style_snapshot ||
    state.participant.ai_style_preset ||
    "🌷 溫柔陪伴";
  document.getElementById("review-lumi-style-tag").textContent = styleTag;
  document.getElementById("review-lumi-feedback").textContent =
    entry.lumi_feedback || "謝謝你完成了今天的心光日記🌷";

  const unlitBox = document.getElementById("star-unlit-box");
  const litBox = document.getElementById("star-lit-box");

  if (entry.star_lit) {
    unlitBox.classList.add("hidden");
    litBox.classList.remove("hidden");
  } else {
    unlitBox.classList.remove("hidden");
    litBox.classList.add("hidden");
  }
}

// ============================================================================
// Starry Sky View (心光星空) & History View (歷史日記)
// ============================================================================
function renderStarrySkyView() {
  const allEntries = Object.values(state.entriesByDate);
  const starred = allEntries
    .filter((e) => e.star_lit)
    .sort((a, b) => (a.diary_date < b.diary_date ? 1 : -1));

  document.getElementById("sky-total-stars").textContent = String(
    starred.length
  );

  const grid = document.getElementById("starry-sky-grid");
  grid.innerHTML = "";

  if (starred.length === 0) {
    grid.innerHTML = `
      <div class="sky-empty-msg">
        ✨ 目前還沒有點亮的星星。<br />
        完成一篇感恩日記並親手點亮星星後，你的第一顆心光就會出現在這片星空中！
      </div>
    `;
    return;
  }

  starred.forEach((entry) => {
    const card = document.createElement("div");
    card.className = "star-sky-item";
    const snippet =
      entry.q1_affirmation ||
      entry.q2_gratitude_1 ||
      entry.q3_gratitude_2 ||
      entry.q4_gratitude_self ||
      "已完成當日心光日記";

    card.innerHTML = `
      <div class="star-sky-top">
        <span class="star-sky-date">${entry.diary_date}</span>
        <span>⭐</span>
      </div>
      <div class="star-sky-snippet">${escapeHtml(snippet)}</div>
    `;

    card.addEventListener("click", () => {
      selectDateOnCalendar(entry.diary_date, true);
    });
    grid.appendChild(card);
  });
}

function renderHistoryView() {
  const container = document.getElementById("history-list-container");
  container.innerHTML = "";

  const entries = Object.values(state.entriesByDate).sort((a, b) =>
    a.diary_date < b.diary_date ? 1 : -1
  );

  if (entries.length === 0) {
    container.innerHTML = `
      <div class="stage-card">
        <p class="stage-desc" style="margin-bottom: 0;">目前還沒有任何歷史日記紀錄。從左側日曆選擇今天開始第一篇吧！</p>
      </div>
    `;
    return;
  }

  entries.forEach((entry) => {
    const card = document.createElement("div");
    card.className = "history-card";
    const preview =
      entry.q1_affirmation ||
      entry.q2_gratitude_1 ||
      entry.q4_gratitude_self ||
      "（點擊查看完整五題回答與 Lumi 回饋）";

    const statusBadge = entry.star_lit
      ? `<span class="status-pill status-done">⭐ 已點亮星星</span>`
      : `<span class="status-pill status-progress">● 書寫中</span>`;

    card.innerHTML = `
      <div>
        <div class="history-card-title">${formatChineseDate(entry.diary_date)}</div>
        <div class="history-card-meta">
          書寫前心情：${entry.mood_before ? entry.mood_before + " 分" : "-"} ｜ 
          書寫後心情：${entry.mood_after ? entry.mood_after + " 分" : "-"}
        </div>
        <div class="history-card-preview">${escapeHtml(preview)}</div>
      </div>
      <div>${statusBadge}</div>
    `;

    card.addEventListener("click", () => {
      selectDateOnCalendar(entry.diary_date, true);
    });
    container.appendChild(card);
  });
}

// ============================================================================
// Settings View (設定)
// ============================================================================
function syncSettingsForm() {
  if (!state.participant) return;
  document.getElementById("settings-user-name").textContent =
    state.participant.name;
  document.getElementById("settings-user-code").textContent =
    state.participant.participant_code;

  const preset = state.participant.ai_style_preset || "🌷 溫柔陪伴";
  const buttons = document.querySelectorAll(
    "#settings-preset-grid .style-option-btn"
  );
  buttons.forEach((btn) => {
    btn.classList.toggle(
      "selected",
      btn.getAttribute("data-style") === preset
    );
  });

  document.getElementById("settings-custom-style").value =
    state.participant.ai_style_custom || "";
}

function switchMainView(viewName) {
  state.activeView = viewName;
  const views = ["diary", "starry-sky", "history", "settings"];
  views.forEach((v) => {
    document
      .getElementById(`view-${v}`)
      .classList.toggle("hidden", v !== viewName);
  });

  document.querySelectorAll(".sidebar-nav .nav-item").forEach((btn) => {
    btn.classList.toggle(
      "active",
      btn.getAttribute("data-view") === viewName
    );
  });
}

// ============================================================================
// Researcher Admin Console Logic
// ============================================================================
async function loadAdminOverview() {
  const errEl = document.getElementById("admin-auth-error");
  errEl.textContent = "";

  try {
    const data = await apiFetch("/api/admin/overview", {
      headers: { "X-Admin-Password": state.adminPassword },
    });

    document.getElementById("admin-auth-box").classList.add("hidden");
    document
      .getElementById("admin-dashboard-content")
      .classList.remove("hidden");

    const participants = data.participants || [];
    const entries = data.entries || [];
    const totalStars = entries.filter((e) => e.star_lit).length;

    document.getElementById("admin-kpi-users").textContent = String(
      participants.length
    );
    document.getElementById("admin-kpi-entries").textContent = String(
      entries.length
    );
    document.getElementById("admin-kpi-stars").textContent = String(totalStars);

    const geminiStatus = document.getElementById("admin-gemini-status");
    if (data.gemini_configured) {
      geminiStatus.className = "status-pill status-done";
      geminiStatus.textContent = `已連線 (${data.gemini_key_masked})`;
    } else {
      geminiStatus.className = "status-pill status-progress";
      geminiStatus.textContent =
        "尚未設定 API Key（目前使用內建溫暖回覆模板）";
    }

    // Render participants table
    const pTbody = document.getElementById("admin-participants-tbody");
    pTbody.innerHTML = "";
    participants.forEach((p) => {
      const tr = document.createElement("tr");
      const styleText = p.ai_style_custom
        ? `${p.ai_style_preset || ""}（補充：${p.ai_style_custom}）`
        : p.ai_style_preset || "未設定";

      tr.innerHTML = `
        <td>
          <div class="code-edit-inline">
            <input type="text" class="code-input-sm" value="${escapeHtml(
              p.participant_code
            )}" data-pid="${p.id}" />
            <button type="button" class="btn btn-secondary btn-sm save-code-btn" data-pid="${
              p.id
            }">儲存編號</button>
          </div>
        </td>
        <td><strong>${escapeHtml(p.name)}</strong></td>
        <td>${escapeHtml(styleText)}</td>
        <td>${p.completed_entries} ／ ${p.total_entries} 篇</td>
        <td>⭐ ${p.stars_count}</td>
        <td>${escapeHtml(p.last_active_date)}</td>
      `;
      pTbody.appendChild(tr);
    });

    pTbody.querySelectorAll(".save-code-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const pid = btn.getAttribute("data-pid");
        const input = pTbody.querySelector(`input[data-pid="${pid}"]`);
        const newCode = input.value.trim();
        try {
          await apiFetch(`/api/admin/participant/${pid}/code`, {
            method: "POST",
            headers: { "X-Admin-Password": state.adminPassword },
            body: JSON.stringify({ participant_code: newCode }),
          });
          btn.textContent = "✓ 已更新";
          setTimeout(() => (btn.textContent = "儲存編號"), 1500);
          if (state.participant && String(state.participant.id) === String(pid)) {
            state.participant.participant_code = newCode;
            document.getElementById("sidebar-user-code").textContent = newCode;
            document.getElementById("settings-user-code").textContent = newCode;
          }
        } catch (e) {
          alert(e.message);
        }
      });
    });

    // Render diary entries table
    const eTbody = document.getElementById("admin-entries-tbody");
    eTbody.innerHTML = "";
    entries.forEach((e) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><code>${escapeHtml(e.participant_code)}</code></td>
        <td>${escapeHtml(e.participant_name)}</td>
        <td>${escapeHtml(e.diary_date)}</td>
        <td>前：${e.mood_before ?? "-"}<br/>後：${e.mood_after ?? "-"}</td>
        <td>
          <div><strong>1.肯定：</strong>${escapeHtml(e.q1_affirmation || "-")}</div>
          <div><strong>2.感恩一：</strong>${escapeHtml(e.q2_gratitude_1 || "-")}</div>
          <div><strong>3.感恩二：</strong>${escapeHtml(e.q3_gratitude_2 || "-")}</div>
          <div><strong>4.謝自己：</strong>${escapeHtml(e.q4_gratitude_self || "-")}</div>
          <div><strong>5.檢討：</strong>${escapeHtml(e.q5_reflection || "-")}</div>
        </td>
        <td style="max-width: 260px;">${escapeHtml(e.lumi_feedback || "-")}</td>
        <td>${e.star_lit ? "⭐ 已點亮" : "● 書寫中"}</td>
        <td style="font-size: 0.78rem; color: #7d685c;">
          始：${escapeHtml(e.started_at || "-")}<br/>
          完：${escapeHtml(e.completed_at || "-")}
        </td>
      `;
      eTbody.appendChild(tr);
    });
  } catch (err) {
    errEl.textContent = err.message;
  }
}

// ============================================================================
// Event Bindings
// ============================================================================
function bindEvents() {
  // 1. Login Form
  document
    .getElementById("login-form")
    .addEventListener("submit", async (e) => {
      e.preventDefault();
      const nameInput = document.getElementById("participant-name-input");
      const name = nameInput.value.trim();
      if (!name) return;

      try {
        const data = await apiFetch("/api/auth/login", {
          method: "POST",
          body: JSON.stringify({ name }),
        });
        await onParticipantAuthenticated(data.participant);
      } catch (err) {
        alert(err.message);
      }
    });

  // 2. Onboarding Style Preset Selection
  document
    .querySelectorAll("#onboarding-preset-grid .style-option-btn")
    .forEach((btn) => {
      btn.addEventListener("click", () => {
        document
          .querySelectorAll("#onboarding-preset-grid .style-option-btn")
          .forEach((b) => b.classList.remove("selected"));
        btn.classList.add("selected");
      });
    });

  document
    .getElementById("confirm-onboarding-btn")
    .addEventListener("click", async () => {
      const selectedBtn = document.querySelector(
        "#onboarding-preset-grid .style-option-btn.selected"
      );
      const preset = selectedBtn
        ? selectedBtn.getAttribute("data-style")
        : "🌷 溫柔陪伴";
      const custom = document
        .getElementById("onboarding-custom-style")
        .value.trim();

      try {
        const data = await apiFetch(
          `/api/participant/${state.participant.id}/style`,
          {
            method: "POST",
            body: JSON.stringify({
              ai_style_preset: preset,
              ai_style_custom: custom,
            }),
          }
        );
        state.participant = data.participant;
        await enterMainApp();
      } catch (err) {
        alert(err.message);
      }
    });

  // 3. Calendar Prev/Next Month
  document.getElementById("cal-prev-month").addEventListener("click", () => {
    state.calMonth -= 1;
    if (state.calMonth < 0) {
      state.calMonth = 11;
      state.calYear -= 1;
    }
    renderCalendar();
  });

  document.getElementById("cal-next-month").addEventListener("click", () => {
    state.calMonth += 1;
    if (state.calMonth > 11) {
      state.calMonth = 0;
      state.calYear += 1;
    }
    renderCalendar();
  });

  // 4. Sidebar Menu Navigation
  document.getElementById("nav-today-diary").addEventListener("click", () => {
    selectDateOnCalendar(getTodayDateString(), false);
  });
  document.getElementById("nav-starry-sky").addEventListener("click", () => {
    renderStarrySkyView();
    switchMainView("starry-sky");
  });
  document.getElementById("nav-history").addEventListener("click", () => {
    renderHistoryView();
    switchMainView("history");
  });
  document.getElementById("nav-settings").addEventListener("click", () => {
    syncSettingsForm();
    switchMainView("settings");
  });

  // 5. Mood Before Scale
  document
    .querySelectorAll("#mood-before-scale .mood-btn")
    .forEach((btn) => {
      btn.addEventListener("click", () => {
        state.tempMoodBefore = Number(btn.getAttribute("data-score"));
        updateMoodButtonsUI("mood-before-scale", state.tempMoodBefore);
        document.getElementById("mood-before-next-btn").disabled = false;
      });
    });

  document
    .getElementById("mood-before-back-btn")
    .addEventListener("click", () => {
      renderSelectedDateDiaryStage(false);
    });

  document
    .getElementById("mood-before-next-btn")
    .addEventListener("click", async () => {
      if (!state.tempMoodBefore) return;
      try {
        const res = await apiFetch("/api/diary/save", {
          method: "POST",
          body: JSON.stringify({
            participant_id: state.participant.id,
            diary_date: state.selectedDate,
            current_step: 2,
            mood_before: state.tempMoodBefore,
          }),
        });
        state.entriesByDate[state.selectedDate] = res.entry;
        renderCalendar();
        openQuestionStage(0);
      } catch (err) {
        alert(err.message);
      }
    });

  // 6. Five Questions Navigation
  document
    .getElementById("question-prev-btn")
    .addEventListener("click", () => {
      if (state.currentQuestionIdx === 0) {
        openMoodBeforeStage();
      } else {
        openQuestionStage(state.currentQuestionIdx - 1);
      }
    });

  document
    .getElementById("question-submit-btn")
    .addEventListener("click", () => saveCurrentQuestionAndAdvance(false));

  document
    .getElementById("question-skip-btn")
    .addEventListener("click", () => saveCurrentQuestionAndAdvance(true));

  // 7. Mood After Scale
  document.querySelectorAll("#mood-after-scale .mood-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.tempMoodAfter = Number(btn.getAttribute("data-score"));
      updateMoodButtonsUI("mood-after-scale", state.tempMoodAfter);
      document.getElementById("mood-after-submit-btn").disabled = false;
    });
  });

  document
    .getElementById("mood-after-back-btn")
    .addEventListener("click", () => {
      openQuestionStage(4);
    });

  document
    .getElementById("mood-after-submit-btn")
    .addEventListener("click", async () => {
      if (!state.tempMoodAfter) return;
      const btn = document.getElementById("mood-after-submit-btn");
      const origText = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Lumi 正在整理今日的心光回饋... ✨";

      try {
        const res = await apiFetch("/api/diary/save", {
          method: "POST",
          body: JSON.stringify({
            participant_id: state.participant.id,
            diary_date: state.selectedDate,
            current_step: 8,
            mood_after: state.tempMoodAfter,
            generate_feedback: true,
          }),
        });
        state.entriesByDate[state.selectedDate] = res.entry;
        renderCalendar();
        showReviewStage(res.entry);
      } catch (err) {
        alert(err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = origText;
      }
    });

  // 8. Review Stage Actions & Lighting Today's Star
  document
    .getElementById("review-edit-answers-btn")
    .addEventListener("click", () => {
      openQuestionStage(0);
    });

  document
    .getElementById("light-star-btn")
    .addEventListener("click", async () => {
      const btn = document.getElementById("light-star-btn");
      btn.disabled = true;
      try {
        const res = await apiFetch("/api/diary/save", {
          method: "POST",
          body: JSON.stringify({
            participant_id: state.participant.id,
            diary_date: state.selectedDate,
            light_star: true,
          }),
        });
        state.entriesByDate[state.selectedDate] = res.entry;
        await refreshEntriesList();
        showReviewStage(res.entry);

        const starIcon = document.getElementById("star-anim-icon");
        starIcon.classList.remove("pop-anim");
        void starIcon.offsetWidth;
        starIcon.classList.add("pop-anim");

        const statusPill = document.getElementById("diary-status-pill");
        statusPill.className = "status-pill status-done";
        statusPill.textContent = "⭐ 已完成心光日記";
      } catch (err) {
        alert(err.message);
      } finally {
        btn.disabled = false;
      }
    });

  document
    .getElementById("go-starry-sky-btn")
    .addEventListener("click", () => {
      renderStarrySkyView();
      switchMainView("starry-sky");
    });

  // 9. Settings Style Update
  document
    .querySelectorAll("#settings-preset-grid .style-option-btn")
    .forEach((btn) => {
      btn.addEventListener("click", () => {
        document
          .querySelectorAll("#settings-preset-grid .style-option-btn")
          .forEach((b) => b.classList.remove("selected"));
        btn.classList.add("selected");
      });
    });

  document
    .getElementById("save-settings-btn")
    .addEventListener("click", async () => {
      const selectedBtn = document.querySelector(
        "#settings-preset-grid .style-option-btn.selected"
      );
      const preset = selectedBtn
        ? selectedBtn.getAttribute("data-style")
        : "🌷 溫柔陪伴";
      const custom = document
        .getElementById("settings-custom-style")
        .value.trim();

      try {
        const data = await apiFetch(
          `/api/participant/${state.participant.id}/style`,
          {
            method: "POST",
            body: JSON.stringify({
              ai_style_preset: preset,
              ai_style_custom: custom,
            }),
          }
        );
        state.participant = data.participant;
        const msg = document.getElementById("settings-save-msg");
        msg.textContent = "✓ 已儲存 Lumi 回饋風格設定！";
        setTimeout(() => (msg.textContent = ""), 2500);
      } catch (err) {
        alert(err.message);
      }
    });

  // 10. Logout / Switch Participant
  document.getElementById("logout-btn").addEventListener("click", () => {
    localStorage.removeItem("lumi_participant_id");
    state.participant = null;
    state.entriesByDate = {};
    document.getElementById("participant-name-input").value = "";
    showLoginScreen();
  });

  // 11. Researcher Admin Modal (Hidden from participants; accessible via /researcher-admin or Ctrl+Shift+A)
  const openAdminModal = () => {
    document.getElementById("admin-modal").classList.remove("hidden");
    document.getElementById("admin-password-input").focus();
  };

  if (
    window.location.pathname === "/researcher-admin" ||
    new URLSearchParams(window.location.search).get("admin") === "1"
  ) {
    openAdminModal();
  }

  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && (e.key === "A" || e.key === "a")) {
      e.preventDefault();
      openAdminModal();
    }
  });

  document.getElementById("close-admin-btn").addEventListener("click", () => {
    document.getElementById("admin-modal").classList.add("hidden");
    if (window.location.pathname === "/researcher-admin") {
      window.history.replaceState({}, "", "/");
    }
  });

  const submitAdminLogin = () => {
    state.adminPassword = document
      .getElementById("admin-password-input")
      .value.trim();
    loadAdminOverview();
  };

  document
    .getElementById("admin-login-btn")
    .addEventListener("click", submitAdminLogin);

  document
    .getElementById("admin-password-input")
    .addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submitAdminLogin();
      }
    });

  document
    .getElementById("admin-refresh-btn")
    .addEventListener("click", () => loadAdminOverview());

  document
    .getElementById("admin-save-key-btn")
    .addEventListener("click", async () => {
      const keyVal = document
        .getElementById("admin-gemini-key-input")
        .value.trim();
      try {
        await apiFetch("/api/admin/settings", {
          method: "POST",
          headers: { "X-Admin-Password": state.adminPassword },
          body: JSON.stringify({ gemini_api_key: keyVal }),
        });
        document.getElementById("admin-gemini-key-input").value = "";
        await loadAdminOverview();
        alert("Gemini API Key 已更新並儲存！");
      } catch (err) {
        alert(err.message);
      }
    });

  document
    .getElementById("admin-save-password-btn")
    .addEventListener("click", async () => {
      const newPwd = document
        .getElementById("admin-new-password-input")
        .value.trim();
      if (!newPwd) {
        alert("請先輸入新的管理密碼！");
        return;
      }
      try {
        await apiFetch("/api/admin/settings", {
          method: "POST",
          headers: { "X-Admin-Password": state.adminPassword },
          body: JSON.stringify({ new_admin_password: newPwd }),
        });
        state.adminPassword = newPwd;
        document.getElementById("admin-new-password-input").value = "";
        alert("後台管理密碼已成功更新！請牢記新密碼。");
      } catch (err) {
        alert(err.message);
      }
    });

  document
    .getElementById("admin-export-csv-btn")
    .addEventListener("click", () => {
      const url = `/api/admin/export/csv?admin_password=${encodeURIComponent(
        state.adminPassword
      )}`;
      window.open(url, "_blank");
    });
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

