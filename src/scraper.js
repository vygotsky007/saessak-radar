'use strict';

const { chromium } = require('playwright');

const ORIGIN = 'https://newsac.kosac.re.kr';
// 사람이 보는 목록 페이지 (참고용)
const LIST_URL = `${ORIGIN}/?operationStatusCode=C1101,C1102`;
// JS로 로딩되는 실제 데이터 소스 (JSON API). 목록 페이지가 내부적으로 호출한다.
const API_PATH = '/newsac/api/v1/programs/user';
const DETAIL_BASE = `${ORIGIN}/public/program/thumb`;

// 코드 → 사람이 읽는 값 매핑 (사이트 실제 값 기준)
const STATUS_MAP = {
  C1101: '모집 예정',
  C1102: '모집 중',
  C1103: '모집 완료',
};
const TYPE_MAP = {
  C0101: '방문형',
  C0102: '집합형',
};

function mapItem(item) {
  const status = STATUS_MAP[item.operationStatusCode] || '';
  const type = TYPE_MAP[item.programTypeCode] || '';

  // 권역: "서울·인천권,경기권,..." 복수 표기 → 배열
  const regions = String(item.programRegionName || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // 학교급: 학교급 카운트 필드로 판정 (초/중/고)
  const levels = [];
  if ((item.elementarySchoolCnt || 0) > 0) levels.push('초등학교');
  if ((item.middleSchoolCnt || 0) > 0) levels.push('중학교');
  if ((item.highSchoolCnt || 0) > 0) levels.push('고등학교');

  // 교육대상 태그: "일반형,사회적 배려형(도서벽지)" → 배열
  const tags = String(item.targetName || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const id = item.programId ? 'p_' + item.programId : null;
  const link = item.programId ? `${DETAIL_BASE}/${item.programId}` : LIST_URL;

  return {
    id,
    title: (item.programName || '').trim() || '(제목 미상)',
    status,
    type,
    regions,
    levels,
    tags,
    institution: item.institutionName || '',
    link,
  };
}

/**
 * 페이지 컨텍스트 안에서 API를 페이지네이션하며 전부 수집한다.
 * (브라우저 세션/헤더/오리진을 그대로 물려받으므로 차단 위험이 낮다.)
 */
async function fetchAllInPage(page, apiPath, season) {
  return await page.evaluate(
    async ({ apiPath, season }) => {
      const size = 100;
      let pageNo = 1;
      let all = [];
      let guard = 0;
      while (guard++ < 50) {
        const url =
          apiPath +
          `?operationStatusCode=C1101,C1102&page=${pageNo}&size=${size}&season=${season}`;
        const res = await fetch(url, { headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error('API 응답 오류 status=' + res.status);
        const j = await res.json();
        const content = j.content || [];
        all = all.concat(content);

        const totalCount =
          j.totalCount != null ? j.totalCount : j.totalElements != null ? j.totalElements : null;
        const totalPages =
          j.totalPageCount != null ? j.totalPageCount : j.totalPages != null ? j.totalPages : null;

        if (content.length < size) break;
        if (totalCount != null && all.length >= totalCount) break;
        if (totalPages != null && pageNo >= totalPages) break;
        pageNo++;
      }
      return all;
    },
    { apiPath, season }
  );
}

async function getSeason(page) {
  try {
    const year = await page.evaluate(async () => {
      const r = await fetch('/api/cache/current-season', {
        headers: { Accept: 'application/json' },
      });
      const j = await r.json();
      return j && j.year ? j.year : null;
    });
    return year || String(new Date().getFullYear());
  } catch {
    return String(new Date().getFullYear());
  }
}

/**
 * 메인 진입점. 성공 시 카드 배열 반환.
 * 카드가 0개면 에러를 던져 잘못된 "전부 사라짐" diff 방지.
 */
async function scrape() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      locale: 'ko-KR',
      viewport: { width: 1366, height: 900 },
    });
    const page = await context.newPage();

    console.log('[scraper] 접속:', LIST_URL);
    // 세션/오리진 확보 (SPA 부트스트랩). networkidle까지 대기.
    await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {
      console.log('[scraper] networkidle 타임아웃 — 계속 진행');
    });

    const season = await getSeason(page);
    console.log('[scraper] 시즌:', season);

    const rawItems = await fetchAllInPage(page, API_PATH, season);
    const cards = rawItems
      .map(mapItem)
      .filter((c) => c.id && c.status && c.status !== '모집 완료');
    // (API에 C1101,C1102만 요청하므로 완료는 거의 없지만 방어적으로 제외)

    console.log(
      `[scraper] 프로그램 ${rawItems.length}건 수신 → 유효 카드 ${cards.length}개`
    );

    if (!cards || cards.length === 0) {
      throw new Error('카드를 0개 수집함 (API/렌더링 문제 가능) — diff 스킵');
    }

    return cards;
  } finally {
    await browser.close();
  }
}

module.exports = { scrape, LIST_URL, STATUS_MAP, TYPE_MAP };
