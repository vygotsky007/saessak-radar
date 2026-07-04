'use strict';

const { chromium } = require('playwright');

const ORIGIN = 'https://newsac.kosac.re.kr';
// 사람이 보는 목록 페이지 (참고용)
const LIST_URL = `${ORIGIN}/?operationStatusCode=C1101,C1102`;
// JS로 로딩되는 실제 데이터 소스 (JSON API). 목록 페이지가 내부적으로 호출한다.
const API_PATH = '/newsac/api/v1/programs/user';
// 프로그램 상세 API (신청기간 시각/차시/신청대상 등). programId 로 조회.
const DETAIL_API = '/newsac/api/v1/programs';
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
// 프로그램 수준/소양 코드 (코드명 API가 막혀 있어 알려진 값만 매핑, 미상은 코드 그대로 보존)
const LEVEL_MAP = {
  C0401: '입문',
  C0402: '기초',
  C0403: '심화',
};
const COMPETENCE_MAP = {
  C0301: 'AI·데이터',
  C0302: '피지컬컴퓨팅',
  C0303: '디지털콘텐츠',
};

function pad2(x) {
  return String(x == null ? '' : x).padStart(2, '0');
}

// 날짜(YYYY-MM-DDT...) + HH + mm → KST ISO 문자열 (시각까지 정확)
function buildAt(dateStr, HH, mm) {
  const ymd = String(dateStr || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  return `${ymd}T${pad2(HH != null ? HH : '00')}:${pad2(mm != null ? mm : '00')}:00+09:00`;
}

// 상세 API 응답 → 표준 detail 객체
function mapDetail(programId, b) {
  const targetNames = (b.target || [])
    .map((t) => t.codeInfo && t.codeInfo.codeName)
    .filter(Boolean);
  const grades = (b.elementarySchool || [])
    .concat(b.middleSchool || [], b.highSchool || [])
    .map((x) => x.codeInfo && x.codeInfo.codeName)
    .filter(Boolean);
  return {
    id: 'p_' + programId,
    programId,
    status: STATUS_MAP[b.operationStatusCode] || '',
    applyStartAt: buildAt(b.applyStartDate, b.applyStartHH, b.applyStartmm),
    applyEndAt: buildAt(b.applyEndDate, b.applyEndHH, b.applyEndmm),
    eduStartAt: buildAt(b.educationStartDate, b.educationStartHH, b.educationStartmm),
    eduEndAt: buildAt(b.educationEndDate, b.educationEndHH, b.educationEndmm),
    totalChapters: b.totalEducationClassChapter != null ? b.totalEducationClassChapter : null, // 총 차시
    capacityClasses: b.courseCnt != null ? b.courseCnt : null, // 정원(모집 학급)
    approvedClasses: b.courseApprovedCount != null ? b.courseApprovedCount : null, // 승인
    pendingClasses: b.coursePendingCount != null ? b.coursePendingCount : null, // 대기
    targetNames, // 신청 대상
    grades,
    levelCode: b.levelCode || '',
    level: LEVEL_MAP[b.levelCode] || b.levelCode || '',
    competenceCode: b.competenceCode || '',
    competence: COMPETENCE_MAP[b.competenceCode] || b.competenceCode || '',
    fetchedAt: new Date().toISOString(),
  };
}

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
    programId: item.programId || null,
    title: (item.programName || '').trim() || '(제목 미상)',
    status,
    type,
    regions,
    levels,
    tags,
    institution: item.institutionName || '',
    link,
    // 모집 학급 수치 (목록 API에 이미 존재 → 매 사이클 최신 유지)
    capacityClasses: item.courseCnt != null ? item.courseCnt : null, // 정원(모집 학급)
    approvedClasses: item.courseApprovedCount != null ? item.courseApprovedCount : null, // 승인
    pendingClasses: item.coursePendingCount != null ? item.coursePendingCount : null, // 대기
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

/**
 * 지정한 programId 들의 상세 정보만 수집한다. (조건 통과분만 넘어오므로 요청량이 작다)
 * 하나의 브라우저 세션에서 SPA 부트스트랩 후 상세 API를 순차 호출한다.
 * @param {number[]} programIds
 * @returns {Object<string, detail>} id('p_<pid>') → detail 맵
 */
async function fetchDetails(programIds) {
  const ids = Array.from(new Set((programIds || []).filter((x) => x != null)));
  if (ids.length === 0) return {};

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
    await page.goto(LIST_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});

    const bodies = await page.evaluate(
      async ({ apiBase, ids }) => {
        const out = {};
        for (const pid of ids) {
          try {
            const r = await fetch(apiBase + '/' + pid, { headers: { Accept: 'application/json' } });
            out[pid] = r.ok ? await r.json() : { __error: 'status ' + r.status };
          } catch (e) {
            out[pid] = { __error: String(e && e.message ? e.message : e) };
          }
        }
        return out;
      },
      { apiBase: DETAIL_API, ids }
    );

    const result = {};
    for (const pid of ids) {
      const b = bodies[pid];
      if (!b || b.__error) {
        console.warn(`[scraper] 상세 수집 실패 pid=${pid}:`, b && b.__error);
        continue;
      }
      const d = mapDetail(pid, b);
      result[d.id] = d;
    }
    console.log(`[scraper] 상세 수집 ${Object.keys(result).length}/${ids.length}건`);
    return result;
  } finally {
    await browser.close();
  }
}

module.exports = {
  scrape,
  fetchDetails,
  mapDetail,
  LIST_URL,
  STATUS_MAP,
  TYPE_MAP,
  LEVEL_MAP,
  COMPETENCE_MAP,
};
