const state = {
  publicData: null,
  currentCredentials: null,
  adminPassword: null,
  adminState: null
};

const browserRegistrationKey = "labPlacement.registeredAnonymousId";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function getBrowserRegistration() {
  try {
    const value = localStorage.getItem(browserRegistrationKey);
    if (!value) return null;
    if (!value.startsWith("{")) {
      setBrowserRegistration(value);
      return value;
    }
    const parsed = JSON.parse(value);
    if (parsed.version !== state.publicData?.registrationVersion) {
      localStorage.removeItem(browserRegistrationKey);
      return null;
    }
    return parsed.anonymousId || null;
  } catch {
    return null;
  }
}

function setBrowserRegistration(anonymousId) {
  try {
    localStorage.setItem(browserRegistrationKey, JSON.stringify({
      anonymousId,
      version: state.publicData?.registrationVersion || 1
    }));
  } catch {
    // localStorageが使えないブラウザでは、サーバー側の通常登録だけを行います。
  }
}

function clearBrowserRegistration(anonymousId) {
  try {
    const registeredId = getBrowserRegistration();
    if (!anonymousId || registeredId === anonymousId) {
      localStorage.removeItem(browserRegistrationKey);
    }
  } catch {
    // localStorageが使えない場合は何もしません。
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "通信に失敗しました。");
  return payload;
}

async function loadPublic() {
  state.publicData = await api("/api/public");
  renderPublic();
  renderPreferenceSelectors("#registerPrefs");
  renderRegistrationAvailability();
}

function renderPublic() {
  const data = state.publicData;
  $("#systemStatus").textContent = data.accepting ? "受付中" : "受付停止中";
  $("#summary").innerHTML = [
    metric("参加者数", `${data.participantCount}人`),
    metric("研究室数", `${data.labs.length}件`),
    metric("受付状態", data.accepting ? "受付中" : "停止中"),
    metric("結果公開", data.resultsPublished ? "公開中" : "締切後に公開"),
    metric("最終更新", formatDate(data.updatedAt))
  ].join("");

  if (!data.resultsPublished) {
    $("#resultsGate").classList.remove("hidden");
    $("#resultsGate").textContent = "投票受付中のため、仮配属結果はまだ公開されていません。管理者が受付を停止すると結果が表示されます。";
    $("#simulationResults").innerHTML = "";
    return;
  }

  $("#resultsGate").classList.add("hidden");
  $("#simulationResults").innerHTML = data.simulations.map((sim) => `
    <article class="model">
      <h3>${escapeHtml(sim.name)}</h3>
      ${sim.notes?.length ? `<p class="note">${sim.notes.map(escapeHtml).join(" ")}</p>` : ""}
      <div class="lab-grid">
        ${sim.labs.map((lab) => renderLabResult(lab)).join("")}
        ${renderUnassigned(sim.unassigned)}
      </div>
    </article>
  `).join("");
}

function metric(label, value) {
  return `<div class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`;
}

function renderLabResult(lab) {
  return `
    <section class="lab-result">
      <h3>${escapeHtml(lab.name)}</h3>
      <div class="lab-meta">${lab.assigned.length}人 / 定員 ${lab.min}〜${lab.max}人</div>
      <div class="id-list">
        ${lab.assigned.length ? lab.assigned.map((id) => `<span class="id-chip">${escapeHtml(id)}</span>`).join("") : `<span class="empty">該当なし</span>`}
      </div>
    </section>
  `;
}

function renderUnassigned(ids) {
  return `
    <section class="lab-result">
      <h3>未配属</h3>
      <div class="lab-meta">${ids.length}人</div>
      <div class="id-list">
        ${ids.length ? ids.map((id) => `<span class="id-chip">${escapeHtml(id)}</span>`).join("") : `<span class="empty">なし</span>`}
      </div>
    </section>
  `;
}

function formatDate(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function renderPreferenceSelectors(target, values = []) {
  const labs = state.publicData?.labs || [];
  const rows = labs.map((_, index) => {
    const selected = values[index] || "";
    return `
      <div class="pref-row">
        <span>第${index + 1}希望</span>
        <select data-pref-index="${index}">
          <option value="">選択なし</option>
          ${labs.map((lab) => `<option value="${escapeHtml(lab.id)}" ${lab.id === selected ? "selected" : ""}>${escapeHtml(lab.name)}</option>`).join("")}
        </select>
      </div>
    `;
  }).join("");
  const container = $(target);
  container.innerHTML = rows;
  container.onchange = () => syncPreferenceOptions(container);
  syncPreferenceOptions(container);
}

function syncPreferenceOptions(container) {
  const selects = [...container.querySelectorAll("select")];
  const selectedValues = new Map(
    selects
      .filter((select) => select.value)
      .map((select) => [select.dataset.prefIndex, select.value])
  );

  for (const select of selects) {
    const ownIndex = select.dataset.prefIndex;
    const usedByOthers = new Set(
      [...selectedValues.entries()]
        .filter(([index]) => index !== ownIndex)
        .map(([, value]) => value)
    );

    for (const option of select.options) {
      const unavailable = option.value && usedByOthers.has(option.value);
      option.hidden = unavailable;
      option.disabled = unavailable;
    }
  }
}

function collectPreferences(container) {
  return [...container.querySelectorAll("select")]
    .map((select) => select.value)
    .filter(Boolean);
}

function showNotice(target, message, isError = false) {
  const node = $(target);
  node.classList.toggle("error", isError);
  node.classList.remove("hidden");
  node.innerHTML = message;
}

function hideNotice(target) {
  $(target).classList.add("hidden");
}

function renderRegistrationAvailability() {
  const registeredId = getBrowserRegistration();
  const form = $("#registerForm");
  const submitButton = $("#registerForm button[type='submit']");
  const fields = [...form.querySelectorAll("input, select")];

  fields.forEach((field) => {
    field.disabled = Boolean(registeredId);
  });
  submitButton.disabled = Boolean(registeredId);

  if (registeredId) {
    showNotice(
      "#registrationResult",
      `このブラウザではすでに登録済みです。匿名ID: <span class="id-chip">${escapeHtml(registeredId)}</span><br>変更する場合は「編集・削除」から更新してください。`
    );
  } else {
    hideNotice("#registrationResult");
  }
}

let toastTimer = null;

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.add("hidden");
  }, 3200);
}

function showCredentialModal({ anonymousId, editKey }) {
  $("#modalAnonymousId").textContent = anonymousId;
  $("#modalEditKey").textContent = editKey;
  $("#credentialModal").classList.remove("hidden");
  $("#closeCredentialModal").focus();
}

function hideCredentialModal() {
  $("#credentialModal").classList.add("hidden");
}

function setupTabs() {
  $$(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      $$(".tab").forEach((item) => item.classList.remove("active"));
      $$(".panel").forEach((panel) => panel.classList.remove("active"));
      tab.classList.add("active");
      $(`#${tab.dataset.tab}`).classList.add("active");
    });
  });
}

function setupRegister() {
  $("#registerForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const registeredId = getBrowserRegistration();
    if (registeredId) {
      showNotice(
        "#registrationResult",
        `このブラウザではすでに登録済みです。匿名ID: <span class="id-chip">${escapeHtml(registeredId)}</span><br>変更する場合は「編集・削除」から更新してください。`,
        true
      );
      return;
    }
    hideNotice("#registrationResult");
    const form = new FormData(formElement);
    try {
      const result = await api("/api/register", {
        method: "POST",
        body: {
          gpa: form.get("gpa"),
          preferences: collectPreferences($("#registerPrefs"))
        }
      });
      formElement.reset();
      setBrowserRegistration(result.anonymousId);
      await loadPublic();
      showNotice("#registrationResult", `
        <strong>登録しました。</strong><br>
        匿名ID: <span class="id-chip">${escapeHtml(result.anonymousId)}</span><br>
        編集キー: <span class="id-chip">${escapeHtml(result.editKey)}</span><br>
        この2つは再表示できません。編集・削除に必要です。
      `);
      showCredentialModal(result);
      showToast("登録を受け付けました。");
    } catch (error) {
      showNotice("#registrationResult", escapeHtml(error.message), true);
    }
  });
}

function setupMine() {
  $("#loginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    state.currentCredentials = {
      anonymousId: String(form.get("anonymousId")).trim().toUpperCase(),
      editKey: String(form.get("editKey"))
    };
    await loadMine();
  });

  $("#editForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const result = await api("/api/mine", {
        method: "PUT",
        body: {
          ...state.currentCredentials,
          gpa: form.get("gpa"),
          preferences: collectPreferences($("#editPrefs"))
        }
      });
      renderMine(result, "更新しました。");
      showToast("編集を受け付けました。");
      await loadPublic();
    } catch (error) {
      showNotice("#mineResult", escapeHtml(error.message), true);
    }
  });

  $("#deleteMine").addEventListener("click", async () => {
    if (!confirm("自分の参加データを削除します。復元はできません。")) return;
    try {
      await api("/api/mine", {
        method: "DELETE",
        body: state.currentCredentials
      });
      clearBrowserRegistration(state.currentCredentials?.anonymousId);
      $("#editForm").classList.add("hidden");
      showNotice("#mineResult", "削除しました。");
      await loadPublic();
    } catch (error) {
      showNotice("#mineResult", escapeHtml(error.message), true);
    }
  });
}

async function loadMine() {
  try {
    const result = await api("/api/mine", {
      method: "POST",
      body: state.currentCredentials
    });
    renderMine(result);
  } catch (error) {
    showNotice("#mineResult", escapeHtml(error.message), true);
  }
}

function renderMine(result, prefix = "") {
  $("#editForm").classList.remove("hidden");
  $("#editForm input[name='gpa']").value = result.gpa;
  renderPreferenceSelectors("#editPrefs", result.preferences);
  const labs = new Map(state.publicData.labs.map((lab) => [lab.id, lab.name]));
  const placements = result.placements
    ? Object.entries(result.placements)
      .map(([model, labId]) => `${model}: ${labId ? labs.get(labId) : "未配属"}`)
      .join("<br>")
    : "投票受付中のため、仮配属結果は締切後に表示されます。";
  showNotice("#mineResult", `${prefix ? `${escapeHtml(prefix)}<br>` : ""}<strong>${escapeHtml(result.anonymousId)}</strong><br>${placements}`);
}

function setupAdmin() {
  $("#adminLoginForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    state.adminPassword = String(new FormData(event.currentTarget).get("password"));
    await loadAdmin();
  });

  $("#addLab").addEventListener("click", () => {
    state.adminState.labs.push({ id: "", name: "", min: 2, max: 5 });
    renderAdminPanel();
  });

  $("#adminSettingsForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await api("/api/admin/settings", {
        method: "PUT",
        body: {
          password: state.adminPassword,
          accepting: $("#adminSettingsForm input[name='accepting']").checked,
          labs: collectLabs()
        }
      });
      showNotice("#adminMessage", "設定を保存しました。");
      await loadAdmin();
      await loadPublic();
    } catch (error) {
      showNotice("#adminMessage", escapeHtml(error.message), true);
    }
  });

  $("#resetForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      await api("/api/admin/reset", {
        method: "POST",
        body: {
          password: state.adminPassword,
          confirm: form.get("confirm")
        }
      });
      formElement.reset();
      showNotice("#adminMessage", "全参加データを破棄しました。");
      await loadAdmin();
      await loadPublic();
    } catch (error) {
      showNotice("#adminMessage", escapeHtml(error.message), true);
    }
  });
}

async function loadAdmin() {
  try {
    state.adminState = await api("/api/admin", {
      method: "POST",
      body: { password: state.adminPassword }
    });
    $("#adminPanel").classList.remove("hidden");
    hideNotice("#adminMessage");
    renderAdminPanel();
  } catch (error) {
    showNotice("#adminMessage", escapeHtml(error.message), true);
  }
}

function renderAdminPanel() {
  const admin = state.adminState;
  $("#adminSummary").innerHTML = [
    metric("参加者数", `${admin.participantCount}人`),
    metric("受付状態", admin.accepting ? "受付中" : "停止中"),
    metric("最終更新", formatDate(admin.updatedAt))
  ].join("");
  $("#adminSettingsForm input[name='accepting']").checked = admin.accepting;
  $("#labsEditor").innerHTML = admin.labs.map((lab, index) => `
    <div class="lab-row">
      <input data-lab-field="name" data-lab-index="${index}" value="${escapeHtml(lab.name)}" placeholder="研究室名">
      <input data-lab-field="min" data-lab-index="${index}" type="number" min="0" value="${lab.min}" aria-label="最低人数">
      <input data-lab-field="max" data-lab-index="${index}" type="number" min="1" value="${lab.max}" aria-label="最大人数">
    </div>
  `).join("");
}

function collectLabs() {
  return $$("#labsEditor .lab-row").map((row, index) => ({
    id: state.adminState.labs[index]?.id || "",
    name: row.querySelector("[data-lab-field='name']").value,
    min: Number(row.querySelector("[data-lab-field='min']").value),
    max: Number(row.querySelector("[data-lab-field='max']").value)
  }));
}

$("#closeCredentialModal").addEventListener("click", hideCredentialModal);
$("#credentialModal").addEventListener("click", (event) => {
  if (event.target.id === "credentialModal") hideCredentialModal();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") hideCredentialModal();
});
$("#refreshResults").addEventListener("click", loadPublic);
setupTabs();
setupRegister();
setupMine();
setupAdmin();
loadPublic().catch((error) => {
  $("#systemStatus").textContent = "読み込み失敗";
  showNotice("#registrationResult", escapeHtml(error.message), true);
});
