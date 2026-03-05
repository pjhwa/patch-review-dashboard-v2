# 🌌 Patch Review Dashboard (v2)

![Project Status](https://img.shields.io/badge/status-Active-brightgreen.svg?style=for-the-badge) 
![Next.js](https://img.shields.io/badge/Next.js-15+-black?style=for-the-badge\u0026logo=next.js\u0026logoColor=white) 
![Prisma](https://img.shields.io/badge/Prisma-ORM-2D3748?style=for-the-badge\u0026logo=prisma\u0026logoColor=white)
![Playwright](https://img.shields.io/badge/Playwright-Scraper-45ba4b?style=for-the-badge\u0026logo=playwright\u0026logoColor=white) 
![Python](https://img.shields.io/badge/Python-Pipeline-3776AB?style=for-the-badge\u0026logo=python\u0026logoColor=white)

Global 벤더들의 보안 패치 데이터를 수집, 지능적으로 분류하고, AI 리뷰를 넘어 담당자 승인까지 체계적으로 관리하는 **End-to-End Modern Dashboard System** 입니다. 
레거시 코드를 탈피하여 Next.js App Router와 다이내믹한 Tailwind UI 컴포넌트로 재탄생했습니다.

---

## ✨ 주요 기능 (Features)

- **자동화된 데이터 파이프라인**: Red Hat, Ubuntu, Oracle OS의 패치 권고문 및 취약점 (Vulnerability) 리포트를 동시 수집
- **지능형 필터링 (Pruning)**: 수많은 데스크톱/비핵심 패키지들을 덜어내고 `kernel`, `glibc`, `shim` 등 인프라 크리티컬한 정보만 선별 정제
- **AI 기반 코드 리뷰**: 단순 요약이 아닌 diff 비교 기반의 변경 영향도 분석 및 한국어 번역 리포팅
- **프리미엄 사용자 경험 (UX)**: Framer Motion 및 shadcn 등 최신 컴포넌트를 베이스로한 관리자 매니징 시스템

---

## 📚 문서 (Documentation)
시스템 아키텍처와 상세 파이프라인 개발 스펙을 `docs/` 폴더에서 확인하실 수 있습니다.

- [🏗️ 시스템 아키텍처](docs/architecture.md)
- [🌊 데이터 파이프라인 흐름도](docs/pipeline_flow.md)
- [🚀 기술 스택](docs/tech_stack.md)

---

## 🛠️ 빠른 시작 (Quick Start)

### 1. Dashboard UI 시작하기
```bash
# 의존성 패키지 설치
npm install

# Prisma 데이터베이스 전개
npx prisma db push

# 로컬 개발 서버 시작 (Turbopack 활성화)
npm run dev
```
웹 브라우저에서 `http://localhost:3001`을 열어주세요.

### 2. 파이프라인 동작 (수동)
```bash
# 관련 패키지 설치
cd pipeline_scripts
npm install playwright

# 1. 벤더별 패치 스크래핑
node batch_collector.js --days 90

# 2. 취약 패치 필터링 및 전처리
python patch_preprocessing.py
```

---

> _이 소프트웨어는 표준 지침(GEMINI.md)에 따라 우아한 UI/UX와 견고하고 자동화된 파이프라인에 집중하여 세심하게 구축되었습니다._
