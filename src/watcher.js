'use strict';

const storage = require('./storage');
const { scrape } = require('./scraper');

let consecutiveFailures = 0;
let failAlertSent = false;

// 런타임 상태 (대시보드 노출용)
const runtime = {
  lastCheckAt: null,
  lastCheckOk: null,
  lastMatchCount: 0,
  lastError: null,
  totalCards: 0,
};

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---- 감시 조건 판정 ----
function matchesSettings(card, settings) {
  // 모집 완료는 항상 제외
  if (card.status === '모집 완료') return false;

  // 상태 필터
  if (settings.statuses.length && !settings.statuses.includes(card.status)) {
    return false;
  }

  // 프로그램 유형: 카드 값이 체크 목록에 포함
  if (settings.programType.length) {
    if (!card.type || !settings.programType.includes(card.type)) return false;
  }

  // 운영권역: 카드 권역(복수 가능) 중 하나라도 체크 목록에 포함되면 통과
  if (settings.regions.length) {
    const hit = (card.regions || []).some((r) => settings.regions.includes(r));
    if (!hit) return false;
  }

  // 학교급: 카드 학교급(복수 가능) 중 하나라도 체크 목록에 포함되면 통과
  if (settings.schoolLevels.length) {
    const hit = (card.levels || []).some((l) => settings.schoolLevels.includes(l));
    if (!hit) return false;
  }

  // 교육대상 태그: OR. 카드 태그에 체크한 대상 중 하나라도 있으면 통과
  if (settings.targets.length) {
    const cardTags = (card.tags || []).map((t) => t.replace(/\s+/g, ''));
    const hit = settings.targets.some((t) =>
      cardTags.some((ct) => ct.includes(t.replace(/\s+/g, '')))
    );
    if (!hit) return false;
  }

  return true;
}

function isTelegramConfigured() {
  return !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

// ---- 텔레그램 발송 ----
// opts.link 이 있으면 본문 링크는 그대로 두고, 인라인 키보드 버튼("🔗 신청 페이지 열기")을 함께 붙인다.
async function sendTelegram(html, opts = {}) {
  const { link } = opts;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn('[watcher] TELEGRAM_BOT_TOKEN/CHAT_ID 미설정 — 발송 생략');
    console.log('[미발송 메시지]\n' + html.replace(/<[^>]+>/g, ''));
    return false;
  }
  try {
    const payload = {
      chat_id: chatId,
      text: html,
      parse_mode: 'HTML',
      disable_web_page_preview: false,
    };
    if (link) {
      // 버튼 미지원 클라이언트 대비: 본문 링크는 buildMessage 에 그대로 유지된다.
      payload.reply_markup = {
        inline_keyboard: [[{ text: '🔗 신청 페이지 열기', url: link }]],
      };
    }
    const res = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );
    const data = await res.json();
    if (!data.ok) {
      console.error('[watcher] 텔레그램 발송 실패:', data.description);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[watcher] 텔레그램 발송 예외:', err.message);
    return false;
  }
}

function buildMessage(kind, card) {
  // kind: 'start' (모집 시작) | 'new' (새 프로그램)
  const head = kind === 'start' ? '🔴 <b>[모집 시작]</b>' : '🟡 <b>[새 프로그램]</b>';
  const metaParts = [
    card.type,
    (card.regions || []).join(','),
    (card.levels || []).join(','),
    (card.tags || []).map((t) => '#' + t).join(' '),
  ].filter((x) => x && x.length);

  return (
    `${head}\n` +
    `<b>${escapeHtml(card.title)}</b>\n` +
    `${escapeHtml(metaParts.join(' · '))}\n` +
    `${escapeHtml(card.link)}`
  );
}

// ---- 1회 수집 + diff + 알림 ----
async function checkOnce({ reason } = {}) {
  const settings = storage.getSettings();
  runtime.lastCheckAt = new Date().toISOString();

  let cards;
  try {
    cards = await scrape();
    consecutiveFailures = 0;
    failAlertSent = false;
    runtime.lastCheckOk = true;
    runtime.lastError = null;
    runtime.totalCards = cards.length;
  } catch (err) {
    consecutiveFailures += 1;
    runtime.lastCheckOk = false;
    runtime.lastError = err.message;
    console.error(
      `[watcher] 수집 실패 (${consecutiveFailures}회 연속):`,
      err.message
    );
    // 3회 연속 실패 시 1회만 텔레그램 경보
    if (consecutiveFailures >= 3 && !failAlertSent) {
      await sendTelegram('⚠️ <b>새싹 레이더 수집 실패 중</b>\n연속 3회 이상 수집에 실패했습니다.');
      failAlertSent = true;
    }
    return { ok: false, error: err.message };
  }

  const state = storage.getState();
  const now = new Date().toISOString();
  const notifications = [];

  // 조건 통과 카드만 관심 대상
  const matched = cards.filter((c) => matchesSettings(c, settings));
  runtime.lastMatchCount = matched.length;

  for (const card of matched) {
    const prev = state[card.id];

    if (!prev) {
      // 신규
      if (card.status === '모집 예정') {
        notifications.push({ kind: 'new', card });
      } else if (card.status === '모집 중') {
        notifications.push({ kind: 'start', card });
      }
    } else if (prev.status === '모집 예정' && card.status === '모집 중') {
      // 전환 (가장 중요)
      notifications.push({ kind: 'start', card });
    }
    // 같은 id+상태로는 중복 알림 없음 (아래 스냅샷 갱신으로 보장)
  }

  // 알림 발송 + 로그 기록
  for (const n of notifications) {
    const html = buildMessage(n.kind, n.card);
    const sent = await sendTelegram(html, { link: n.card.link });
    const logEntry = {
      at: now,
      kind: n.kind, // 'start' | 'new'
      title: n.card.title,
      status: n.card.status,
      link: n.card.link,
      sent,
    };
    storage.appendLog(logEntry);
    console.log(
      `[watcher] 알림(${n.kind}): ${n.card.title} [${n.card.status}] sent=${sent}`
    );
  }

  // 스냅샷 갱신: 조건 통과한 카드만 상태 추적 (전환 감지용)
  const nextState = { ...state };
  for (const card of matched) {
    const prev = nextState[card.id];
    nextState[card.id] = {
      title: card.title,
      status: card.status,
      firstSeen: prev ? prev.firstSeen : now,
      lastSeen: now,
    };
  }
  storage.saveState(nextState);

  return {
    ok: true,
    total: cards.length,
    matched: matched.length,
    notified: notifications.length,
  };
}

// ---- 알림 리허설 (테스트 알림) ----
// 가짜 프로그램 1건을 실제 발송 함수(buildMessage + sendTelegram)에 그대로 태운다.
// - 텔레그램 설정 시 인라인 버튼까지 실제와 동일하게 발송
// - 로그에는 kind:'test' 로 기록 (대시보드에서 "오늘 보낸 알림" 카운트·조건 일치 수에서 제외)
// - state.json(감시 스냅샷)에는 절대 반영하지 않는다 → 실제 전환 감지에 영향 없음
async function sendTestAlert() {
  const card = {
    id: 'test',
    title: '[테스트] 새싹 레이더 알림 점검',
    status: '모집 중',
    type: '방문형',
    regions: ['서울·인천권'],
    levels: ['초등학교'],
    tags: ['일반형'], // buildMessage 가 '#' 를 붙여 #일반형 으로 렌더
    link: 'https://newsac.kosac.re.kr/',
  };

  const tgConfigured = isTelegramConfigured();
  const html = buildMessage('start', card);
  const sent = await sendTelegram(html, { link: card.link });
  const telegram = !tgConfigured ? 'unset' : sent ? 'sent' : 'failed';

  storage.appendLog({
    at: new Date().toISOString(),
    kind: 'test',
    title: card.title,
    status: card.status,
    link: card.link,
    sent,
  });
  console.log(`[watcher] 테스트 알림 발송 telegram=${telegram}`);

  return { ok: true, telegram, card };
}

module.exports = {
  checkOnce,
  matchesSettings,
  runtime,
  sendTelegram,
  sendTestAlert,
  isTelegramConfigured,
};
