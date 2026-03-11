# 📚 LEARNED.md — Patch Review Dashboard v2

> **이 파일은 매 작업 세션 시작 전 반드시 읽고 숙지해야 합니다.**
> 같은 실수를 두 번 반복하면 안 됩니다.

---

## 2026-03-11 — 문서 작성 시 코드를 반드시 확인할 것

### 🔴 실패 사례: oracle_collector.sh 출력 경로 오류

**상황**: `architecture.md` 문서에 `oracle_collector.sh`의 출력 경로를 `oracle/raw_html/`로 잘못 기재.

**실제 코드 확인 결과**:
- `oracle_collector.sh`는 **HTML을 스크래핑하지 않는다**.
- `yum.oracle.com`에서 `repomd.xml` → `updateinfo.xml.gz`를 `curl`로 다운로드.
- `oracle_parser.py`가 gzip XML을 파싱하여 `oracle_data/{advisory_id}.json`에 저장.
- "raw_html" 디렉토리는 존재조차 하지 않는다.

**교훈**:
> ❌ **추측으로 문서를 작성하는 것은 절대 금지.**
> ✅ **스크립트의 출력 경로, 입력 형식, 동작 방식은 반드시 `cat`으로 코드를 직접 읽은 후에 기술한다.**
> 특히 파일 경로, URL, 데이터 형식 등 구체적인 기술 사항은 100% 코드 기반이어야 한다.

---

## 2026-03-11 — 수집기별 실제 동작 방식 (코드 기반 확인)

### ✅ redhat/rhsa_collector.js
- API: `https://security.access.redhat.com/data/csaf/v2/advisories/changes.csv` (Incremental)
- `metadata.json`으로 `max_timestamp` 추적 → 신규 Advisory만 Fetch
- 동시 요청: max 6개 (`MAX_CONCURRENCY = 6`)
- 출력: `redhat_data/{advisory_id}.json`

### ✅ oracle/oracle_collector.sh + oracle_parser.py
- 대상: Oracle Linux **7, 8, 9, 10** 각 버전의 BaseOS / UEK / AppStream 리포지토리
- `yum.oracle.com/repo/OracleLinux/OL{ver}/...`에서 `repomd.xml` → `updateinfo.xml.gz` curl 다운로드
- `oracle_parser.py`: gzip 해제 → ElementTree XML 파싱 → 날짜 필터(90일, OL7 UEKR6은 180일)
- 출력: `oracle_data/{advisory_id}.json`
- Advisory URL 자동 생성: `https://linux.oracle.com/errata/{advisory_id}.html`

### ✅ ubuntu/ubuntu_collector.sh
- `canonical/ubuntu-security-notices` git repo에서 `--depth 1` clone
- `osv/usn/USN-*.json` 순회 → **Ubuntu 22.04 LTS + 24.04 LTS** 만 `jq` 필터
- 90일 이내 published 항목만 처리
- 출력: `ubuntu_data/{usn_id}.json`
- Advisory URL 자동 생성: `https://ubuntu.com/security/notices/{usn_id}`
- **주의**: 최초 배포 시 `ubuntu-security-notices` 디렉토리에서 `git clone` 별도 실행 필요

---

## 2026-03-11 — AI 리뷰 데이터 무결성 패턴 (queue.ts)

### 🔴 실패 사례: AI 환각(Hallucination) 및 벤더 누락

**문제**: SKILL.md Step 3의 "Critical System Impact" 필터로 인해 AI가 RedHat/Oracle 대부분을 제외하고 Ubuntu만 출력. 또한 AI가 PreprocessedPatch에 없는 IssueID를 생성(환각).

**해결 패턴**:
```typescript
// 1. AI 결과 인서트 전 PreprocessedPatch 맵 구성
const preprocessedMap = new Map<string, PreprocessedPatch>();
allPreprocessed.forEach(pp => preprocessedMap.set(pp.issueId, pp));

// 2. AI 환각 방지: PreprocessedPatch에 없는 IssueID 스킵
if (!preprocessedMap.has(issueId)) {
    await job.log(`[SKIP] AI hallucinated issueId not in preprocessed: ${issueId}`);
    continue;
}

// 3. url/releaseDate/osVersion을 PreprocessedPatch에서 복사
const meta = preprocessedMap.get(issueId);
// meta.url, meta.releaseDate, meta.osVersion 을 ReviewedPatch에 저장

// 4. Passthrough: AI가 누락한 항목을 PreprocessedPatch에서 직접 채움
const aiIssuedIds = new Set(data.map(d => d.IssueID));
const missed = allPreprocessed.filter(pp => !aiIssuedIds.has(pp.issueId));
// missed 항목을 ReviewedPatch에 upsert (criticality: Important, decision: Pending)
```

**교훈**:
> AI는 언제나 환각(없는 IssueID 생성)이나 선택적 필터링을 할 수 있다.
> DB 인서트 전 반드시 PreprocessedPatch 기반 검증 + Passthrough 패턴을 적용한다.

---

## 2026-03-11 — OpenClaw Session Lock 방어

### 🔴 실패 사례: `session file locked (timeout 10000ms)`

**원인**: 이전 OpenClaw 실행이 비정상 종료되면서 `.lock` 파일이 남아 새 실행을 차단.

**해결책**:
```typescript
// OpenClaw 실행 전 stale .lock 파일 자동 제거
const sessionsDir = `${homeDir}/.openclaw/agents/main/sessions`;
const lockFiles = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.lock'));
for (const lf of lockFiles) {
    fs.unlinkSync(path.join(sessionsDir, lf));
    await job.log(`[CLEANUP] Removed stale lock: ${lf}`);
}
```

---

## 2026-03-11 — 데이터 수집 분리 아키텍처 원칙

**원칙**: 데이터 수집(`CRON`)과 AI 리뷰(`Dashboard`)는 반드시 별도로 실행되어야 한다.

- 수집: `run_collectors_cron.sh` → Linux cron (분기별)
- AI 리뷰: Dashboard "파이프라인 실행" 버튼 → BullMQ 큐 → `queue.ts` 워커
- **수집기를 파이프라인 워커(`queue.ts`)에서 직접 호출하는 것은 금지**
  - 이유: 수집에 몇 시간이 걸릴 수 있고, 대시보드 SSE 연결이 끊길 수 있음
  - 이유: 수집 실패 시 AI 리뷰 전체가 실패하는 단일 장애점이 됨

---

## 2026-03-11 — 파이프라인 BullMQ "waiting" 고착 방지

**원인**: `job.updateProgress()`와 `job.log()`를 스크립트 실행 **후**에 호출하면, 스크립트 실행 중에는 Job이 `waiting` 상태로 보임.

**해결**:
```typescript
// 반드시 스크립트 실행 전에 progress 업데이트
await job.updateProgress(10);
await job.log('Starting patch_preprocessing.py...');

// 그 후 스크립트 실행
await runScript('python3 patch_preprocessing.py');

await job.log('[PREPROCESS_DONE] count=N');
await job.updateProgress(50);
```

---

## 2026-03-11 — GitHub 문서 작성 원칙

1. **코드 우선**: 파일 경로, URL, 동작 방식은 반드시 `cat`/`ssh` 로 실제 코드를 확인 후 기술
2. **추측 금지**: "아마도 ~일 것이다", "~로 추정됨" 표현 금지. 확인 안 된 내용은 기술 금지
3. **검증 절차**: 각 스크립트의 출력 디렉토리는 `mkdir -p` 라인 또는 `open(filename, 'w')` 코드를 직접 확인
4. **Mermaid 다이어그램**: 실제 데이터 흐름만 표현. 존재하지 않는 중간 파일/디렉토리 기재 금지

---

## 2026-03-03 ~ 2026-03-10 — 이전 세션 교훈 요약

### 수집 카운트 리셋 문제
- **실패**: 브라우저 새로고침 시 수집 카운트가 0으로 리셋됨
- **원인**: `RawPatch` DB 조회 방식 — DB는 파이프라인 실행 시 초기화됨
- **해결**: `redhat_data/`, `oracle_data/`, `ubuntu_data/` 디렉토리의 JSON 파일 수를 OS 파일 시스템에서 직접 카운트

### PM2 반복 재시작 문제
- **원인**: 서버 루트에 남아있던 `/home/citec/package-lock.json` 이 Next.js 워크스페이스 루트를 잘못 인식하게 만들어 빌드 실패
- **해결**: 해당 파일 삭제 후 클린 빌드

### PowerShell에서 `&&` 사용 불가
- Windows PowerShell에서는 `cmd1 && cmd2` 문법이 동작하지 않음
- **해결**: 두 명령을 별도 run_command로 분리 실행
