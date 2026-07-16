'use strict';

// ============================================================================
// 교육대상 분류 단일 소스 (2026 개편 반영)
// ----------------------------------------------------------------------------
// newsac.kosac.re.kr 리스트 API 의 targetName 실측값(2026 시즌) 기준:
//   일반형 / 사회적 배려형(도서벽지) / 사회적 배려형(이주배경(구 다문화)) /
//   사회적 배려형(특수교육) / 농어촌 학교 / 교육복지우선지원사업 학교
//
// full  : API 가 실제로 내려주는 정식 라벨(매칭·저장 기준값)
// short : 대시보드/텔레그램 축약 표기 (툴팁으로 full 노출)
// aliases: 구(舊) 라벨·짧은 라벨 등 같은 분류로 취급할 표기들(공백 무시 비교)
// ============================================================================
const CATEGORIES = [
  {
    key: 'general',
    full: '일반형',
    short: '일반형',
    aliases: ['일반형', '일반'],
  },
  {
    key: 'island',
    full: '사회적 배려형(도서벽지)',
    short: '배려형(도서벽지)',
    aliases: ['사회적 배려형(도서벽지)', '도서벽지'],
  },
  {
    key: 'migrant',
    full: '사회적 배려형(이주배경(구 다문화))',
    short: '배려형(이주배경)',
    // 구 명칭 '다문화' 및 중간 표기 전부 이주배경으로 흡수
    aliases: [
      '사회적 배려형(이주배경(구 다문화))',
      '사회적 배려형(이주배경)',
      '사회적 배려형(다문화)',
      '이주배경',
      '다문화',
    ],
  },
  {
    key: 'special',
    full: '사회적 배려형(특수교육)',
    short: '배려형(특수교육)',
    aliases: ['사회적 배려형(특수교육)', '특수교육', '특수'],
  },
  {
    key: 'rural',
    full: '농어촌 학교',
    short: '농어촌',
    aliases: ['농어촌 학교', '농어촌학교', '농어촌'],
  },
  {
    key: 'welfare',
    full: '교육복지우선지원사업 학교',
    short: '교복우',
    aliases: [
      '교육복지우선지원사업 학교',
      '교육복지우선지원사업',
      '교육복지',
      '교복우',
    ],
  },
];

const UNCLASSIFIED = '미분류';

const BY_KEY = {};
for (const c of CATEGORIES) BY_KEY[c.key] = c;

// 공백 제거(라벨 표기 흔들림 흡수)
function stripWs(s) {
  return String(s == null ? '' : s).replace(/\s+/g, '');
}

// 라벨 → 표준 key (모르면 null → '미분류' 취급)
function canonicalKey(label) {
  const k = stripWs(label);
  if (!k) return null;
  for (const c of CATEGORIES) {
    for (const a of c.aliases) {
      if (stripWs(a) === k) return c.key;
    }
  }
  return null;
}

// 라벨 → 정식(full) 라벨. 모르는 라벨은 원문 유지(수집은 하되 미분류로 취급).
function canonicalFull(label) {
  const key = canonicalKey(label);
  return key ? BY_KEY[key].full : String(label == null ? '' : label).trim();
}

// 라벨 → 축약 표기. 모르는 라벨은 원문(트림) 그대로 노출.
function shortOf(label) {
  const key = canonicalKey(label);
  return key ? BY_KEY[key].short : String(label == null ? '' : label).trim();
}

// 알려진 분류인가?
function isKnown(label) {
  return canonicalKey(label) != null;
}

// 배열을 정식 라벨로 정규화 + 중복 제거(순서 보존)
function normalizeList(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr || []) {
    const f = canonicalFull(x);
    if (f && !seen.has(f)) {
      seen.add(f);
      out.push(f);
    }
  }
  return out;
}

module.exports = {
  CATEGORIES,
  UNCLASSIFIED,
  stripWs,
  canonicalKey,
  canonicalFull,
  shortOf,
  isKnown,
  normalizeList,
};
