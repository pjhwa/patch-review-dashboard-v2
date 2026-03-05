# 🧠 OpenClaw AI 기반 패치 리뷰 프로세스

이 문서는 `SKILL.md`의 지침에 따라 **Patch Review Board (PRB)** 운영에서 핵심적인 역할을 하는 **OpenClaw (LLM)** 기반의 지능형 패치 영향도 분석 및 자동 검토 프로세스에 대해 자세히 설명합니다.

---

## 🏗️ 전체 워크플로우 개요 (Process Workflow)

OpenClaw AI 리뷰어는 원시 데이터를 수집하고 전처리한 결과를 입력받아, 운영 체제 환경에 미치는 실질적인 심각도(Criticality)를 예측하고 관리자의 결정을 돕는 한국어/영어 요약 및 최종 권고안(Decision)을 도출합니다.

```mermaid
flowchart TD
    A[Data Collection\nbatch_collector.js] --\>|batch_data/| B(Data Preprocessing\npatch_preprocessing.py)
    B --\>|patches_for_llm_review.json| C{OpenClaw AI Review Engine}
    
    C --\>|1. Impact Analysis| D[Critical Impact Check]
    C --\>|2. Version Aggregation| E[Cumulative & Specific Version]
    C --\>|3. Translation| F[Korean/English Summary]
    
    D --\> G
    E --\> G
    F --\> G
    
    G[AI Result JSON Generation\npatch_review_ai_report.json] --\> H[(Dashboard Database)]
```

---

## 🔎 단계별 상세 리뷰 매커니즘

### Step 1. 수집 및 전처리 완료 데이터 로드
*   AI 엔진은 전처리가 끝난 대상 파일 `patches_for_llm_review.json`을 읽어 들입니다. 단순 스크립트 기반 매칭을 뛰어넘어, 패치의 `full_text` (전체 설명)와 `history` (누적 이력)를 언어 모델이 컨텍스트로 직접 파악합니다.

### Step 2. 심층 영향도 분석 (Deep Impact Analysis)
단순 보안 패치 여부를 넘어, 서버의 구동 안정성에 미치는 **"Critical System Impact (시스템 치명적 영향)"** 을 스스로 판단합니다.

**✅ 승인 (Approve) / 포함 대상:**
- **System Hang / Crash**: 커널 패닉, 데드락(Deadlock), 부팅 실패 등.
- **Data Loss / Corruption**: 파일시스템 오류, RAID 손상, 데이터 무결성 훼손.
- **Critical Performance**: 서비스 제공이 불가능할 정도의 심각한 성능 저하.
- **Security (Critical)**: RCE (원격 코드 실행), 권한 탈취(Root escalation), 인증 우회.
- **Failover Failure**: HA 구성(Pacemaker 등) 페일오버 불가 이슈.

**❌ 제외 (Exclude) 대상:**
- 로깅 노이즈, 단순 오타 수정(Typos) 등 안정성에 영향 없는 버그.
- 국지적인 서비스 거부(DoS)나 정보 유출과 같은 "Moderate(보통)" 수준의 취약점.
- LTS(Long Term Support)가 아닌 지원 종료 임박 버전(예: Ubuntu 25.10 등)에만 해당하는 패치.

### Step 3. 누적 버전 집계 및 추출 (Aggregation)
하나의 컴포넌트(예: `kernel`)가 분기 내에 여러 번 업데이트된 경우, 단순 최신 버전이 아닌 **"치명적 수정(Critical fix)이 포함된 최신 버전"** 을 스마트하게 계산합니다.

1. `특정 버전 (specific_version)` 명시: 입력 JSON에 제공된 정확한 목적 패키지 버전을 변형 없이(`Unknown` 또는 `(latest)` 처리 금지) 엄격하게 유지합니다.
2. 설명 병합: 과거의 중요(Critical) 수정 내역과 최신의 중요 수정 내역만을 깔끔하게 병합하여 노이즈를 줄입니다.

### Step 4. 최종 리포트 및 번역 생성 (Report Generation)
최종 판단 결과는 어떠한 Markdown 마크업 없이 순수한 `patch_review_ai_report.json` 배열 포맷으로 출력됩니다. 이때 영어와 한국어에 대해 아주 정제된 형태의 요약을 제시합니다.

- **한국어 설명 (Korean Description) 규칙**: 
  - "보안 업데이트" 같은 무의미한 나열이나 단순 CVE 번호 복사 금지.
  - "무엇이 부서졌고 어떻게 영향을 미치는지"를 직관적으로 전달하는 1~2 문장. 
  - *예시 (Good)*: "메모리 부족 상황에서 데이터 손실을 유발할 수 있는 zswap 경쟁 상태 해결 및 `nilfs_mdt_destroy`의 일반 보호 오류(GPF)로 인한 시스템 크래시 방지."
- **영어 설명 (English Description)**: 한국어 설명에 대한 명확한 상호 호환 합성 요약문.

---

## 💡 AI 예외 처리 및 수동 개입 (Fallbacks)
스크래퍼가 웹사이트 타임아웃(Timeout) 등의 이유로 수집에 실패하여 `collection_failures.json` 에 데이터가 기록된 경우, AI는 이를 감지하거나 관리자에게 다음과 같이 Fallback 액션을 안내합니다:

1. 일시적인 네트워크 오류로 간주해 Collector 재가동
2. 누락된 URL 수동 열람 및 데이터 주입
3. 비핵심 건으로 관리자가 명시적 "제외(Exclude)" 처리
