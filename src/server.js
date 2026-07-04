'use strict';

const express = require('express');
const cron = require('node-cron');
const path = require('path');

// ---- .env 자동 로더 ----
// - .env 파일이 없으면 조용히 스킵 (Railway 등 프로덕션은 호스트가 env를 주입)
// - 이미 설정된 환경변수는 절대 덮어쓰지 않음 (호스트/셸 주입값 우선)
(function loadDotenv() {
  try {
    const fs = require('fs');
    const envPath = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(envPath)) return;
    const raw = fs.readFileSync(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const eq = s.indexOf('=');
      if (eq === -1) continue;
      const key = s.slice(0, eq).trim();
      if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) continue; // 기존값 유지
      let val = s.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1); // 감싼 따옴표 제거
      }
      process.env[key] = val;
    }
  } catch (_) {
    // 로딩 실패는 조용히 무시 — env는 호스트에서 주입될 수 있음
  }
})();

const storage = require('./storage');
const {
  checkOnce,
  checkReminders,
  runtime,
  sendTestAlert,
  fmtKstDateTime,
  ddayKst,
} = require('./watcher');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- cron 스케줄 관리 ----
let currentTask = null;
let currentInterval = null;

function scheduleCron(minutes) {
  if (currentTask) {
    currentTask.stop();
    currentTask = null;
  }
  const m = Math.max(1, parseInt(minutes, 10) || 10);
  currentInterval = m;
  // 매 m분마다 실행
  const expr = m >= 60 ? `0 */${Math.floor(m / 60)} * * *` : `*/${m} * * * *`;
  currentTask = cron.schedule(expr, () => {
    console.log(`[cron] 정기 수집 시작 (${m}분 간격)`);
    checkOnce({ reason: 'cron' }).catch((e) =>
      console.error('[cron] 예외:', e.message)
    );
  });
  console.log(`[cron] 스케줄 등록: ${expr} (${m}분)`);
}

function rescheduleIfChanged() {
  const s = storage.getSettings();
  if (s.intervalMinutes !== currentInterval) {
    console.log(
      `[cron] 간격 변경 감지 ${currentInterval} → ${s.intervalMinutes}분, 재등록`
    );
    scheduleCron(s.intervalMinutes);
  }
}

// ---- 페이지: 대시보드 ----
app.get('/', (req, res) => {
  const s = storage.getSettings();
  const log = storage.getLog();
  const today = new Date().toISOString().slice(0, 10);
  // 테스트(리허설) 알림은 "오늘 보낸 알림" 카운트에서 제외
  const todayCount = log.filter(
    (l) => (l.at || '').slice(0, 10) === today && l.sent && l.kind !== 'test'
  ).length;

  const chips = [];
  for (const v of s.programType) chips.push(v);
  for (const v of s.schoolLevels) chips.push(v);
  for (const v of s.regions) chips.push(v);
  for (const v of s.statuses) chips.push(v);
  for (const v of s.targets) chips.push('#' + v);

  const chipsHtml = chips
    .map((c) => `<span class="chip">${escapeHtml(c)}</span>`)
    .join('');

  const logRows = log
    .slice(0, 20)
    .map((l) => {
      const badge =
        l.kind === 'test'
          ? '<span class="badge badge-test">테스트</span>'
          : l.kind === 'start'
          ? '<span class="badge badge-start">모집 시작</span>'
          : '<span class="badge badge-new">신규</span>';
      const time = fmtTime(l.at);
      const hasLink = !!l.link;
      const gonow = hasLink ? '<span class="gonow">↗ 이동</span>' : '';
      const inner = `${badge}
        <span class="logtitle">${escapeHtml(l.title || '')}</span>
        <span class="logtime">${escapeHtml(time)}</span>
        ${gonow}`;
      // 링크 있는 항목: 줄 전체를 새 탭 링크로. 링크 없는 항목(테스트 등)은 클릭 비활성.
      return hasLink
        ? `<a class="logrow logrow-link" href="${escapeHtml(l.link)}" target="_blank" rel="noopener">${inner}</a>`
        : `<div class="logrow logrow-disabled">${inner}</div>`;
    })
    .join('');

  const lastCheck = runtime.lastCheckAt ? fmtTime(runtime.lastCheckAt) : '아직 없음';
  const okText =
    runtime.lastCheckOk === null
      ? '대기 중'
      : runtime.lastCheckOk
      ? '정상'
      : '실패';
  const okClass =
    runtime.lastCheckOk === false ? 'stat-bad' : 'stat-ok';

  res.send(pageShell('새싹 레이더', `
    <div class="header">
      <div class="logo">🌱 새싹 레이더</div>
      <a class="navlink" href="/settings">⚙️ 감시 조건 설정</a>
    </div>

    ${renderPlanner()}

    <div class="grid">
      <div class="card stat">
        <div class="stat-label">감시 상태</div>
        <div class="stat-num ${okClass}">${okText}</div>
        <div class="stat-sub">마지막 확인: ${escapeHtml(lastCheck)}</div>
        <div class="stat-sub">간격: ${currentInterval || s.intervalMinutes}분</div>
      </div>
      <div class="card stat">
        <div class="stat-label">조건 일치 프로그램</div>
        <div class="stat-num">${runtime.lastMatchCount}</div>
        <div class="stat-sub">전체 수집: ${runtime.totalCards}건</div>
      </div>
      <div class="card stat">
        <div class="stat-label">오늘 보낸 알림</div>
        <div class="stat-num">${todayCount}</div>
        <div class="stat-sub">누적 로그: ${log.length}건</div>
      </div>
    </div>

    <!-- 브라우저 알림 권한 배너 (내용은 클라이언트 permission 상태 기준으로 렌더) -->
    <div id="permBanner"></div>

    <div class="card">
      <div class="card-title">현재 감시 조건</div>
      <div class="chips">${chipsHtml || '<span class="muted">설정 없음</span>'}</div>
    </div>

    <div class="card">
      <div class="row-between">
        <div class="card-title">최근 감지 로그 (20건)</div>
        <button id="checkBtn" class="btn btn-green">지금 즉시 확인</button>
      </div>
      <div id="checkResult" class="muted small"></div>
      <div class="loglist">${logRows || '<div class="muted">아직 감지된 항목이 없습니다.</div>'}</div>
    </div>

    <div class="card">
      <div class="card-title">🔔 알림 리허설</div>
      <div class="muted small" style="margin-bottom:12px;">
        실제 알림 경로(브라우저 알림 + 텔레그램)를 그대로 사용해 테스트 알림 1건을 발송합니다.
        조건 일치 수·오늘 보낸 알림 카운트·감시 스냅샷(state)에는 반영되지 않습니다.
      </div>
      <button id="testBtn" class="btn btn-green">테스트 알림 보내기</button>
    </div>

    ${runtime.lastError ? `<div class="card err">마지막 오류: ${escapeHtml(runtime.lastError)}</div>` : ''}

    <script>
      const btn = document.getElementById('checkBtn');
      const out = document.getElementById('checkResult');
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = '수집 중…';
        out.textContent = '';
        try {
          const r = await fetch('/api/check-now', { method: 'POST' });
          const d = await r.json();
          if (d.ok) {
            out.textContent = '완료: 전체 ' + d.total + '건 / 일치 ' + d.matched + '건 / 알림 ' + d.notified + '건. 새로고침합니다…';
            setTimeout(() => location.reload(), 1200);
          } else {
            out.textContent = '수집 실패: ' + (d.error || '알 수 없음');
            btn.disabled = false;
            btn.textContent = '지금 즉시 확인';
          }
        } catch (e) {
          out.textContent = '요청 오류: ' + e.message;
          btn.disabled = false;
          btn.textContent = '지금 즉시 확인';
        }
      });

      // ---- 브라우저 알림: 클릭 시 상세페이지 새 탭 열기 ----
      // 권한이 granted 일 때만 발송한다. 자동으로 requestPermission 을 호출하지 않는다
      // (사용자 제스처 없는 요청은 크롬이 무시하므로 권한 버튼에서만 요청).
      function showBrowserNotification(opts) {
        if (!('Notification' in window)) return false;
        if (Notification.permission !== 'granted') return false;
        try {
          var n = new Notification(opts.title, { body: opts.body || '', icon: '/favicon.ico' });
          n.onclick = function (e) {
            e.preventDefault();
            if (opts.link) window.open(opts.link, '_blank', 'noopener');
            window.focus();
            n.close();
          };
          return true;
        } catch (_) { return false; }
      }

      // ---- 토스트 ----
      function toast(msg) {
        var t = document.getElementById('toast');
        if (!t) {
          t = document.createElement('div');
          t.id = 'toast';
          t.className = 'toast';
          document.body.appendChild(t);
        }
        t.textContent = msg;
        t.classList.add('show');
        clearTimeout(t._timer);
        t._timer = setTimeout(function () { t.classList.remove('show'); }, 3500);
      }

      // ---- 브라우저 알림 권한 배너 ----
      // permission 상태(granted/default/denied)에 따라 배너를 그린다.
      // requestPermission 은 "브라우저 알림 켜기" 버튼 클릭(사용자 제스처)에서만 호출.
      function renderPermBanner() {
        var el = document.getElementById('permBanner');
        if (!el) return;
        if (!('Notification' in window)) {
          el.innerHTML = '<div class="permbanner perm-denied"><span class="permtext">이 브라우저는 알림을 지원하지 않습니다.</span></div>';
          return;
        }
        var perm = Notification.permission;
        if (perm === 'granted') {
          el.innerHTML = '<span class="permchip">🔔 브라우저 알림 켜짐</span>';
          return;
        }
        if (perm === 'denied') {
          el.innerHTML = '<div class="permbanner perm-denied">' +
            '<span class="permtext">🔕 알림이 차단됨 — 주소창 자물쇠 → 알림 → 허용으로 변경 후 새로고침</span>' +
            '</div>';
          return;
        }
        // default
        el.innerHTML = '<div class="permbanner perm-default">' +
          '<span class="permtext">🔔 브라우저 알림이 꺼져 있어요</span>' +
          '<button id="permBtn" class="btn btn-amber">브라우저 알림 켜기</button>' +
          '</div>';
        var pb = document.getElementById('permBtn');
        if (pb) {
          pb.addEventListener('click', function () {
            // 사용자 제스처 안에서만 권한 요청 → 크롬이 프롬프트를 띄운다
            Notification.requestPermission().then(function (p) {
              renderPermBanner();
              if (p === 'granted') {
                showBrowserNotification({ title: '🌱 새싹 레이더', body: '새싹 레이더 알림이 켜졌습니다' });
                toast('브라우저 알림이 켜졌습니다');
              } else if (p === 'denied') {
                toast('알림이 차단되었습니다 — 주소창 자물쇠에서 변경할 수 있어요');
              }
            });
          });
        }
      }
      renderPermBanner();

      // ---- 알림 리허설 버튼 ----
      var testBtn = document.getElementById('testBtn');
      if (testBtn) {
        testBtn.addEventListener('click', async function () {
          testBtn.disabled = true;
          var orig = testBtn.textContent;
          testBtn.textContent = '발송 중…';
          try {
            var r = await fetch('/api/test-alert', { method: 'POST' });
            var d = await r.json();
            if (d.ok) {
              var c = d.card || {};
              var meta = [c.type, (c.regions || []).join(','), (c.levels || []).join(',')]
                .filter(Boolean).join(' · ');
              var browserOk = showBrowserNotification({
                title: '🔴 [모집 시작] ' + (c.title || ''),
                body: meta,
                link: c.link,
              });
              var tgText = d.telegram === 'sent' ? '텔레그램 O'
                : d.telegram === 'failed' ? '텔레그램 X(실패)'
                : '텔레그램 미설정';
              toast('발송됨: 브라우저 ' + (browserOk ? 'O' : 'X') + ' / ' + tgText);
              setTimeout(function () { location.reload(); }, 1700);
            } else {
              toast('발송 실패: ' + (d.error || '알 수 없음'));
              testBtn.disabled = false;
              testBtn.textContent = orig;
            }
          } catch (e) {
            toast('요청 오류: ' + e.message);
            testBtn.disabled = false;
            testBtn.textContent = orig;
          }
        });
      }
    </script>
  `));
});

// ---- 페이지: 설정 ----
app.get('/settings', (req, res) => {
  const s = storage.getSettings();

  const cb = (group, value, label, checked) => `
    <label class="opt ${checked ? 'on' : ''}">
      <input type="checkbox" name="${group}" value="${escapeHtml(value)}" ${checked ? 'checked' : ''}>
      <span>${escapeHtml(label)}</span>
    </label>`;

  const has = (arr, v) => arr.includes(v);

  res.send(pageShell('감시 조건 설정', `
    <div class="header">
      <div class="logo">🌱 감시 조건 설정</div>
      <a class="navlink" href="/">← 대시보드</a>
    </div>

    <form id="settingsForm">
      <div class="card">
        <div class="card-title">프로그램 유형</div>
        <div class="opts">
          ${cb('programType', '방문형', '방문형', has(s.programType, '방문형'))}
          ${cb('programType', '집합형', '집합형', has(s.programType, '집합형'))}
        </div>
      </div>

      <div class="card">
        <div class="card-title">학교급</div>
        <div class="opts">
          ${cb('schoolLevels', '초등학교', '초등학교', has(s.schoolLevels, '초등학교'))}
          ${cb('schoolLevels', '중학교', '중학교', has(s.schoolLevels, '중학교'))}
          ${cb('schoolLevels', '고등학교', '고등학교', has(s.schoolLevels, '고등학교'))}
        </div>
      </div>

      <div class="card">
        <div class="card-title">운영권역</div>
        <div class="opts">
          ${cb('regions', '서울·인천권', '서울·인천권', has(s.regions, '서울·인천권'))}
          ${cb('regions', '경기권', '경기권', has(s.regions, '경기권'))}
          ${cb('regions', '강원·충청권', '강원·충청권', has(s.regions, '강원·충청권'))}
          ${cb('regions', '경상권', '경상권', has(s.regions, '경상권'))}
          ${cb('regions', '호남·제주권', '호남·제주권', has(s.regions, '호남·제주권'))}
        </div>
      </div>

      <div class="card">
        <div class="card-title">모집상태</div>
        <div class="opts">
          ${cb('statuses', '모집 예정', '모집 예정 (신규 등록 감지)', has(s.statuses, '모집 예정'))}
          ${cb('statuses', '모집 중', '모집 중 (전환 감지)', has(s.statuses, '모집 중'))}
        </div>
      </div>

      <div class="card">
        <div class="card-title">교육대상 <span class="muted small">(OR — 하나라도 있으면 통과)</span></div>
        <div class="opts">
          ${cb('targets', '일반형', '일반형', has(s.targets, '일반형'))}
          ${cb('targets', '사회적 배려형(다문화)', '다문화', has(s.targets, '사회적 배려형(다문화)'))}
          ${cb('targets', '사회적 배려형(도서벽지)', '도서벽지', has(s.targets, '사회적 배려형(도서벽지)'))}
          ${cb('targets', '사회적 배려형(특수교육)', '특수교육', has(s.targets, '사회적 배려형(특수교육)'))}
        </div>
      </div>

      <div class="card">
        <div class="card-title">알림 유형</div>
        <div class="opts">
          <label class="opt ${s.notifyStart ? 'on' : ''}">
            <input type="checkbox" id="notifyStart" ${s.notifyStart ? 'checked' : ''}>
            <span>모집 시작 전환 알림</span>
          </label>
          <label class="opt ${s.notifyNew ? 'on' : ''}">
            <input type="checkbox" id="notifyNew" ${s.notifyNew ? 'checked' : ''}>
            <span>신규 모집예정 등록 알림</span>
          </label>
          <label class="opt ${s.notifyReminder ? 'on' : ''}">
            <input type="checkbox" id="notifyReminder" ${s.notifyReminder ? 'checked' : ''}>
            <span>오픈 리마인더</span>
          </label>
        </div>
        <div class="muted small" style="margin-top:8px;">
          '신규 모집예정 등록 알림'을 꺼도 신청 플래너에는 항상 표시됩니다.
        </div>
      </div>

      <div class="card">
        <div class="card-title">확인 간격</div>
        <div class="interval">
          <input type="number" id="intervalMinutes" name="intervalMinutes" min="1" max="1440" value="${s.intervalMinutes}">
          <span>분마다 확인</span>
        </div>
      </div>

      <div class="actions">
        <button type="submit" class="btn btn-green btn-lg">저장</button>
        <span id="saveMsg" class="muted"></span>
      </div>
    </form>

    <script>
      const form = document.getElementById('settingsForm');
      const msg = document.getElementById('saveMsg');
      // 체크 시각적 토글
      form.addEventListener('change', (e) => {
        if (e.target.type === 'checkbox') {
          e.target.closest('.opt').classList.toggle('on', e.target.checked);
        }
      });
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const groups = ['programType','schoolLevels','regions','statuses','targets'];
        const payload = {};
        for (const g of groups) {
          payload[g] = Array.from(form.querySelectorAll('input[name="'+g+'"]:checked')).map(i => i.value);
        }
        payload.intervalMinutes = parseInt(form.querySelector('#intervalMinutes').value, 10) || 10;
        payload.notifyStart = form.querySelector('#notifyStart').checked;
        payload.notifyNew = form.querySelector('#notifyNew').checked;
        payload.notifyReminder = form.querySelector('#notifyReminder').checked;
        msg.textContent = '저장 중…';
        try {
          const r = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          const d = await r.json();
          if (d.ok) {
            msg.textContent = '저장됨 ✓ 다음 주기부터 적용됩니다.';
          } else {
            msg.textContent = '저장 실패';
          }
        } catch (err) {
          msg.textContent = '오류: ' + err.message;
        }
      });
    </script>
  `));
});

// ---- API ----
app.post('/api/settings', (req, res) => {
  try {
    const saved = storage.saveSettings(req.body || {});
    rescheduleIfChanged();
    res.json({ ok: true, settings: saved });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/check-now', async (req, res) => {
  try {
    const result = await checkOnce({ reason: 'manual' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/test-alert', async (req, res) => {
  try {
    const result = await sendTestAlert();
    res.json(result);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/health', (req, res) => res.send('ok'));

// ---- helpers ----
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
  } catch {
    return iso || '';
  }
}

// ---- 신청 플래너 (대시보드 최상단 카드) ----
function renderPlanner() {
  const state = storage.getState();
  const details = storage.getDetails();
  const ids = Object.keys(state);
  const nowMs = Date.now();

  // 이번 사이클에 관측된 프로그램만 (가장 최근 lastSeen 기준)
  let maxSeen = '';
  for (const id of ids) if ((state[id].lastSeen || '') > maxSeen) maxSeen = state[id].lastSeen;
  const cur = ids
    .filter((id) => maxSeen && (state[id].lastSeen || '') === maxSeen)
    .map((id) => ({ id, ...state[id], detail: details[id] || null }));

  const open = cur.filter((x) => x.status === '모집 예정');
  const live = cur.filter((x) => x.status === '모집 중');

  // 그룹 A: 신청 시작 오름차순, 일시 미확인은 맨 아래
  open.sort((a, b) => {
    const as = a.detail && a.detail.applyStartAt ? Date.parse(a.detail.applyStartAt) : null;
    const bs = b.detail && b.detail.applyStartAt ? Date.parse(b.detail.applyStartAt) : null;
    if (as != null && bs != null) return as - bs;
    if (as != null) return -1;
    if (bs != null) return 1;
    return 0;
  });

  // 그룹 B: 잔여(정원-승인) 많은 순
  const remain = (x) => (x.capacityClasses || 0) - (x.approvedClasses || 0);
  live.sort((a, b) => remain(b) - remain(a));

  const openRows = open
    .map((x) => {
      const start = x.detail && x.detail.applyStartAt;
      const when = start ? fmtKstDateTime(start) : '';
      const dd = start ? ddayKst(start, nowMs) : null;
      const ddChip =
        dd == null
          ? ''
          : dd <= 0
          ? '<span class="dchip dchip-now">D-DAY</span>'
          : `<span class="dchip">D-${dd}</span>`;
      const whenHtml = when
        ? `<span class="plan-when">${escapeHtml(when)}</span> ${ddChip}`
        : '<span class="badge badge-unknown">일시 미공지</span>';
      const chapters =
        x.detail && x.detail.totalChapters != null ? x.detail.totalChapters + '차시' : '';
      const targets =
        x.detail && x.detail.targetNames && x.detail.targetNames.length
          ? x.detail.targetNames.join('·')
          : '';
      const tags = (x.tags || []).map((t) => '#' + t).join(' ');
      const meta = [chapters, targets, tags].filter(Boolean).join(' · ');
      return `<a class="planrow" href="${escapeHtml(x.link || '#')}" target="_blank" rel="noopener">
        <div class="plan-main">
          <div class="plan-title">${escapeHtml(x.title || '')}</div>
          <div class="plan-open">${whenHtml}</div>
          ${meta ? `<div class="plan-meta">${escapeHtml(meta)}</div>` : ''}
        </div>
        <span class="plan-go">상세 ↗</span>
      </a>`;
    })
    .join('');

  const liveRows = live
    .map((x) => {
      const cap = x.capacityClasses || 0;
      const app = x.approvedClasses || 0;
      const rem = cap - app;
      const pct = cap > 0 ? Math.min(100, Math.round((app / cap) * 100)) : 0;
      const remBadge =
        rem <= 0
          ? '<span class="badge badge-full">대기만 가능</span>'
          : `<span class="badge badge-remain">잔여 ${rem}학급</span>`;
      const end = x.detail && x.detail.applyEndAt ? fmtKstDateTime(x.detail.applyEndAt) : '';
      const tags = (x.tags || []).map((t) => '#' + t).join(' ');
      return `<a class="planrow" href="${escapeHtml(x.link || '#')}" target="_blank" rel="noopener">
        <div class="plan-main">
          <div class="plan-title">${escapeHtml(x.title || '')} ${remBadge}</div>
          <div class="gauge"><div class="gauge-fill ${rem <= 0 ? 'gauge-full' : ''}" style="width:${pct}%"></div></div>
          <div class="plan-meta">승인 ${app}/${cap}학급${end ? ' · 마감 ' + escapeHtml(end) : ''}${
        tags ? ' · ' + escapeHtml(tags) : ''
      }</div>
        </div>
        <span class="plan-go">상세 ↗</span>
      </a>`;
    })
    .join('');

  const changeLogs = storage.getLog().filter((l) => l.kind === 'change').slice(0, 5);
  const changeRows = changeLogs
    .map(
      (l) => `<div class="planrow planrow-static">
        <div class="plan-main">
          <div class="plan-title"><span class="badge badge-change">정보 변경</span> ${escapeHtml(l.title || '')}</div>
          <div class="plan-meta">${escapeHtml(l.changes || '')}</div>
        </div>
      </div>`
    )
    .join('');

  return `
    <div class="card planner">
      <div class="card-title">🗂️ 신청 플래너</div>
      <div class="plan-group">
        <div class="plan-group-title">🕐 신청 오픈 예정 <span class="muted small">${open.length}</span></div>
        ${openRows || '<div class="muted small">예정된 프로그램이 없습니다.</div>'}
      </div>
      <div class="plan-group">
        <div class="plan-group-title">🔥 지금 신청 가능 <span class="muted small">${live.length}</span></div>
        ${liveRows || '<div class="muted small">신청 가능한 프로그램이 없습니다.</div>'}
      </div>
      ${
        changeRows
          ? `<div class="plan-group">
        <div class="plan-group-title">🔄 정보 변경 <span class="muted small">${changeLogs.length}</span></div>
        ${changeRows}
      </div>`
          : ''
      }
    </div>`;
}

function pageShell(title, body) {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · 새싹 레이더</title>
<style>
  :root { --green:#22a95f; --green-d:#178a4c; --bg:#f6f9f6; --ink:#1c2a22; --muted:#8a988f; --line:#e6ede8; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Malgun Gothic", sans-serif;
    line-height:1.5; }
  .wrap { max-width: 780px; margin:0 auto; padding: 18px 16px 60px; }
  .header { display:flex; align-items:center; justify-content:space-between; margin: 8px 0 18px; }
  .logo { font-size: 22px; font-weight: 800; letter-spacing:-0.02em; }
  .navlink { color:var(--green-d); text-decoration:none; font-weight:600; font-size:14px;
    background:#fff; padding:8px 12px; border-radius:10px; border:1px solid var(--line); }
  .navlink:hover { background:#f0f7f2; }
  .grid { display:grid; grid-template-columns: repeat(3, 1fr); gap:12px; margin-bottom:14px; }
  .card { background:#fff; border:1px solid var(--line); border-radius:14px; padding:16px 18px; margin-bottom:14px; }
  .card-title { font-weight:700; font-size:15px; margin-bottom:10px; }
  .stat { text-align:left; }
  .stat-label { color:var(--muted); font-size:12px; font-weight:600; }
  .stat-num { font-size:30px; font-weight:800; margin:2px 0 4px; letter-spacing:-0.02em; }
  .stat-sub { color:var(--muted); font-size:12px; }
  .stat-ok { color:var(--green-d); }
  .stat-bad { color:#d9534f; }
  .chips { display:flex; flex-wrap:wrap; gap:7px; }
  .chip { background:#eaf6ef; color:var(--green-d); border:1px solid #d4ecdd;
    padding:5px 11px; border-radius:999px; font-size:13px; font-weight:600; }
  .row-between { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:8px; }
  .loglist { margin-top:6px; }
  .logrow { display:flex; align-items:center; gap:10px; padding:9px 10px; margin:0 -10px;
    border-top:1px solid var(--line); border-radius:9px; }
  .logrow:first-child { border-top:none; }
  .logrow-link { text-decoration:none; color:inherit; transition:background .12s; }
  .logrow-link:hover { background:#eef7f1; }
  .logrow-disabled { cursor:default; opacity:.62; }
  .logtitle { flex:1; font-size:14px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .logtime { color:var(--muted); font-size:12px; white-space:nowrap; }
  .gonow { color:var(--green-d); font-size:12px; font-weight:700; white-space:nowrap;
    opacity:0; transition:opacity .12s; }
  .logrow-link:hover .gonow { opacity:1; }
  .badge { font-size:11px; font-weight:700; padding:3px 8px; border-radius:7px; white-space:nowrap; }
  .badge-start { background:#fdeaea; color:#d9534f; }
  .badge-new { background:#fff6e6; color:#c98a00; }
  .badge-test { background:#f0e9fb; color:#7c3aed; }
  .planner { border-color:#d7ebdf; }
  .plan-group { margin-top:6px; }
  .plan-group + .plan-group { margin-top:16px; border-top:1px dashed var(--line); padding-top:12px; }
  .plan-group-title { font-size:13px; font-weight:800; color:#3a4a41; margin-bottom:8px; }
  .planrow { display:flex; align-items:center; gap:12px; padding:11px 12px; margin:0 -12px;
    border-radius:11px; text-decoration:none; color:inherit; transition:background .12s; }
  .planrow:hover { background:#eef7f1; }
  .planrow-static, .planrow-static:hover { background:transparent; cursor:default; }
  .plan-main { flex:1; min-width:0; }
  .plan-title { font-size:15px; font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .plan-open { margin-top:3px; display:flex; align-items:center; gap:8px; }
  .plan-when { font-size:16px; font-weight:800; letter-spacing:-0.01em; color:var(--ink); }
  .plan-meta { margin-top:3px; color:var(--muted); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .plan-go { color:var(--green-d); font-size:12px; font-weight:700; white-space:nowrap; opacity:.35; transition:opacity .12s; }
  .planrow:hover .plan-go { opacity:1; }
  .dchip { background:#eaf1ff; color:#2a52be; border:1px solid #d3e0fb; padding:2px 9px; border-radius:999px;
    font-size:12px; font-weight:800; white-space:nowrap; }
  .dchip-now { background:#ffecec; color:#d9534f; border-color:#f6cccc; }
  .gauge { margin-top:6px; height:8px; background:#eef2ef; border-radius:999px; overflow:hidden; max-width:280px; }
  .gauge-fill { height:100%; background:var(--green); border-radius:999px; }
  .gauge-fill.gauge-full { background:#d9534f; }
  .badge-change { background:#f0e9fb; color:#7c3aed; }
  .badge-unknown { background:#eef0f2; color:#7a848c; }
  .badge-remain { background:#eaf6ef; color:var(--green-d); }
  .badge-full { background:#fdeaea; color:#d9534f; }
  .permchip { display:inline-flex; align-items:center; gap:6px; background:#eaf6ef; color:var(--green-d);
    border:1px solid #cfe9d8; padding:7px 13px; border-radius:999px; font-size:13px; font-weight:700;
    margin-bottom:14px; }
  .permbanner { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;
    padding:12px 16px; border-radius:12px; margin-bottom:14px; font-size:14px; font-weight:600; }
  .permtext { flex:1; min-width:200px; }
  .perm-default { background:#fff8e6; border:1px solid #f4e3b0; color:#8a6d1a; }
  .perm-denied { background:#fdeaea; border:1px solid #f3caca; color:#a33; }
  .btn-amber { background:#f0ad2e; color:#3a2c05; }
  .btn-amber:hover { background:#e09c1c; }
  .toast { position:fixed; left:50%; bottom:28px; transform:translateX(-50%) translateY(20px);
    background:#1c2a22; color:#fff; padding:12px 18px; border-radius:12px; font-size:14px; font-weight:600;
    box-shadow:0 8px 24px rgba(0,0,0,.18); opacity:0; pointer-events:none; transition:.25s; z-index:50;
    max-width:90vw; text-align:center; }
  .toast.show { opacity:1; transform:translateX(-50%) translateY(0); }
  .btn { border:none; border-radius:10px; padding:10px 16px; font-size:14px; font-weight:700;
    cursor:pointer; }
  .btn-green { background:var(--green); color:#fff; }
  .btn-green:hover { background:var(--green-d); }
  .btn-green:disabled { opacity:.6; cursor:default; }
  .btn-lg { padding:12px 26px; font-size:15px; }
  .opts { display:flex; flex-wrap:wrap; gap:9px; }
  .opt { display:inline-flex; align-items:center; gap:7px; background:#f4f8f5; border:1px solid var(--line);
    padding:9px 13px; border-radius:11px; cursor:pointer; font-size:14px; user-select:none; }
  .opt.on { background:#eaf6ef; border-color:#bfe4cd; color:var(--green-d); font-weight:600; }
  .opt input { accent-color: var(--green); width:16px; height:16px; }
  .interval { display:flex; align-items:center; gap:10px; }
  .interval input { width:90px; padding:9px 12px; border:1px solid var(--line); border-radius:10px; font-size:15px; }
  .actions { display:flex; align-items:center; gap:14px; margin: 6px 0 20px; }
  .muted { color:var(--muted); }
  .small { font-size:12px; }
  .err { background:#fdeaea; color:#a33; border-color:#f3caca; }
  @media (max-width:560px){
    .grid { grid-template-columns: 1fr; }
    .stat-num { font-size:26px; }
  }
</style>
</head>
<body>
  <div class="wrap">${body}</div>
</body>
</html>`;
}

// ---- 시작 ----
app.listen(PORT, () => {
  console.log(`[server] 새싹 레이더 실행 중 → http://localhost:${PORT}`);
  const s = storage.getSettings();
  scheduleCron(s.intervalMinutes);

  // 오픈 리마인더: 1분 간격 경량 체크 (사이트 요청 없음, 스케줄 도달 여부만 판정)
  setInterval(() => {
    checkReminders().catch((e) => console.error('[reminder] 예외:', e.message));
  }, 60000);
  console.log('[server] 오픈 리마인더 스케줄 등록 (1분 간격)');

  // 서버 시작 30초 후 첫 수집
  setTimeout(() => {
    console.log('[server] 첫 수집 시작 (시작 30초 후)');
    checkOnce({ reason: 'startup' }).catch((e) =>
      console.error('[server] 첫 수집 예외:', e.message)
    );
  }, 30000);
});
