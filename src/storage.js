'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || './data';
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json');
const STATE_PATH = path.join(DATA_DIR, 'state.json');
const LOG_PATH = path.join(DATA_DIR, 'log.json');
const DETAILS_PATH = path.join(DATA_DIR, 'details.json'); // 프로그램 상세 캐시
const META_PATH = path.join(DATA_DIR, 'meta.json'); // 마지막 전체 갱신일 등
const REMINDERS_PATH = path.join(DATA_DIR, 'reminders.json'); // 오픈 리마인더 발송 이력

const DEFAULT_SETTINGS = {
  programType: ['방문형'],
  regions: ['서울·인천권'],
  schoolLevels: ['초등학교'],
  statuses: ['모집 예정', '모집 중'],
  targets: ['일반형', '사회적 배려형(이주배경(구 다문화))'],
  intervalMinutes: 10,
  // 알림 유형 토글
  notifyStart: true, // 모집 시작 전환 알림
  notifyNew: false, // 신규 모집예정 등록 알림 (플래너 반영은 항상)
  notifyReminder: true, // 오픈 리마인더
};

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[storage] ${file} 읽기 실패, 기본값 사용:`, err.message);
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDir();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// ---- settings ----
function getSettings() {
  const s = readJson(SETTINGS_PATH, null);
  if (!s) {
    writeJson(SETTINGS_PATH, DEFAULT_SETTINGS);
    return { ...DEFAULT_SETTINGS };
  }
  // 누락 필드는 기본값으로 보정
  return { ...DEFAULT_SETTINGS, ...s };
}

function saveSettings(partial) {
  const current = getSettings();
  const next = { ...current, ...partial };
  // 정규화
  next.intervalMinutes = Math.max(1, parseInt(next.intervalMinutes, 10) || 10);
  for (const key of ['programType', 'regions', 'schoolLevels', 'statuses', 'targets']) {
    if (!Array.isArray(next[key])) next[key] = [];
  }
  for (const key of ['notifyStart', 'notifyNew', 'notifyReminder']) {
    next[key] = !!next[key];
  }
  writeJson(SETTINGS_PATH, next);
  return next;
}

// ---- state (프로그램 스냅샷) ----
function getState() {
  return readJson(STATE_PATH, {});
}

function saveState(state) {
  writeJson(STATE_PATH, state);
}

// ---- 감지 로그 (최근 200건 링버퍼) ----
function getLog() {
  return readJson(LOG_PATH, []);
}

function appendLog(entry) {
  const log = getLog();
  log.unshift(entry);
  const trimmed = log.slice(0, 200);
  writeJson(LOG_PATH, trimmed);
  return trimmed;
}

// ---- 상세 캐시 (details.json) ----
function getDetails() {
  return readJson(DETAILS_PATH, {});
}
function saveDetails(map) {
  writeJson(DETAILS_PATH, map);
}

// ---- 메타 (meta.json: 마지막 전체 갱신일 등) ----
function getMeta() {
  return readJson(META_PATH, {});
}
function saveMeta(meta) {
  writeJson(META_PATH, meta);
}

// ---- 오픈 리마인더 발송 이력 (reminders.json) ----
// 키: `${id}:${kind}` (kind: 'pre_day' | 'pre_10min') → { at, applyStartAt }
function getReminders() {
  return readJson(REMINDERS_PATH, {});
}
function saveReminders(map) {
  writeJson(REMINDERS_PATH, map);
}

module.exports = {
  DATA_DIR,
  DEFAULT_SETTINGS,
  getSettings,
  saveSettings,
  getState,
  saveState,
  getLog,
  appendLog,
  getDetails,
  saveDetails,
  getMeta,
  saveMeta,
  getReminders,
  saveReminders,
};
