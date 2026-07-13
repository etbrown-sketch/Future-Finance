(() => {
  const state = {
    caseStudy: null,
    submissionCount: 0,
    hostPassword: '',
    activeCaseKey: null,
    completedIds: new Set(),
    interactions: []
  };

  const els = {
    studentView: document.getElementById('studentView'),
    hostView: document.getElementById('hostView'),
    viewStatusPill: document.getElementById('viewStatusPill'),
    hostViewButton: document.getElementById('hostViewButton'),
    studentViewButton: document.getElementById('studentViewButton'),
    refreshHostButton: document.getElementById('refreshHostButton'),
    waitingPanel: document.getElementById('waitingPanel'),
    studentWorkspace: document.getElementById('studentWorkspace'),
    studentAlert: document.getElementById('studentAlert'),
    hostAlert: document.getElementById('hostAlert'),
    studentProgressMetric: document.getElementById('studentProgressMetric'),
    caseFileName: document.getElementById('caseFileName'),
    caseFileMeta: document.getElementById('caseFileMeta'),
    downloadCaseButton: document.getElementById('downloadCaseButton'),
    customGptBox: document.getElementById('customGptBox'),
    customGptLink: document.getElementById('customGptLink'),
    progressLabel: document.getElementById('progressLabel'),
    progressPercent: document.getElementById('progressPercent'),
    progressFill: document.getElementById('progressFill'),
    checklistContainer: document.getElementById('checklistContainer'),
    aiForm: document.getElementById('aiForm'),
    aiInput: document.getElementById('aiInput'),
    chatWindow: document.getElementById('chatWindow'),
    submissionForm: document.getElementById('submissionForm'),
    studentName: document.getElementById('studentName'),
    submissionFile: document.getElementById('submissionFile'),
    submissionResult: document.getElementById('submissionResult'),
    hostLoginModal: document.getElementById('hostLoginModal'),
    hostLoginForm: document.getElementById('hostLoginForm'),
    hostPasswordInput: document.getElementById('hostPasswordInput'),
    closeLoginButton: document.getElementById('closeLoginButton'),
    publishForm: document.getElementById('publishForm'),
    clearSubmissions: document.getElementById('clearSubmissions'),
    hostCaseSummary: document.getElementById('hostCaseSummary'),
    submissionsTableWrap: document.getElementById('submissionsTableWrap'),
    exportCsvButton: document.getElementById('exportCsvButton'),
    resetPortalButton: document.getElementById('resetPortalButton')
  };

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (!value) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
    return `${(value / Math.pow(1024, index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
  }

  function formatDate(iso) {
    if (!iso) return 'Not available';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return 'Not available';
    return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  function sessionKey() {
    return state.caseStudy?.publishedAt ? `tffp-student-session:${state.caseStudy.publishedAt}` : null;
  }

  function defaultBossMessage() {
    return {
      role: 'boss',
      text: 'I am your AI Boss for the Turner Finance Futures Program. I can help you find the right source information, explain methods, plan your next step, and debug your reasoning. I will not give final answers, exact values, or complete the workbook for you.',
      timestamp: new Date().toISOString(),
      category: 'welcome'
    };
  }

  function saveStudentSession() {
    const key = sessionKey();
    if (!key) return;
    const payload = {
      studentName: els.studentName.value.trim(),
      completedIds: [...state.completedIds],
      interactions: state.interactions
    };
    localStorage.setItem(key, JSON.stringify(payload));
  }

  function loadStudentSessionForCase() {
    if (!state.caseStudy) {
      state.activeCaseKey = null;
      state.completedIds = new Set();
      state.interactions = [];
      return;
    }

    const key = state.caseStudy.publishedAt;
    if (state.activeCaseKey === key) return;
    state.activeCaseKey = key;
    state.completedIds = new Set();
    state.interactions = [defaultBossMessage()];
    els.studentName.value = '';
    els.submissionResult.classList.add('hidden');
    els.submissionResult.innerHTML = '';

    const stored = localStorage.getItem(sessionKey());
    if (!stored) return;

    try {
      const parsed = JSON.parse(stored);
      els.studentName.value = parsed.studentName || '';
      state.completedIds = new Set(Array.isArray(parsed.completedIds) ? parsed.completedIds : []);
      state.interactions = Array.isArray(parsed.interactions) && parsed.interactions.length
        ? parsed.interactions
        : [defaultBossMessage()];
    } catch {
      state.completedIds = new Set();
      state.interactions = [defaultBossMessage()];
    }
  }

  async function api(path, options = {}) {
    const { body, host = false, headers = {}, ...rest } = options;
    const request = {
      method: rest.method || 'GET',
      headers: { ...headers },
      ...rest
    };

    if (host && state.hostPassword) {
      request.headers['X-Host-Password'] = state.hostPassword;
    }

    if (body instanceof FormData) {
      request.body = body;
    } else if (body !== undefined) {
      request.headers['Content-Type'] = 'application/json';
      request.body = JSON.stringify(body);
    }

    const response = await fetch(path, request);
    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json') ? await response.json() : await response.text();

    if (!response.ok) {
      const message = typeof payload === 'string' ? payload : payload.error || 'Request failed.';
      throw new Error(message);
    }

    return payload;
  }

  function showAlert(element, message, type = 'info') {
    element.className = `alert ${type === 'error' ? 'error' : type === 'success' ? 'success' : ''}`.trim();
    element.textContent = message;
    element.classList.remove('hidden');
  }

  function hideAlert(element) {
    element.classList.add('hidden');
    element.textContent = '';
  }

  function progressStats() {
    const checklist = state.caseStudy?.checklist || [];
    const completed = checklist.filter((item) => state.completedIds.has(item.id)).length;
    const total = checklist.length;
    const percent = total ? Math.round((completed / total) * 100) : 0;
    return { completed, total, percent };
  }

  function renderProgress() {
    const { completed, total, percent } = progressStats();
    els.progressLabel.textContent = `${completed} of ${total} complete`;
    els.progressPercent.textContent = `${percent}%`;
    els.progressFill.style.width = `${percent}%`;
    els.studentProgressMetric.textContent = `${percent}%`;
  }

  function renderChecklist() {
    const checklist = state.caseStudy?.checklist || [];
    if (!checklist.length) {
      els.checklistContainer.innerHTML = '<p class="muted">No checklist items published.</p>';
      renderProgress();
      return;
    }

    els.checklistContainer.innerHTML = checklist.map((item) => {
      const checked = state.completedIds.has(item.id) ? 'checked' : '';
      return `
        <label class="check-item">
          <input type="checkbox" data-check-id="${escapeHtml(item.id)}" ${checked}>
          <span>${escapeHtml(item.text)}</span>
        </label>
      `;
    }).join('');
    renderProgress();
  }

  function renderChat() {
    els.chatWindow.innerHTML = state.interactions.map((entry) => {
      const isStudent = entry.role === 'student';
      const label = isStudent ? 'Student' : 'AI Boss';
      const category = isStudent && entry.category && entry.category !== 'pending'
        ? ` · ${entry.category.replace(/-/g, ' ')}`
        : '';
      return `
        <div class="chat-message ${isStudent ? 'student' : 'boss'}">
          <small>${escapeHtml(label + category)}</small>
          <div>${escapeHtml(entry.text)}</div>
        </div>
      `;
    }).join('');
    els.chatWindow.scrollTop = els.chatWindow.scrollHeight;
  }

  function renderStudent() {
    hideAlert(els.studentAlert);

    if (!state.caseStudy) {
      state.completedIds = new Set();
      state.interactions = [];
      state.activeCaseKey = null;
      els.studentProgressMetric.textContent = '0%';
      els.waitingPanel.classList.remove('hidden');
      els.studentWorkspace.classList.add('hidden');
      return;
    }

    loadStudentSessionForCase();
    els.waitingPanel.classList.add('hidden');
    els.studentWorkspace.classList.remove('hidden');

    els.caseFileName.textContent = state.caseStudy.fileName;
    els.caseFileMeta.textContent = `${formatBytes(state.caseStudy.fileSize)} · Published ${formatDate(state.caseStudy.publishedAt)}`;
    els.downloadCaseButton.href = '/api/case-file';

    if (state.caseStudy.customGptUrl) {
      els.customGptBox.classList.remove('hidden');
      els.customGptLink.href = state.caseStudy.customGptUrl;
    } else {
      els.customGptBox.classList.add('hidden');
      els.customGptLink.removeAttribute('href');
    }

    renderChecklist();
    renderChat();
  }

  function renderHostCase() {
    if (!state.caseStudy) {
      els.hostCaseSummary.innerHTML = `
        <div class="summary-row"><strong>Status:</strong> No case has been published.</div>
        <div class="summary-row"><strong>Student view:</strong> Waiting for host to begin case study.</div>
      `;
      return;
    }

    const checklistPreview = state.caseStudy.checklist.map((item) => `
      <label class="check-item">
        <input type="checkbox" disabled>
        <span>${escapeHtml(item.text)}</span>
      </label>
    `).join('');

    els.hostCaseSummary.innerHTML = `
      <div class="summary-row"><strong>File:</strong> ${escapeHtml(state.caseStudy.fileName)} (${formatBytes(state.caseStudy.fileSize)})</div>
      <div class="summary-row"><strong>Published:</strong> ${formatDate(state.caseStudy.publishedAt)}</div>
      <div class="summary-row"><strong>Checklist items:</strong> ${state.caseStudy.checklist.length}</div>
      <div class="summary-row"><strong>Custom GPT link:</strong> ${state.caseStudy.customGptUrl ? 'Provided' : 'Not provided'}</div>
      <div class="checklist">${checklistPreview}</div>
    `;
  }

  function riskClass(risk) {
    if (risk === 'High') return 'high';
    if (risk === 'Moderate' || risk === 'Unknown') return 'medium';
    return 'low';
  }

  function renderSubmissions(submissions) {
    if (!submissions.length) {
      els.submissionsTableWrap.innerHTML = `
        <section class="empty-state" style="min-height: 14rem; margin-top: 0;">
          <div class="empty-icon">0</div>
          <h3>No submissions yet.</h3>
          <p>Student submissions and AI Boss reports will appear here.</p>
        </section>
      `;
      return;
    }

    const rows = submissions.map((submission) => {
      const report = submission.report || {};
      const stats = report.stats || {};
      return `
        <tr>
          <td><strong>${escapeHtml(submission.studentName)}</strong><br><span>${formatDate(submission.submittedAt)}</span></td>
          <td><span class="rating-pill ${riskClass(report.risk)}">${escapeHtml(report.rating || 'Not rated')}</span><br><small>Risk: ${escapeHtml(report.risk || 'Unknown')}</small></td>
          <td><strong>${Number(stats.progressPercent || 0)}%</strong><br><small>${Number(stats.completedChecklistItems || 0)} of ${Number(stats.totalChecklistItems || 0)}</small></td>
          <td>${Number(stats.answerSeekingPrompts || 0)} / ${Number(stats.totalPrompts || 0)}</td>
          <td>${Number(stats.productiveCoachingPrompts || 0)}</td>
          <td>${escapeHtml(report.pattern || '')}</td>
          <td>${escapeHtml(report.hostFollowUp || '')}</td>
          <td>
            <button class="button ghost" type="button" data-download-submission="${escapeHtml(submission.id)}" data-file-name="${escapeHtml(submission.fileName)}">Download</button>
          </td>
        </tr>
      `;
    }).join('');

    els.submissionsTableWrap.innerHTML = `
      <table class="submissions-table">
        <thead>
          <tr>
            <th>Student</th>
            <th>AI rating</th>
            <th>Checklist</th>
            <th>Answer-seeking prompts</th>
            <th>Productive prompts</th>
            <th>Summary</th>
            <th>Host follow-up</th>
            <th>File</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  async function loadStatus() {
    const data = await api('/api/status');
    state.caseStudy = data.caseStudy;
    state.submissionCount = data.submissionCount || 0;
    renderStudent();
    renderHostCase();
  }

  async function loadHostSubmissions() {
    if (!state.hostPassword) return;
    const data = await api('/api/host/submissions', { host: true });
    renderSubmissions(data.submissions || []);
  }

  function switchToStudent() {
    els.hostView.classList.add('hidden');
    els.studentView.classList.remove('hidden');
    els.hostViewButton.classList.remove('hidden');
    els.viewStatusPill.textContent = 'Student View';
    hideAlert(els.hostAlert);
    loadStatus().catch((error) => showAlert(els.studentAlert, error.message, 'error'));
  }

  async function switchToHost() {
    els.studentView.classList.add('hidden');
    els.hostView.classList.remove('hidden');
    els.hostViewButton.classList.add('hidden');
    els.viewStatusPill.textContent = 'Host View';
    hideAlert(els.studentAlert);
    await loadStatus();
    await loadHostSubmissions();
  }

  function openLoginModal() {
    els.hostLoginModal.classList.remove('hidden');
    els.hostPasswordInput.value = '';
    window.setTimeout(() => els.hostPasswordInput.focus(), 0);
  }

  function closeLoginModal() {
    els.hostLoginModal.classList.add('hidden');
  }

  async function handleHostLogin(event) {
    event.preventDefault();
    const password = els.hostPasswordInput.value;
    const button = els.hostLoginForm.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      await api('/api/host/login', { method: 'POST', body: { password } });
      state.hostPassword = password;
      closeLoginModal();
      await switchToHost();
    } catch (error) {
      showAlert(els.studentAlert, error.message, 'error');
      els.hostPasswordInput.select();
    } finally {
      button.disabled = false;
    }
  }

  async function handlePublish(event) {
    event.preventDefault();
    hideAlert(els.hostAlert);
    const formData = new FormData(els.publishForm);
    formData.append('clearSubmissions', els.clearSubmissions.checked ? 'true' : 'false');
    const button = els.publishForm.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      await api('/api/host/publish', { method: 'POST', body: formData, host: true });
      showAlert(els.hostAlert, 'Case study published. Student view has been updated.', 'success');
      els.publishForm.reset();
      await loadStatus();
      await loadHostSubmissions();
    } catch (error) {
      showAlert(els.hostAlert, error.message, 'error');
    } finally {
      button.disabled = false;
    }
  }

  async function handleAiQuestion(event) {
    event.preventDefault();
    hideAlert(els.studentAlert);
    if (!state.caseStudy) return showAlert(els.studentAlert, 'Waiting for host to begin case study.', 'error');
    const message = els.aiInput.value.trim();
    if (!message) return;

    const button = els.aiForm.querySelector('button[type="submit"]');
    const studentEntry = {
      role: 'student',
      text: message,
      timestamp: new Date().toISOString(),
      category: 'pending'
    };
    state.interactions.push(studentEntry);
    els.aiInput.value = '';
    renderChat();
    saveStudentSession();
    button.disabled = true;

    try {
      const result = await api('/api/ai-boss', {
        method: 'POST',
        body: {
          message,
          completedIds: [...state.completedIds]
        }
      });
      studentEntry.category = result.category;
      state.interactions.push({
        role: 'boss',
        text: result.reply,
        timestamp: new Date().toISOString(),
        category: result.category
      });
    } catch (error) {
      studentEntry.category = 'error';
      state.interactions.push({
        role: 'boss',
        text: `I could not respond because: ${error.message}`,
        timestamp: new Date().toISOString(),
        category: 'error'
      });
    } finally {
      renderChat();
      saveStudentSession();
      button.disabled = false;
      els.aiInput.focus();
    }
  }

  function renderSubmissionResult(submission) {
    const report = submission.report || {};
    const stats = report.stats || {};
    els.submissionResult.innerHTML = `
      <h4>Submission received</h4>
      <p><strong>AI Boss comparison line:</strong> ${escapeHtml(report.shortComparisonLine || '')}</p>
      <p><strong>Interaction pattern:</strong> ${escapeHtml(report.pattern || '')}</p>
      <p><strong>Checklist:</strong> ${Number(stats.progressPercent || 0)}% complete.</p>
      <p>The host can now download your completed file and review the AI Boss report.</p>
    `;
    els.submissionResult.classList.remove('hidden');
  }

  async function handleSubmission(event) {
    event.preventDefault();
    hideAlert(els.studentAlert);
    if (!state.caseStudy) return showAlert(els.studentAlert, 'Waiting for host to begin case study.', 'error');

    const { percent } = progressStats();
    if (percent < 100) {
      const proceed = window.confirm(`Your checklist is ${percent}% complete. Submit anyway?`);
      if (!proceed) return;
    }

    const file = els.submissionFile.files[0];
    if (!file) return showAlert(els.studentAlert, 'Upload your completed case study document.', 'error');

    const formData = new FormData();
    formData.append('studentName', els.studentName.value.trim());
    formData.append('submissionFile', file);
    formData.append('completedIds', JSON.stringify([...state.completedIds]));
    formData.append('interactions', JSON.stringify(state.interactions));

    const button = els.submissionForm.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const data = await api('/api/submissions', { method: 'POST', body: formData });
      renderSubmissionResult(data.submission);
      showAlert(els.studentAlert, 'Submitted successfully. Your AI Boss report was generated for the host.', 'success');
      saveStudentSession();
    } catch (error) {
      showAlert(els.studentAlert, error.message, 'error');
    } finally {
      button.disabled = false;
    }
  }

  function handleChecklistClick(event) {
    const input = event.target.closest('input[data-check-id]');
    if (!input) return;
    const id = input.getAttribute('data-check-id');
    if (input.checked) state.completedIds.add(id);
    else state.completedIds.delete(id);
    renderProgress();
    saveStudentSession();
  }

  function handlePromptChip(event) {
    const button = event.target.closest('button[data-prompt]');
    if (!button) return;
    els.aiInput.value = button.getAttribute('data-prompt');
    els.aiForm.requestSubmit();
  }

  async function downloadSubmission(id, fileName) {
    const response = await fetch(`/api/submission-file/${encodeURIComponent(id)}`, {
      headers: { 'X-Host-Password': state.hostPassword }
    });
    if (!response.ok) throw new Error(await response.text());
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = fileName || 'submission';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);
  }

  async function handleSubmissionTableClick(event) {
    const button = event.target.closest('button[data-download-submission]');
    if (!button) return;
    hideAlert(els.hostAlert);
    button.disabled = true;
    try {
      await downloadSubmission(button.getAttribute('data-download-submission'), button.getAttribute('data-file-name'));
    } catch (error) {
      showAlert(els.hostAlert, error.message, 'error');
    } finally {
      button.disabled = false;
    }
  }

  async function exportCsv() {
    hideAlert(els.hostAlert);
    const response = await fetch('/api/host/export.csv', {
      headers: { 'X-Host-Password': state.hostPassword }
    });
    if (!response.ok) throw new Error(await response.text());
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = 'turner-finance-futures-submissions.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);
  }

  async function resetPortal() {
    hideAlert(els.hostAlert);
    const proceed = window.confirm('Reset all portal data, including the published case and every submission?');
    if (!proceed) return;
    try {
      await api('/api/host/reset', { method: 'POST', body: {}, host: true });
      Object.keys(localStorage).forEach((key) => {
        if (key.startsWith('tffp-student-session:')) localStorage.removeItem(key);
      });
      state.activeCaseKey = null;
      showAlert(els.hostAlert, 'Portal data reset. Student view now shows the waiting message.', 'success');
      await loadStatus();
      renderSubmissions([]);
    } catch (error) {
      showAlert(els.hostAlert, error.message, 'error');
    }
  }

  function bindEvents() {
    els.hostViewButton.addEventListener('click', openLoginModal);
    els.closeLoginButton.addEventListener('click', closeLoginModal);
    els.hostLoginModal.addEventListener('click', (event) => {
      if (event.target === els.hostLoginModal) closeLoginModal();
    });
    els.hostLoginForm.addEventListener('submit', handleHostLogin);
    els.studentViewButton.addEventListener('click', switchToStudent);
    els.refreshHostButton.addEventListener('click', () => switchToHost().catch((error) => showAlert(els.hostAlert, error.message, 'error')));
    els.publishForm.addEventListener('submit', handlePublish);
    els.aiForm.addEventListener('submit', handleAiQuestion);
    document.querySelector('.prompt-chips').addEventListener('click', handlePromptChip);
    els.checklistContainer.addEventListener('change', handleChecklistClick);
    els.submissionForm.addEventListener('submit', handleSubmission);
    els.studentName.addEventListener('input', saveStudentSession);
    els.submissionsTableWrap.addEventListener('click', handleSubmissionTableClick);
    els.exportCsvButton.addEventListener('click', () => exportCsv().catch((error) => showAlert(els.hostAlert, error.message, 'error')));
    els.resetPortalButton.addEventListener('click', resetPortal);
  }

  async function init() {
    bindEvents();
    try {
      await loadStatus();
    } catch (error) {
      showAlert(els.studentAlert, error.message, 'error');
    }
  }

  init();
})();
